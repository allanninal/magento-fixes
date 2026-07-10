"""Flag Magento 2 or Adobe Commerce SKUs where MSI salable quantity is corrupted
by a missed reservation compensation.

MSI never stores salable quantity. It computes it as source item quantity minus
the sum of every inventory_reservation row for a SKU and stock. When one order
event, place, invoice, ship, cancel, or credit memo, fails to write its
compensating reservation, that running sum drifts away from the real committed
quantity and the reported salable quantity is permanently offset. This script
cross references source items, the MSI reported salable quantity, and open
order items to independently derive the expected salable quantity, and flags
any SKU where the two disagree beyond a tolerance. It never writes a
reservation row: that can only be done with
bin/magento inventory:reservation:list-inconsistencies -r piped into
bin/magento inventory:reservation:create-compensations. Safe to run again and
again.

Guide: https://www.allanninal.dev/magento/salable-quantity-corrupted-by-reservations/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_salable_qty_corruption")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
STOCK_ID = os.environ.get("STOCK_ID", "1")
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]
RESERVATION_TOLERANCE = float(os.environ.get("RESERVATION_TOLERANCE", "0.0001"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "salable_qty_inconsistencies.csv")

COMPENSATION_COMMAND = (
    "bin/magento inventory:reservation:list-inconsistencies -r "
    "| bin/magento inventory:reservation:create-compensations"
)


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


def source_qty_sum(token, sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/inventory/source-items",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    items = r.json().get("items", [])
    return sum(item.get("quantity", 0) for item in items)


def reported_salable_qty(token, sku, stock_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/{sku}/{stock_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def open_order_item_qty_sum(token, sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "processing",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[filterGroups][1][filters][0][field]": "status",
        "searchCriteria[filterGroups][1][filters][0][value]": "pending",
        "searchCriteria[filterGroups][1][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": 200,
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/orders",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    total = 0.0
    affected_order_ids = []
    for order in r.json().get("items", []):
        for line in order.get("items", []):
            if line.get("sku") == sku:
                qty_unfulfilled = (line.get("qty_ordered", 0) or 0) - (line.get("qty_shipped", 0) or 0) - (line.get("qty_canceled", 0) or 0)
                if qty_unfulfilled > 0:
                    total += qty_unfulfilled
                    affected_order_ids.append(order.get("entity_id"))
    return total, affected_order_ids


def reconcile_salable_qty(source_qty, reported_salable_qty_value, open_order_item_qty_sum_value, tolerance=RESERVATION_TOLERANCE):
    """Pure decision function. No I/O.

    Computes expected_salable_qty = source_qty - open_order_item_qty_sum_value,
    delta = reported_salable_qty_value - expected_salable_qty, and
    is_consistent = abs(delta) <= tolerance.
    """
    expected_salable_qty = source_qty - open_order_item_qty_sum_value
    delta = reported_salable_qty_value - expected_salable_qty
    is_consistent = abs(delta) <= tolerance
    return {
        "isConsistent": is_consistent,
        "expectedSalableQty": expected_salable_qty,
        "delta": delta,
    }


def print_compensation_command():
    log.warning("No REST endpoint can write a reservation compensation row.")
    log.warning("Run this on the server to repair the flagged SKUs:")
    log.warning("  %s", COMPENSATION_COMMAND)


def run():
    token = get_token()
    flagged = []
    for sku in SKUS:
        src_qty = source_qty_sum(token, sku)
        reported_qty = reported_salable_qty(token, sku, STOCK_ID)
        open_qty, affected_order_ids = open_order_item_qty_sum(token, sku)
        verdict = reconcile_salable_qty(src_qty, reported_qty, open_qty)
        if verdict["isConsistent"]:
            continue
        row = {
            "sku": sku,
            "stock_id": STOCK_ID,
            "source_qty_sum": src_qty,
            "reported_salable_qty": reported_qty,
            "expected_salable_qty": verdict["expectedSalableQty"],
            "delta": verdict["delta"],
            "affected_open_order_ids": ";".join(str(i) for i in affected_order_ids),
        }
        flagged.append(row)
        log.info(
            "SKU %s stock %s: reported=%s expected=%s delta=%s",
            sku, STOCK_ID, reported_qty, verdict["expectedSalableQty"], verdict["delta"],
        )

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "sku", "stock_id", "source_qty_sum", "reported_salable_qty",
                "expected_salable_qty", "delta", "affected_open_order_ids",
            ])
            writer.writeheader()
            writer.writerows(flagged)
        print_compensation_command()

    log.info("Done. %d SKU(s) flagged, %s.", len(flagged), "dry run, nothing written" if DRY_RUN else "report only, no write ever attempted")


if __name__ == "__main__":
    run()
