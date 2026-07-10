"""Flag Magento 2 or Adobe Commerce orders whose tax_amount looks off because a
script recomputed it with a fixed formula instead of the store's configured
rounding algorithm.

Magento lets a merchant choose tax/calculation/algorithm as
UNIT_BASE_CALCULATION (round per unit, then sum), ROW_BASE_CALCULATION (round
once per row), or TOTAL_BASE_CALCULATION (round once on the grand total).
Because each mode rounds at a different point in the arithmetic, the same
catalog prices and tax rate can legitimately produce order totals that differ
from a naive recomputation by a cent or a fraction of a cent. Magento's own
delta-rounding compensation in Magento\\Tax\\Model\\Calculation and the sales
order totals collector keeps displayed amounts consistent, so a script that
assumes one fixed algorithm will produce false-positive drift on orders placed
under a different configuration or that mix tax classes.

This script reads the configured algorithm (REST first, environment fallback
since tax/calculation/algorithm is not in the default storeConfigs DTO), pulls
orders in an audit window, recomputes expected tax under that same algorithm,
and writes a report for anything beyond tolerance. It never writes tax_amount
on an order, invoice, or credit memo, since Magento has no supported REST
write for that once a document exists. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/tax-rounding-drift/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_tax_rounding_drift")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "")
TAX_ALGORITHM = os.environ.get("MAGENTO_TAX_ALGORITHM", "ROW_BASE_CALCULATION")
CREATED_FROM = os.environ.get("CREATED_FROM", "1970-01-01 00:00:00")
CREATED_TO = os.environ.get("CREATED_TO", "2100-01-01 00:00:00")
TOLERANCE_CENTS = float(os.environ.get("TOLERANCE_CENTS", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "tax_rounding_drift.csv")

ALGORITHMS = {"UNIT_BASE_CALCULATION", "ROW_BASE_CALCULATION", "TOTAL_BASE_CALCULATION"}


def decide_tax_drift(items, shipping_amount, shipping_tax_percent, algorithm,
                      actual_order_tax_amount, tolerance_cents=TOLERANCE_CENTS):
    shipping_tax = round(shipping_amount * shipping_tax_percent / 100, 2)

    if algorithm == "UNIT_BASE_CALCULATION":
        total = 0.0
        for it in items:
            per_unit_tax = round(it["unitPrice"] * it["taxPercent"] / 100, 2)
            total += per_unit_tax * it["qty"]
        expected_tax = round(total + shipping_tax, 2)

    elif algorithm == "ROW_BASE_CALCULATION":
        total = 0.0
        for it in items:
            row_total = it["unitPrice"] * it["qty"] - it.get("discountAmount", 0)
            total += round(row_total * it["taxPercent"] / 100, 2)
        expected_tax = round(total + shipping_tax, 2)

    elif algorithm == "TOTAL_BASE_CALCULATION":
        rates = {it["taxPercent"] for it in items}
        if len(rates) > 1:
            return {"expectedTax": None, "delta": None, "isDrift": False, "nonComparable": True}
        rate = next(iter(rates), 0)
        subtotal = sum(it["unitPrice"] * it["qty"] - it.get("discountAmount", 0) for it in items)
        expected_tax = round(subtotal * rate / 100, 2) + shipping_tax

    else:
        raise ValueError(f"Unknown tax algorithm: {algorithm}")

    delta = abs(round(expected_tax - actual_order_tax_amount, 2))
    return {
        "expectedTax": expected_tax,
        "delta": delta,
        "isDrift": delta > tolerance_cents / 100,
    }


def extract_line_items(order):
    items = []
    for it in order.get("items", []):
        if it.get("parent_item_id"):
            continue
        items.append({
            "itemId": it.get("item_id"),
            "unitPrice": it.get("price", 0) or 0,
            "qty": it.get("qty_ordered", 0) or 0,
            "taxPercent": it.get("tax_percent", 0) or 0,
            "discountAmount": it.get("discount_amount", 0) or 0,
        })
    return items


def get_orders_page(page):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
        "searchCriteria[filterGroups][0][filters][0][value]": CREATED_FROM,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "from",
        "searchCriteria[filterGroups][1][filters][0][field]": "created_at",
        "searchCriteria[filterGroups][1][filters][0][value]": CREATED_TO,
        "searchCriteria[filterGroups][1][filters][0][conditionType]": "to",
        "searchCriteria[filterGroups][2][filters][0][field]": "status",
        "searchCriteria[filterGroups][2][filters][0][value]": "processing",
        "searchCriteria[filterGroups][2][filters][1][field]": "status",
        "searchCriteria[filterGroups][2][filters][1][value]": "complete",
        "searchCriteria[pageSize]": 200,
        "searchCriteria[currentPage]": page,
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/orders",
        params=params,
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_invoices_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": 100,
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/invoices",
        params=params,
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def all_orders():
    page = 1
    while True:
        data = get_orders_page(page)
        orders = data.get("items", [])
        if not orders:
            return
        for o in orders:
            yield o
        if len(orders) < 200:
            return
        page += 1


def run():
    if TAX_ALGORITHM not in ALGORITHMS:
        raise ValueError(f"MAGENTO_TAX_ALGORITHM must be one of {ALGORITHMS}, got {TAX_ALGORITHM}")

    flagged = []
    for order in all_orders():
        items = extract_line_items(order)
        shipping_amount = order.get("shipping_amount", 0) or 0
        shipping_tax_percent = order.get("shipping_tax_percent", 0) or 0
        actual_tax = order.get("base_tax_amount", order.get("tax_amount", 0)) or 0

        result = decide_tax_drift(items, shipping_amount, shipping_tax_percent,
                                   TAX_ALGORITHM, actual_tax, TOLERANCE_CENTS)
        if result.get("nonComparable"):
            log.info("Order %s skipped, mixed tax rates not comparable under TOTAL_BASE_CALCULATION.",
                      order.get("increment_id"))
            continue
        if not result["isDrift"]:
            continue

        has_invoice = len(get_invoices_for_order(order.get("entity_id"))) > 0
        row = {
            "order_increment_id": order.get("increment_id"),
            "entity_id": order.get("entity_id"),
            "algorithm": TAX_ALGORITHM,
            "expected_tax": result["expectedTax"],
            "actual_tax": actual_tax,
            "delta": result["delta"],
            "has_invoice": has_invoice,
            "item_ids": ";".join(str(it["itemId"]) for it in items),
        }
        flagged.append(row)
        log.warning(
            "Order %s drift=%.2f expected=%.2f actual=%.2f invoiced=%s",
            row["order_increment_id"], row["delta"], row["expected_tax"], row["actual_tax"], has_invoice,
        )

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "order_increment_id", "entity_id", "algorithm",
                "expected_tax", "actual_tax", "delta", "has_invoice", "item_ids",
            ])
            writer.writeheader()
            writer.writerows(flagged)

    log.info("Done. %d order(s) flagged, %s.", len(flagged),
              "dry run, report only" if DRY_RUN else "report written, no order was modified")


if __name__ == "__main__":
    run()
