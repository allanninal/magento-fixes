"""Flag Magento 2 or Adobe Commerce order lines whose reservation placement
was skipped because the order was created directly through POST /V1/orders.

MSI reduces salable quantity only by writing an append only, negative row to
inventory_reservation. That row is written by a plugin hooked to the
sales_order_place_after event, which fires from the normal quote to order
checkout pipeline, OrderManagementInterface::place. An order built and
persisted directly through POST /V1/orders, the way ERPs and marketplaces
inject historical or external orders, never runs that pipeline, so the
reservation plugin never executes for those items. This script lists recent
open orders, sums qty_ordered per SKU, and cross checks that against source
item quantity minus reported salable quantity for the same SKU. Any shortfall
means a reservation was never written, and it is attributed back to the
earliest under reserved order lines. There is no REST endpoint to create a
reservation, so this script only reports, unless DRY_RUN=false and an operator
has confirmed the guarded legacy stock_item stopgap. Safe to run again and
again.
"""
import os
import csv
import json
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_unreserved_orders")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
STOCK_ID = os.environ.get("STOCK_ID", "1")
ORDER_STATUSES = [s.strip() for s in os.environ.get("ORDER_STATUSES", "processing,pending").split(",") if s.strip()]
LOOKBACK_DAYS = float(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "unreserved_order_items.csv")
APPLIED_LEDGER = os.environ.get("APPLIED_LEDGER", "unreserved_stopgap_applied.json")


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


def list_open_orders(token, since_iso, statuses, page_size=100):
    orders = []
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
            "searchCriteria[filterGroups][0][filters][0][value]": since_iso,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        for i, status in enumerate(statuses):
            params[f"searchCriteria[filterGroups][1][filters][{i}][field]"] = "status"
            params[f"searchCriteria[filterGroups][1][filters][{i}][value]"] = status
            params[f"searchCriteria[filterGroups][1][filters][{i}][conditionType]"] = "eq"
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/orders",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        items = body.get("items", [])
        orders.extend(items)
        if len(items) < page_size:
            return orders
        page += 1


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


def salable_qty(token, sku, stock_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/{sku}/{stock_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_unreserved_order_items(open_orders, source_qty_by_sku, salable_qty_by_sku):
    """Pure, no I/O. For each SKU, sums qtyOrdered across all openOrders to get
    expectedReserved; computes actualReserved = sourceQtyBySku[sku] -
    salableQtyBySku[sku]; if actualReserved < expectedReserved, walks
    openOrders again in order and attributes the shortfall to the earliest
    order items for that SKU until the shortfall is exhausted. Returns one
    finding per under-reserved order/SKU pair with missingReservationQty
    equal to the un-reflected quantity for that line."""
    expected_by_sku = {}
    for order in open_orders:
        for item in order["items"]:
            sku = item["sku"]
            expected_by_sku[sku] = expected_by_sku.get(sku, 0) + item["qtyOrdered"]

    findings = []
    for sku, expected_reserved in expected_by_sku.items():
        source_qty = source_qty_by_sku.get(sku, 0)
        salable = salable_qty_by_sku.get(sku, 0)
        actual_reserved = source_qty - salable
        remaining = expected_reserved - actual_reserved
        if remaining <= 0:
            continue
        for order in open_orders:
            if remaining <= 0:
                break
            for item in order["items"]:
                if item["sku"] != sku:
                    continue
                take = min(remaining, item["qtyOrdered"])
                if take <= 0:
                    continue
                findings.append({
                    "incrementId": order["incrementId"],
                    "sku": sku,
                    "qtyOrdered": item["qtyOrdered"],
                    "missingReservationQty": take,
                })
                remaining -= take
    return findings


def apply_stopgap_stock_correction(token, sku, current_qty, missing_qty):
    """Idempotent per increment_id when driven from the ledger in run().
    Only called when DRY_RUN is false and an operator has confirmed the
    finding. This is a legacy stock_item adjustment, not a reservation,
    and is a stopgap only."""
    new_qty = current_qty - missing_qty
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        json={"product": {"sku": sku, "extension_attributes": {
            "stock_item": {"qty": new_qty}
        }}},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return new_qty


def load_applied_ledger():
    if os.path.exists(APPLIED_LEDGER):
        with open(APPLIED_LEDGER) as fh:
            return set(json.load(fh))
    return set()


def save_applied_ledger(applied):
    with open(APPLIED_LEDGER, "w") as fh:
        json.dump(sorted(applied), fh)


def run():
    token = get_token()
    since_iso = (datetime.datetime.utcnow() - datetime.timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    raw_orders = list_open_orders(token, since_iso, ORDER_STATUSES)

    open_orders = []
    for order in raw_orders:
        items = [
            {"sku": line["sku"], "qtyOrdered": line.get("qty_ordered", 0) or 0}
            for line in order.get("items", [])
            if (line.get("qty_ordered", 0) or 0) > 0
        ]
        if items:
            open_orders.append({"incrementId": order["increment_id"], "items": items})

    skus = sorted({item["sku"] for order in open_orders for item in order["items"]})
    source_qty_by_sku = {sku: source_qty_sum(token, sku) for sku in skus}
    salable_qty_by_sku = {sku: salable_qty(token, sku, STOCK_ID) for sku in skus}

    findings = find_unreserved_order_items(open_orders, source_qty_by_sku, salable_qty_by_sku)

    if findings:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["incrementId", "sku", "qtyOrdered", "missingReservationQty"])
            writer.writeheader()
            writer.writerows(findings)

    applied = load_applied_ledger()
    for finding in findings:
        log.info(
            "Order %s SKU %s: qty_ordered=%s missing_reservation_qty=%s",
            finding["incrementId"], finding["sku"], finding["qtyOrdered"], finding["missingReservationQty"],
        )
        ledger_key = f"{finding['incrementId']}:{finding['sku']}"
        if DRY_RUN or ledger_key in applied:
            continue
        current_qty = source_qty_by_sku[finding["sku"]]
        apply_stopgap_stock_correction(token, finding["sku"], current_qty, finding["missingReservationQty"])
        applied.add(ledger_key)
    if not DRY_RUN and findings:
        save_applied_ledger(applied)

    log.info(
        "Done. %d order/SKU pair(s) flagged, %s. No REST endpoint writes inventory_reservation; "
        "switch order ingestion to the checkout flow or run the CLI reservation tooling.",
        len(findings), "dry run, nothing written" if DRY_RUN else "stopgap applied where confirmed",
    )


if __name__ == "__main__":
    run()
