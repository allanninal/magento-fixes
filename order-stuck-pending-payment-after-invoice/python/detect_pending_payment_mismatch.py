"""Detect Magento 2 orders stuck on pending payment after their invoice is paid, safely.

Order state and invoice state are two separate write paths. When a payment
gateway webhook, a custom payment module, or an out of process API call
creates or updates an invoice and marks it paid without also calling
order.setState(processing).setStatus(...) and saving the order, the invoice
and total_paid reflect the successful payment while order.state and status
stay on new or pending_payment. This reports every mismatch by default and
only gates a real state change behind DRY_RUN=false plus a human confirming
the gateway capture. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/order-stuck-pending-payment-after-invoice/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_pending_payment_mismatch")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PENDING_STATES = ("new", "pending_payment")
STATE_PAID = 2


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_put_order_state(entity_id, state, status):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/orders",
        json={"entity": {"entity_id": entity_id, "state": state, "status": status}},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def candidate_orders(page_size=100):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "pending,pending_payment",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[pageSize]": page_size,
    }
    return magento_get("/orders", params)["items"]


def invoices_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/invoices", params)["items"]


def detect_pending_payment_mismatch(order, invoices):
    """Pure decision function. Takes plain data, returns plain data.

    order: {entityId, incrementId, state, status, grandTotal, totalPaid, totalInvoiced}
    invoices: list of {entityId, orderId, state, grandTotal}
    """
    matched = [inv for inv in invoices if inv["orderId"] == order["entityId"]]
    paid_invoice = next((inv for inv in matched if inv["state"] == STATE_PAID), None)

    paid_by_amount = (
        order["totalPaid"] >= order["grandTotal"]
        or order["totalInvoiced"] >= order["grandTotal"]
    )

    if order["state"] in PENDING_STATES and (paid_invoice or paid_by_amount):
        if paid_invoice:
            reason = f"matched invoice {paid_invoice['entityId']} is state 2 (paid)"
        else:
            reason = "total_paid or total_invoiced already meets grand_total"
        return {
            "isMismatched": True,
            "reason": reason,
            "matchedInvoiceId": paid_invoice["entityId"] if paid_invoice else None,
        }

    return {"isMismatched": False, "reason": None, "matchedInvoiceId": None}


def to_plain_order(raw):
    return {
        "entityId": str(raw["entity_id"]),
        "incrementId": raw.get("increment_id", ""),
        "state": raw.get("state", ""),
        "status": raw.get("status", ""),
        "grandTotal": float(raw.get("grand_total") or 0),
        "totalPaid": float(raw.get("total_paid") or 0),
        "totalInvoiced": float(raw.get("total_invoiced") or 0),
    }


def to_plain_invoices(raw_items, order_entity_id):
    return [
        {
            "entityId": str(item["entity_id"]),
            "orderId": order_entity_id,
            "state": item.get("state"),
            "grandTotal": float(item.get("grand_total") or 0),
        }
        for item in raw_items
    ]


def run():
    flagged = 0
    for raw_order in candidate_orders():
        order = to_plain_order(raw_order)
        raw_invoices = invoices_for_order(order["entityId"])
        invoices = to_plain_invoices(raw_invoices, order["entityId"])

        result = detect_pending_payment_mismatch(order, invoices)
        if not result["isMismatched"]:
            continue

        flagged += 1
        log.warning(
            "Order %s (id=%s) state=%s status=%s total_paid=%s grand_total=%s matched_invoice=%s. %s",
            order["incrementId"], order["entityId"], order["state"], order["status"],
            order["totalPaid"], order["grandTotal"], result["matchedInvoiceId"],
            result["reason"],
        )

        if not DRY_RUN:
            log.warning(
                "DRY_RUN is false: writing order %s to state=processing, status=processing "
                "(confirm the gateway capture before enabling this).",
                order["incrementId"],
            )
            magento_put_order_state(order["entityId"], "processing", "processing")

    log.info("Done. %d order(s) flagged.", flagged)


if __name__ == "__main__":
    run()
