"""Flag Magento 2 order sequence drift after a data migration or DB restore.

Magento 2 numbers orders from dedicated sequence_order_<store> tables, tracked
via sales_sequence_meta and sales_sequence_profile, completely separate from
the sales_order table's own entity_id auto increment column. A migration from
Magento 1, or a manual DB import or restore, commonly copies sales_order rows
without correctly re-seeding the sequence table's last issued value, so the
next order minted from it can collide with an existing increment_id or skip a
huge range. There is no REST endpoint to rewrite sequence state, so this only
reports the drift and the recommended AUTO_INCREMENT reset value. Run on a
schedule. Safe to run again and again.
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_sequence_drift")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
GAP_THRESHOLD = int(os.environ.get("GAP_THRESHOLD", "1000"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "200"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def orders_sorted_by_increment(page_size=200, current_page=1):
    params = {
        "searchCriteria[sortOrders][0][field]": "increment_id",
        "searchCriteria[sortOrders][0][direction]": "ASC",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/orders", params)["items"]


def all_orders_sorted_by_increment(page_size=200):
    page = 1
    while True:
        items = orders_sorted_by_increment(page_size, page)
        if not items:
            return
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def normalize_order(item):
    return {
        "entityId": item.get("entity_id"),
        "storeId": item.get("store_id"),
        "incrementId": item.get("increment_id"),
        "createdAt": item.get("created_at"),
    }


def strip_prefix(increment_id, prefix):
    value = increment_id[len(prefix):] if prefix and increment_id.startswith(prefix) else increment_id
    return int(value.lstrip("0") or "0")


def detect_sequence_drift(orders, prefix_by_store, gap_threshold=1000):
    """Pure decision function. No DB/HTTP calls, fully testable on synthetic
    order arrays.

    orders: list of {entityId, storeId, incrementId, createdAt}
    prefix_by_store: {storeId: prefix} used to strip a known prefix/suffix
        from incrementId before parsing it as a number.

    Returns {duplicates, gaps, maxNumericByStore}:
      - duplicates: same numeric value, more than one distinct entityId
      - gaps: consecutive numeric deltas beyond gap_threshold
      - maxNumericByStore: per-store max numeric value, the recommended
        next AUTO_INCREMENT seed is max + 1
    """
    by_store = {}
    for o in orders:
        by_store.setdefault(o["storeId"], []).append(o)

    duplicates = []
    gaps = []
    max_numeric_by_store = {}

    for store_id, store_orders in by_store.items():
        prefix = prefix_by_store.get(store_id, "")
        rows = sorted(
            (
                {
                    "entityId": o["entityId"],
                    "numeric": strip_prefix(o["incrementId"], prefix),
                    "incrementId": o["incrementId"],
                }
                for o in store_orders
            ),
            key=lambda r: r["numeric"],
        )

        seen = {}
        for r in rows:
            seen.setdefault(r["numeric"], []).append(r["entityId"])
        for numeric, entity_ids in seen.items():
            distinct = sorted(set(entity_ids))
            if len(distinct) > 1:
                duplicates.append({
                    "storeId": store_id,
                    "incrementId": next(r["incrementId"] for r in rows if r["numeric"] == numeric),
                    "entityIds": distinct,
                })

        for prev, curr in zip(rows, rows[1:]):
            gap_size = curr["numeric"] - prev["numeric"]
            if gap_size > gap_threshold:
                gaps.append({
                    "storeId": store_id,
                    "fromIncrement": prev["numeric"],
                    "toIncrement": curr["numeric"],
                    "gapSize": gap_size,
                })

        max_numeric_by_store[store_id] = max((r["numeric"] for r in rows), default=0)

    return {
        "duplicates": duplicates,
        "gaps": gaps,
        "maxNumericByStore": max_numeric_by_store,
    }


def run():
    raw_orders = list(all_orders_sorted_by_increment(PAGE_SIZE))
    orders = [normalize_order(item) for item in raw_orders]

    # No REST field exposes a store's increment_id prefix, so an empty prefix
    # is assumed unless overridden per store via PREFIX_BY_STORE, e.g. "1:ORD-,2:EU-".
    prefix_by_store = {}
    for pair in os.environ.get("PREFIX_BY_STORE", "").split(","):
        if ":" in pair:
            store_id, prefix = pair.split(":", 1)
            prefix_by_store[int(store_id.strip())] = prefix.strip()

    result = detect_sequence_drift(orders, prefix_by_store, GAP_THRESHOLD)

    for d in result["duplicates"]:
        log.warning(
            "Store %s: increment_id %s is duplicated across entity_id %s.",
            d["storeId"], d["incrementId"], d["entityIds"],
        )
    for g in result["gaps"]:
        log.warning(
            "Store %s: gap of %s between increment %s and %s.",
            g["storeId"], g["gapSize"], g["fromIncrement"], g["toIncrement"],
        )

    affected_stores = {d["storeId"] for d in result["duplicates"]} | {g["storeId"] for g in result["gaps"]}
    if affected_stores:
        for store_id in sorted(affected_stores, key=str):
            reset_value = result["maxNumericByStore"].get(store_id, 0) + 1
            log.error(
                "Store %s sequence drift detected. Recommended repair: "
                "ALTER TABLE sequence_order_%s AUTO_INCREMENT = %d (run by a DBA, not this script).",
                store_id, store_id, reset_value,
            )
        log.error("%d store(s) affected. Exiting non-zero. No sequence table was written.", len(affected_stores))
        sys.exit(1)
    else:
        log.info("Done. No sequence drift found across %d order(s).", len(orders))


if __name__ == "__main__":
    run()
