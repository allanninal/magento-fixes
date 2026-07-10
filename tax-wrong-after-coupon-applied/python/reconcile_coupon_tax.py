"""Flag Magento 2 or Adobe Commerce orders whose tax was recalculated
incorrectly after a coupon was applied.

Magento builds order totals through a chain of total collector models:
Subtotal, then Discount, then Tax, then Grand Total. Whether that chain
reconciles depends on Sales, Tax, Calculation Settings for Apply Customer Tax
(Before Discount or After Discount) and Apply Discount on Prices (Excluding
Tax or Including Tax). When those settings disagree with how catalog prices
are entered, or a cart price rule coupon meets tax inclusive catalog prices,
the discount collector reduces the row total using one base while the tax
collector recomputes tax_amount from the pre discount unit price, so
discount_tax_compensation_amount ends up wrong or zero and base_row_total
minus base_discount_amount plus base_tax_amount no longer equals
base_grand_total. This is a recurring defect class, seen across magento2
GitHub issues 8964, 19494, 29506, and 26597, and Adobe Commerce shipped
Quality Patch ACSD-61200 for discount tax compensation specifically.

This script never edits an order, since Magento has no supported REST write
for a placed order's totals. It recomputes the expected tax and grand total
from the order's own item data and writes a reconciliation report. Safe to
run again and again.

Guide: https://www.allanninal.dev/magento/tax-wrong-after-coupon-applied/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_coupon_tax")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
TAX_EPSILON = float(os.environ.get("TAX_EPSILON", "0.01"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "coupon_tax_mismatches.csv")


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


def get_orders_with_coupon(token, page_size=PAGE_SIZE, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "notnull",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/orders",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def to_reconcile_input(order):
    items = []
    for it in order.get("items", []):
        items.append({
            "baseRowTotal": it.get("base_row_total", 0) or 0,
            "baseDiscountAmount": it.get("base_discount_amount", 0) or 0,
            "baseDiscountTaxCompensationAmount": it.get("base_discount_tax_compensation_amount", 0) or 0,
            "taxPercent": it.get("tax_percent", 0) or 0,
            "baseTaxAmount": it.get("base_tax_amount", 0) or 0,
        })
    return {
        "baseSubtotal": order.get("base_subtotal", 0) or 0,
        "baseDiscountAmount": order.get("base_discount_amount", 0) or 0,
        "baseTaxAmount": order.get("base_tax_amount", 0) or 0,
        "baseShippingAmount": order.get("base_shipping_amount", 0) or 0,
        "baseShippingTaxAmount": order.get("base_shipping_tax_amount", 0) or 0,
        "baseShippingDiscountAmount": order.get("base_shipping_discount_amount", 0) or 0,
        "baseGrandTotal": order.get("base_grand_total", 0) or 0,
        "items": items,
    }


def round2(value):
    return round(value + 1e-9, 2)


def reconcile_order_tax(order, epsilon=TAX_EPSILON):
    """Pure function. Input order has baseSubtotal, baseDiscountAmount,
    baseTaxAmount, baseShippingAmount, baseShippingTaxAmount,
    baseShippingDiscountAmount, baseGrandTotal, and items, an array of
    objects with baseRowTotal, baseDiscountAmount,
    baseDiscountTaxCompensationAmount, taxPercent. No network or database
    calls, plain numbers in, booleans and numbers out.
    """
    per_item_deltas = []
    expected_tax = 0.0
    for item in order.get("items", []):
        taxable_base = (
            item.get("baseRowTotal", 0)
            - item.get("baseDiscountAmount", 0)
            + item.get("baseDiscountTaxCompensationAmount", 0)
        )
        expected_item_tax = round2(taxable_base * item.get("taxPercent", 0) / 100)
        delta = round2(item.get("baseTaxAmount", 0) - expected_item_tax) if "baseTaxAmount" in item else None
        per_item_deltas.append({
            "taxableBase": round2(taxable_base),
            "expectedItemTax": expected_item_tax,
            "delta": delta,
        })
        expected_tax += expected_item_tax
    expected_tax = round2(expected_tax)

    expected_grand_total = round2(
        order.get("baseSubtotal", 0)
        - order.get("baseDiscountAmount", 0)
        + expected_tax
        + order.get("baseShippingAmount", 0)
        + order.get("baseShippingTaxAmount", 0)
        - order.get("baseShippingDiscountAmount", 0)
    )

    tax_delta = round2(order.get("baseTaxAmount", 0) - expected_tax)
    grand_total_delta = round2(order.get("baseGrandTotal", 0) - expected_grand_total)

    ok = abs(tax_delta) <= epsilon and abs(grand_total_delta) <= epsilon
    for d in per_item_deltas:
        if d["delta"] is not None and abs(d["delta"]) > epsilon:
            ok = False

    return {
        "ok": ok,
        "expectedTax": expected_tax,
        "expectedGrandTotal": expected_grand_total,
        "taxDelta": tax_delta,
        "grandTotalDelta": grand_total_delta,
        "perItemDeltas": per_item_deltas,
    }


def build_report_row(order_raw, result):
    return {
        "order_id": order_raw.get("entity_id"),
        "increment_id": order_raw.get("increment_id"),
        "coupon_code": order_raw.get("coupon_code"),
        "expected_tax": result["expectedTax"],
        "actual_tax": order_raw.get("base_tax_amount", 0) or 0,
        "tax_delta": result["taxDelta"],
        "expected_grand_total": result["expectedGrandTotal"],
        "actual_grand_total": order_raw.get("base_grand_total", 0) or 0,
        "grand_total_delta": result["grandTotalDelta"],
    }


def all_orders_with_coupon(token):
    current_page = 1
    while True:
        data = get_orders_with_coupon(token, PAGE_SIZE, current_page)
        items = data.get("items", [])
        for order in items:
            yield order
        total = data.get("total_count", 0)
        if current_page * PAGE_SIZE >= total or not items:
            return
        current_page += 1


def run():
    token = get_token()
    flagged = []

    for order_raw in all_orders_with_coupon(token):
        reconcile_input = to_reconcile_input(order_raw)
        result = reconcile_order_tax(reconcile_input, TAX_EPSILON)
        if result["ok"]:
            continue

        row = build_report_row(order_raw, result)
        flagged.append(row)
        log.warning(
            "Order %s coupon %s: expected_tax=%s actual_tax=%s tax_delta=%s grand_total_delta=%s",
            row["increment_id"], row["coupon_code"], row["expected_tax"],
            row["actual_tax"], row["tax_delta"], row["grand_total_delta"],
        )

    if flagged and not DRY_RUN:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "order_id", "increment_id", "coupon_code",
                "expected_tax", "actual_tax", "tax_delta",
                "expected_grand_total", "actual_grand_total", "grand_total_delta",
            ])
            writer.writeheader()
            writer.writerows(flagged)

    log.info("Done. %d order(s) flagged for manual finance review, %s.", len(flagged),
              "dry run, nothing written" if DRY_RUN else f"report written to {OUTPUT_CSV}")
    return flagged


if __name__ == "__main__":
    run()
