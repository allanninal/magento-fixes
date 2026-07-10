"""Detect Magento 2 or Adobe Commerce orders where a manually created partial
invoice dropped its share of tax, leaving a false amount due.

When an admin manually invoices an order in more than one pass, for example
invoicing simple products separately from a virtual product via Sales,
Orders, Invoice, Magento's Sales\\Model\\Order\\Invoice\\Total collectors for
Tax, Subtotal, and Grand Total prorate tax across invoices by each item's
invoiced quantity ratio. A documented core bug, magento2 issue 38978,
reproduced on 2.4.3-p3, causes the tax portion belonging to items on a later
invoice to be dropped instead of allocated. That invoice's base_tax_amount
and base_grand_total come out short by exactly the missing item's tax.
Because Magento only derives total_paid by summing each invoice's own
already wrong grand_total, the order ends up with a total_due that should
not exist.

This script never edits, voids, or cancels an invoice, since Magento has no
supported REST write for that. It compares the order's own base_grand_total
and base_tax_amount against what its invoices actually total, writes a
report row for every order it flags, and exits non-zero so CI or alerting
notices. A human reconciles the order in the Admin, for example with a
credit memo without invoice or by cancelling and reissuing the affected
invoice. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/manual-invoice-missing-tax/
"""
import os
import csv
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_invoice_tax_shortfall")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
ORDER_IDS = [o.strip() for o in os.environ.get("ORDER_IDS", "").split(",") if o.strip()]
AMOUNT_EPSILON = float(os.environ.get("AMOUNT_EPSILON", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "invoice_tax_shortfalls.csv")
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))


def get_token():
    if ADMIN_TOKEN:
        return ADMIN_TOKEN
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/integration/admin/token",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_order(token, order_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/orders/{order_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_invoices_for_order(token, order_id, page_size=PAGE_SIZE):
    invoices = []
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
            "searchCriteria[filterGroups][0][filters][0][value]": order_id,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/invoices",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        items = body.get("items", [])
        invoices.extend(items)
        if len(items) < page_size:
            return invoices
        page += 1


def detect_invoice_tax_shortfall(order, invoices, epsilon=AMOUNT_EPSILON):
    """Pure decision function. order and invoices are plain numeric structs
    (see order_to_struct / invoice_to_struct), so this needs no network and
    is easy to unit test with fixtures mirroring the #38978 scenario.
    """
    invoiced_grand_total = sum(inv.get("baseGrandTotal", 0) or 0 for inv in invoices)
    invoiced_tax = sum(inv.get("baseTaxAmount", 0) or 0 for inv in invoices)
    grand_total_delta = order["baseGrandTotal"] - invoiced_grand_total
    tax_delta = order["baseTaxAmount"] - invoiced_tax
    is_shortfall = (
        order["totalDue"] > epsilon
        and tax_delta > epsilon
        and grand_total_delta > epsilon
    )
    return {
        "isShortfall": is_shortfall,
        "invoicedGrandTotal": invoiced_grand_total,
        "invoicedTax": invoiced_tax,
        "taxDelta": tax_delta,
        "grandTotalDelta": grand_total_delta,
    }


def order_to_struct(order):
    return {
        "baseGrandTotal": order.get("base_grand_total", 0) or 0,
        "baseTaxAmount": order.get("base_tax_amount", 0) or 0,
        "totalDue": order.get("total_due", 0) or 0,
    }


def invoice_to_struct(invoice):
    return {
        "baseGrandTotal": invoice.get("base_grand_total", 0) or 0,
        "baseTaxAmount": invoice.get("base_tax_amount", 0) or 0,
    }


def build_report_row(order, invoices, result):
    return {
        "order_id": order.get("entity_id"),
        "increment_id": order.get("increment_id"),
        "expected_tax": round(order.get("base_tax_amount", 0) or 0, 4),
        "invoiced_tax": round(result["invoicedTax"], 4),
        "delta": round(result["taxDelta"], 4),
        "invoice_ids": ";".join(str(inv.get("entity_id")) for inv in invoices),
    }


def run():
    token = get_token()
    flagged = []

    for order_id in ORDER_IDS:
        order = get_order(token, order_id)
        invoices = get_invoices_for_order(token, order_id)

        result = detect_invoice_tax_shortfall(
            order_to_struct(order),
            [invoice_to_struct(inv) for inv in invoices],
        )

        if not result["isShortfall"]:
            continue

        row = build_report_row(order, invoices, result)
        flagged.append(row)
        log.warning(
            "Order %s missing invoice tax: expected_tax=%s invoiced_tax=%s delta=%s invoice_ids=%s",
            row["increment_id"], row["expected_tax"], row["invoiced_tax"], row["delta"], row["invoice_ids"],
        )

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "order_id", "increment_id", "expected_tax", "invoiced_tax", "delta", "invoice_ids",
            ])
            writer.writeheader()
            writer.writerows(flagged)
        log.info("Wrote report to %s%s", OUTPUT_CSV, "" if not DRY_RUN else " (dry run, report only)")

    log.info("Done. %d order(s) flagged with a missing invoice tax shortfall.", len(flagged))
    return flagged


if __name__ == "__main__":
    flagged_orders = run()
    sys.exit(1 if flagged_orders else 0)
