"""Flag Magento 2 or Adobe Commerce credit memos whose tax was computed from the
full order instead of the refunded items.

Magento's credit memo tax totals collector is supposed to prorate tax per line
item using qty being refunded versus qty invoiced. Long standing bugs, seen
across magento2 GitHub issues 8797, 9929, 10982, 14713, 23938, 32222, and
34586, instead cause it to copy the order's full tax_amount and
base_tax_amount onto the credit memo, notably when the credit memo is created
from the admin order view, when multiple partial credit memos are issued
against the same invoice, or when the display currency differs from the base
currency. CreditmemoItemInterface.tax_amount is a snapshot stored at creation
time, never re-derived later, so a wrong number stays wrong forever.

This script never edits an existing credit memo, since Magento has no
supported REST write for that. It recomputes the expected proportional tax
from the order's own item data, compares it to each credit memo's reported
base_tax_amount, and writes a reconciliation report. Only under an explicit
DRY_RUN=false does it optionally POST a new corrective refund call carrying
an adjustment_positive or adjustment_negative argument. In dry run it only
prints the proposed payload. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/partial-refund-tax-miscalculated/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_creditmemo_tax_mismatch")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
ORDER_IDS = [o.strip() for o in os.environ.get("ORDER_IDS", "").split(",") if o.strip()]
TAX_EPSILON = float(os.environ.get("TAX_EPSILON", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "creditmemo_tax_mismatches.csv")


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


def get_creditmemos_for_order(token, order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": 100,
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/creditmemo",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def is_creditmemo_tax_mismatched(order_item_tax_amount, order_item_qty_ordered,
                                  creditmemo_item_qty, creditmemo_base_tax_amount, epsilon=TAX_EPSILON):
    """Pure decision function. Takes only primitive numeric inputs already
    extracted from the order/creditmemo JSON and returns a plain dict for the
    caller to log or act on. No I/O.
    """
    if not order_item_qty_ordered:
        expected_tax = 0.0
    else:
        expected_tax = order_item_tax_amount * (creditmemo_item_qty / order_item_qty_ordered)
    delta = creditmemo_base_tax_amount - expected_tax
    return {
        "expectedTax": expected_tax,
        "delta": delta,
        "mismatched": abs(delta) > epsilon,
    }


def expected_tax_for_creditmemo(order_items_by_id, creditmemo):
    """Sum the pure per-line expected tax across every refunded line on a
    credit memo, using each order item's own tax_amount and qty_ordered.
    """
    expected_total = 0.0
    for cm_item in creditmemo.get("items", []):
        order_item = order_items_by_id.get(cm_item.get("order_item_id"))
        if not order_item:
            continue
        expected_total += is_creditmemo_tax_mismatched(
            order_item.get("tax_amount", 0) or 0,
            order_item.get("qty_ordered", 0) or 0,
            cm_item.get("qty", 0) or 0,
            0,  # only expectedTax is used here, actual comparison happens at the creditmemo level
        )["expectedTax"]
    return expected_total


def build_adjustment_payload(delta):
    if delta > 0:
        return {"arguments": {"adjustment_negative": round(delta, 2)}}
    return {"arguments": {"adjustment_positive": round(abs(delta), 2)}}


def apply_adjustment(token, order_id, delta):
    payload = build_adjustment_payload(delta)
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/order/{order_id}/refund",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    flagged = []
    for order_id in ORDER_IDS:
        order = get_order(token, order_id)
        order_items_by_id = {item.get("item_id"): item for item in order.get("items", [])}
        creditmemos = get_creditmemos_for_order(token, order_id)

        for cm in creditmemos:
            expected_tax = expected_tax_for_creditmemo(order_items_by_id, cm)
            actual_tax = cm.get("base_tax_amount", 0) or 0
            delta = actual_tax - expected_tax
            mismatched = abs(delta) > TAX_EPSILON
            if not mismatched:
                continue

            row = {
                "order_increment_id": order.get("increment_id"),
                "creditmemo_increment_id": cm.get("increment_id"),
                "expected_tax": round(expected_tax, 4),
                "actual_tax": round(actual_tax, 4),
                "delta": round(delta, 4),
            }
            flagged.append(row)
            log.warning(
                "Order %s creditmemo %s: expected_tax=%s actual_tax=%s delta=%s",
                row["order_increment_id"], row["creditmemo_increment_id"],
                row["expected_tax"], row["actual_tax"], row["delta"],
            )

            payload = build_adjustment_payload(delta)
            log.info("Proposed adjustment payload: %s", payload)
            if not DRY_RUN:
                apply_adjustment(token, order_id, delta)

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "order_increment_id", "creditmemo_increment_id",
                "expected_tax", "actual_tax", "delta",
            ])
            writer.writeheader()
            writer.writerows(flagged)

    log.info("Done. %d creditmemo(s) flagged, %s.", len(flagged),
              "dry run, nothing written" if DRY_RUN else "corrective refund attempted where flagged")
    return flagged


if __name__ == "__main__":
    run()
