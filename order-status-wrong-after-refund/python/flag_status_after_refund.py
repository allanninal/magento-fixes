"""Flag Magento 2 orders whose status disagrees with their refund totals.

Magento derives order state and status largely from totals such as
total_refunded and total_paid, via Order::getIsInProcess(), Order::setState(),
and the creditmemo save observers, rather than recomputing status from a
single authoritative rule each time a credit memo posts. A zero-total credit
memo (store-credit-only refunds), a shipping-only refund, or a partial refund
on a bundle/configurable item can make the totals comparison come out wrong,
leaving a fully refunded order on Processing or Complete, or forcing an
order to Closed after only a partial refund.

There is no safe REST write for order.status alone, so this reports by
default. The only optional write is a status history comment, and only when
DRY_RUN is false. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_status_after_refund")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def expected_order_status(order_totals, credit_memos, current_status):
    total_invoiced = order_totals.get("totalInvoiced", 0) or 0
    total_paid = order_totals.get("totalPaid", 0) or 0
    total_refunded = order_totals.get("totalRefunded", 0) or 0

    if total_invoiced <= 0:
        return {"expected": current_status, "isMismatch": False}

    is_fully_refunded = total_refunded >= total_paid - EPSILON
    has_zero_total_memo = any(cm.get("grandTotal") == 0 for cm in credit_memos)
    if credit_memos and has_zero_total_memo and total_refunded >= total_paid - EPSILON:
        is_fully_refunded = True

    if is_fully_refunded:
        expected = "closed"
    elif 0 < total_refunded < total_paid - EPSILON:
        expected = "processing" if current_status == "closed" else current_status
    else:
        expected = current_status

    return {"expected": expected, "isMismatch": expected != current_status}


def candidate_orders(page_size=200):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "processing,complete",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/orders", params)["items"]


def creditmemos_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/creditmemo", params)["items"]


def add_status_history_comment(order_id, comment):
    payload = {
        "entity": {
            "entity_id": order_id,
            "status_histories": [
                {"comment": comment, "is_customer_notified": 0, "is_visible_on_front": 0}
            ],
        }
    }
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/orders/{order_id}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    for order in candidate_orders():
        order_id = order.get("entity_id")
        current_status = order.get("status")
        memos = creditmemos_for_order(order_id)

        credit_memos = [{"grandTotal": m.get("grand_total"), "state": m.get("state")} for m in memos]
        order_totals = {
            "totalInvoiced": order.get("total_invoiced"),
            "totalPaid": order.get("total_paid"),
            "totalRefunded": order.get("total_refunded"),
        }

        result = expected_order_status(order_totals, credit_memos, current_status)
        if not result["isMismatch"]:
            continue

        comment = (
            f"Flagged: total_refunded={order_totals['totalRefunded']} "
            f"total_paid={order_totals['totalPaid']} status={current_status} "
            f"expected={result['expected']}"
        )
        log.warning(
            "Order %s (id=%s) status mismatch: current=%s expected=%s total_refunded=%s total_paid=%s. %s",
            order.get("increment_id"), order_id, current_status, result["expected"],
            order_totals["totalRefunded"], order_totals["totalPaid"],
            "would add status history comment" if DRY_RUN else "adding status history comment",
        )
        if not DRY_RUN:
            add_status_history_comment(order_id, comment)
        flagged += 1

    log.info("Done. %d order(s) flagged with a status mismatch after refund.", flagged)


if __name__ == "__main__":
    run()
