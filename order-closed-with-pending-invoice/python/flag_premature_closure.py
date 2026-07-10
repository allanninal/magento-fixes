"""Flag Magento 2 orders closed prematurely while an invoice is still Pending.

Magento's Sales/Model/ResourceModel/Order/Handler/State::check() runs on every
order save, including the save triggered by creating a shipment. It closes an
order once it is not canceled, cannot be put on hold, canInvoice() is false,
and canShip() is false, meaning every item is fully shipped. It never checks
whether an existing invoice is still open (state = 1, "Pending"). An invoice
created Not Capture, followed by a full shipment, closes the order even though
total_due is still greater than zero.

There is no safe REST write for order.state or order.status, so this reports
by default. The only allowed write is on the invoice itself, capture or void,
and only when DRY_RUN is false and a human has confirmed real payment status.
Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_premature_closure")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

INVOICE_STATE_OPEN = 1  # Magento's STATE_OPEN, shown as "Pending" in the admin


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def classify_premature_closure(order, invoices, has_shipment):
    """Pure decision function. No I/O.

    order: {status, total_paid, total_due, grand_total}
    invoices: list of {state, order_id}
    has_shipment: bool
    """
    if order.get("status") != "closed":
        return {"isPrematureClosure": False, "reason": "order not closed"}

    if not has_shipment:
        return {"isPrematureClosure": False, "reason": "no shipment on record"}

    has_open_invoice = any(inv.get("state") == INVOICE_STATE_OPEN for inv in invoices)

    total_due = order.get("total_due", 0) or 0
    total_paid = order.get("total_paid", 0) or 0
    grand_total = order.get("grand_total", 0) or 0
    still_owes = total_due > 0.0001 or total_paid < (grand_total - 0.0001)

    if has_open_invoice and still_owes:
        return {
            "isPrematureClosure": True,
            "reason": "order closed with an unpaid (state=1/Pending) invoice and outstanding total_due",
        }

    return {"isPrematureClosure": False, "reason": "invoice fully paid or no outstanding balance"}


def closed_orders(page_size=200):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "closed",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/orders", params)["items"]


def invoices_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/invoices", params)["items"]


def shipments_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/shipment", params)["items"]


def capture_invoice(invoice_id):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/invoices/{invoice_id}/capture",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def void_invoice(invoice_id):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/invoices/{invoice_id}/void",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    for order in closed_orders():
        order_id = order.get("entity_id")
        invoices = invoices_for_order(order_id)
        shipments = shipments_for_order(order_id)
        result = classify_premature_closure(order, invoices, bool(shipments))

        if not result["isPrematureClosure"]:
            continue

        open_invoice = next((inv for inv in invoices if inv.get("state") == INVOICE_STATE_OPEN), None)
        log.warning(
            "Order %s (id=%s) closed prematurely: invoice_id=%s invoice_state=%s total_due=%s. %s",
            order.get("increment_id"), order_id,
            open_invoice.get("entity_id") if open_invoice else None,
            open_invoice.get("state") if open_invoice else None,
            order.get("total_due"),
            "reporting only, human must confirm payment before capture/void" if DRY_RUN else "reporting only (no auto write to the order)",
        )
        flagged += 1

    log.info("Done. %d order(s) flagged as closed with a pending invoice.", flagged)


if __name__ == "__main__":
    run()
