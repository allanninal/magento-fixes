"""Find and report Magento 2 reserved order ids that created a permanent numbering gap.

Magento reserves an order increment_id on the quote, through reserved_order_id
backed by the sales_sequence tables, the moment checkout begins, before payment
succeeds or the order actually saves. If checkout is abandoned, the gateway
declines, or the order-place transaction rolls back, that reserved id is never
attached to a real order and the sequence never reuses it. This never rewrites
the sequence or reissues a number. It pages inactive quotes carrying a reserved
order id, confirms against the Orders API that no order ever claimed it,
classifies each with a pure function, always reports orphaned gaps, and only
when DRY_RUN is explicitly false marks the originating quote inactive so it is
excluded from future scans. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/reserved-order-id-numbering-gaps/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_reserved_order_ids")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://demo.example.com").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "token_dummy")
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


def magento_put(path, payload):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def candidate_quotes(page_size=200):
    current_page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "reserved_order_id",
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "notnull",
            "searchCriteria[filterGroups][1][filters][0][field]": "is_active",
            "searchCriteria[filterGroups][1][filters][0][value]": 0,
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": current_page,
        }
        data = magento_get("/carts/search", params)
        for item in data["items"]:
            yield item
        if current_page * page_size >= data["total_count"]:
            return
        current_page += 1


def normalize_quote(item):
    return {
        "cartId": item.get("id"),
        "reservedOrderId": item.get("reserved_order_id"),
        "isActive": bool(item.get("is_active")),
        "updatedAt": item.get("updated_at"),
        "customerEmail": (item.get("customer") or {}).get("email"),
    }


def orders_matching_increment_id(increment_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "increment_id",
        "searchCriteria[filterGroups][0][filters][0][value]": increment_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    data = magento_get("/orders", params)
    return [{"incrementId": item["increment_id"]} for item in data["items"]]


def classify_reserved_order_gap(quote, matching_orders):
    """Pure decision logic, no I/O.

    quote: {reservedOrderId, isActive, updatedAt}
    matching_orders: list of {incrementId}
    returns: {status: "consumed" | "orphaned_gap" | "pending_checkout", reservedOrderId}
    """
    if any(o["incrementId"] == quote["reservedOrderId"] for o in matching_orders):
        status = "consumed"
    elif quote["isActive"]:
        status = "pending_checkout"
    else:
        status = "orphaned_gap"
    return {"status": status, "reservedOrderId": quote["reservedOrderId"]}


def mark_quote_reviewed(cart_id):
    payload = {"quote": {"id": cart_id, "is_active": False}}
    return magento_put(f"/carts/{cart_id}", payload)


def run():
    gaps = []
    scanned = 0
    for raw in candidate_quotes(PAGE_SIZE):
        quote = normalize_quote(raw)
        if not quote["reservedOrderId"]:
            continue
        scanned += 1
        matching_orders = orders_matching_increment_id(quote["reservedOrderId"])
        result = classify_reserved_order_gap(quote, matching_orders)
        if result["status"] == "orphaned_gap":
            gaps.append(quote)

    if not gaps:
        log.info("Done. Scanned %d quote(s). 0 orphaned reserved id gap(s) found.", scanned)
        return

    for quote in gaps:
        log.warning(
            "reserved_order_id %s orphaned. cart_id=%s customer=%s updated_at=%s",
            quote["reservedOrderId"], quote["cartId"], quote["customerEmail"], quote["updatedAt"],
        )
        if not DRY_RUN:
            mark_quote_reviewed(quote["cartId"])

    log.info(
        "Done. Scanned %d quote(s). %d orphaned reserved id gap(s) %s.",
        scanned, len(gaps), "to mark reviewed" if DRY_RUN else "marked reviewed",
    )


if __name__ == "__main__":
    run()
