"""Flag Magento 2 SKUs where salable quantity has gone negative or oversold, safely.

MSI computes salable quantity as sum(in-stock source_items quantities) minus sum
of outstanding reservations, an append-only ledger. If a compensating reservation
for a cancelled or failed order is lost, the ledger keeps an orphaned entry and
salable quantity drifts below zero forever, even though physical stock is fine.
Backorders set to allow qty below zero can make a negative number expected
instead of broken. Reservations are never rewritten here; the only write this
script performs is pausing further sales (is_in_stock=false) on a confirmed
critical oversell. The actual ledger repair stays a CLI-only operation for an
admin to run. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/salable-quantity-negative-oversell/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_salable_qty_oversell")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
STOCK_ID = os.environ.get("STOCK_ID", "1")
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


def get_salable_qty(sku, stock_id):
    data = magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}")
    return float(data)


def get_physical_qty(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    items = magento_get("/inventory/source-items", params)["items"]
    return sum(i["quantity"] for i in items if i.get("status") == 1)


def get_stock_item_config(sku):
    product = magento_get(f"/products/{sku}")
    stock_item = product["extension_attributes"]["stock_item"]
    return {
        "manageStock": bool(stock_item.get("manage_stock")),
        "backorders": int(stock_item.get("backorders", 0)),
    }


def get_open_order_qty_total(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "complete,closed,canceled",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "nin",
    }
    orders = magento_get("/orders", params)["items"]
    total = 0.0
    for order in orders:
        for item in order.get("items", []):
            if item.get("sku") == sku:
                total += float(item.get("qty_ordered", 0))
    return total


def decide_salable_qty_action(sku, salable_qty, physical_qty, open_order_qty_total, stock_item_config, tolerance_units=0):
    if not stock_item_config.get("manageStock"):
        return {
            "flag": True,
            "severity": "warning",
            "reason": "manage_stock disabled: product always shows in-stock, oversell not tracked",
        }

    backorders = stock_item_config.get("backorders", 0)

    if salable_qty < 0 and backorders == 0:
        return {
            "flag": True,
            "severity": "critical",
            "reason": "negative salable qty with backorders disabled: true oversell, invariant broken",
        }

    if salable_qty < 0 and backorders != 0:
        if abs(salable_qty) > open_order_qty_total + physical_qty:
            return {
                "flag": True,
                "severity": "critical",
                "reason": "reservation total exceeds open order demand: phantom/duplicate reservations",
            }
        return {"flag": False, "severity": "ok", "reason": "negative salable qty is expected backorder behavior"}

    expected_salable = physical_qty - open_order_qty_total
    if abs(salable_qty - expected_salable) > tolerance_units:
        return {
            "flag": True,
            "severity": "warning",
            "reason": "salable qty does not reconcile with source_items minus open reservations: stale index or lost/duplicated reservation",
        }

    return {"flag": False, "severity": "ok", "reason": "consistent"}


def pause_sales(sku):
    payload = {"product": {"sku": sku, "extension_attributes": {"stock_item": {"is_in_stock": False}}}}
    if DRY_RUN:
        log.info("DRY_RUN: would PUT /products/%s with %s", sku, payload)
        return
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()


def run(skus=None):
    skus = skus or []
    flagged = 0
    for sku in skus:
        salable_qty = get_salable_qty(sku, STOCK_ID)
        physical_qty = get_physical_qty(sku)
        open_order_qty_total = get_open_order_qty_total(sku)
        stock_item_config = get_stock_item_config(sku)

        result = decide_salable_qty_action(sku, salable_qty, physical_qty, open_order_qty_total, stock_item_config)

        if not result["flag"]:
            continue

        log.warning(
            "SKU %s: %s (salable=%s, physical=%s, openOrders=%s). %s",
            sku, result["severity"], salable_qty, physical_qty, open_order_qty_total, result["reason"],
        )

        if result["severity"] == "critical" and "oversell" in result["reason"]:
            pause_sales(sku)

        flagged += 1

    log.info("Done. %d SKU(s) flagged.", flagged)


if __name__ == "__main__":
    run(skus=os.environ.get("CHECK_SKUS", "").split(",") if os.environ.get("CHECK_SKUS") else [])
