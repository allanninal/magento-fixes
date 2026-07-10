"""Flag Magento 2 sales_order_grid rows that fell out of sync with sales_order.

With asynchronous grid indexing (dev/grid/async_indexing=1), orders are written
to sales_order immediately but only copied into sales_order_grid by a scheduled
cron job bounded by a cached watermark on updated_at. A documented race
(magento/magento2 issue #40803) lets a cron run advance that watermark past an
order whose grid row write was still in flight or failed, permanently skipping
it. sales_order_grid has no REST endpoint and there is no public API to force a
single order's grid row rebuild, so this only reports the drift. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/sales-order-grid-out-of-sync/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_grid_sync_drift")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
SYNC_SINCE = os.environ.get("SYNC_SINCE", "2026-01-01 00:00:00")
WATERMARK = os.environ.get("WATERMARK", "2026-01-01 00:00:00")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
NUDGE_ALLOWLIST = {
    s.strip() for s in os.environ.get("NUDGE_ALLOWLIST", "").split(",") if s.strip()
}


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_put(path, payload):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def entity_orders_since(since, page_size=200, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[filterGroups][0][filters][0][value]": since,
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/orders", params)["items"]


def grid_view_for_id(entity_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "entity_id",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[filterGroups][0][filters][0][value]": entity_id,
    }
    items = magento_get("/orders", params)["items"]
    return items[0] if items else None


def normalize_order(item):
    return {
        "entityId": item.get("entity_id"),
        "incrementId": item.get("increment_id"),
        "status": item.get("status"),
        "updatedAt": item.get("updated_at"),
        "grandTotal": item.get("grand_total"),
    }


def classify_order_sync(entity_row, grid_row, watermark):
    """Pure decision logic. entity_row and grid_row are plain dicts (or grid_row is None).

    entity_row / grid_row shape: {entityId, incrementId, status, grandTotal, updatedAt}
    watermark: str, comparable ISO-ish timestamp string.

    Returns {entityId, driftType, action} where driftType is one of
    OK, MISSING_FROM_GRID, STALE_STATUS, STALE_TOTAL and action is NONE or FLAG_REINDEX.
    """
    entity_id = entity_row["entityId"]

    if grid_row is None:
        if entity_row["updatedAt"] <= watermark:
            return {"entityId": entity_id, "driftType": "MISSING_FROM_GRID", "action": "FLAG_REINDEX"}
        return {"entityId": entity_id, "driftType": "OK", "action": "NONE"}

    if grid_row["status"] != entity_row["status"]:
        return {"entityId": entity_id, "driftType": "STALE_STATUS", "action": "FLAG_REINDEX"}

    if grid_row["grandTotal"] != entity_row["grandTotal"]:
        return {"entityId": entity_id, "driftType": "STALE_TOTAL", "action": "FLAG_REINDEX"}

    return {"entityId": entity_id, "driftType": "OK", "action": "NONE"}


def nudge_order(entity_id):
    """No-op comment PUT that bumps updated_at so async cron can re-pick the row."""
    payload = {
        "statusHistory": {
            "comment": "Reconciler: no-op comment to refresh updated_at for grid re-sync.",
            "isCustomerNotified": False,
            "isVisibleOnFront": False,
        }
    }
    return magento_put(f"/orders/{entity_id}/comments", payload)


def run():
    raw_entities = entity_orders_since(SYNC_SINCE)
    entities = [normalize_order(item) for item in raw_entities]

    drifted = []
    for entity_row in entities:
        raw_grid = grid_view_for_id(entity_row["entityId"])
        grid_row = normalize_order(raw_grid) if raw_grid else None
        result = classify_order_sync(entity_row, grid_row, WATERMARK)
        if result["action"] == "FLAG_REINDEX":
            drifted.append({**result, "incrementId": entity_row["incrementId"], "lastKnownGood": entity_row})

    for d in drifted:
        log.warning(
            "Order %s (id %s) drifted: %s.",
            d["incrementId"], d["entityId"], d["driftType"],
        )

    if drifted:
        ids = ",".join(str(d["entityId"]) for d in drifted)
        log.error(
            "%d order(s) out of sync with sales_order_grid. Run: "
            "bin/magento indexer:reindex sales_order_grid  (affected ids: %s)",
            len(drifted), ids,
        )
    else:
        log.info("Done. No drift found between sales_order and sales_order_grid.")

    if not DRY_RUN and NUDGE_ALLOWLIST:
        for d in drifted:
            if str(d["entityId"]) in NUDGE_ALLOWLIST:
                log.warning("Nudging order %s to bump updated_at for re-sync.", d["entityId"])
                nudge_order(d["entityId"])


if __name__ == "__main__":
    run()
