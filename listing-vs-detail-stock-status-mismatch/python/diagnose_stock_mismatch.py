"""Flag Magento 2 SKUs where the category grid and the product page disagree
on stock status, safely.

The grid renders from the cataloginventory_stock_status index, rebuilt by the
Category Products or Product indexers, typically on schedule or cron. The
product page and add to cart flow instead call the live InventorySalesApi
(GetProductSalableQtyInterface, IsProductSalableInterface), which nets source
item quantities against active reservations in real time. A sale or a
pending order zeroes the live salable quantity instantly, but the index only
catches up on the next reindex. This reports the mismatch by default and only
gates a narrow, reversible is_in_stock correction behind DRY_RUN=false. Run on
a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/listing-vs-detail-stock-status-mismatch/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_stock_mismatch")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
STOCK_ID = os.environ.get("STOCK_ID", "1")
MIN_QTY_THRESHOLD = float(os.environ.get("MIN_QTY_THRESHOLD", "0"))
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


def magento_put(path, payload):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def diagnose_stock_mismatch(sku, grid_in_stock, grid_qty, salable_qty, min_qty_threshold=0):
    """Pure decision function. No I/O.

    Compares the indexed grid-side stock signal (is_in_stock, quantity) against
    the live, real-time salable quantity from InventorySalesApi, and classifies
    whether the two sides agree, and if not, how severe the disagreement is.
    """
    if salable_qty > min_qty_threshold and grid_in_stock:
        return {"mismatched": False, "severity": "none", "reason": "consistent, both in stock"}

    if salable_qty <= min_qty_threshold and grid_in_stock:
        severity = "critical" if grid_qty > 0 else "stale_index"
        return {
            "mismatched": True,
            "severity": severity,
            "reason": "grid reports in-stock while live salable quantity is zero or "
                      "negative, stale stock_status index vs real-time reservation",
        }

    if salable_qty <= min_qty_threshold and not grid_in_stock:
        return {"mismatched": False, "severity": "none", "reason": "both correctly out of stock"}

    return {
        "mismatched": True,
        "severity": "stale_index",
        "reason": "grid still reports out-of-stock after restock, index lag in the other direction",
    }


def products_by_sku(skus):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": ",".join(skus),
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[pageSize]": 200,
    }
    return magento_get("/products", params)["items"]


def salable_quantity(sku, stock_id):
    data = magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}")
    return data if isinstance(data, (int, float)) else data.get("quantity", 0)


def source_items_for_sku(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/inventory/source-items", params)["items"]


def force_out_of_stock(sku, prior_is_in_stock):
    payload = {
        "product": {
            "sku": sku,
            "extension_attributes": {
                "stock_item": {"is_in_stock": False}
            },
        }
    }
    log.info("Correcting %s: is_in_stock %s -> false", sku, prior_is_in_stock)
    return magento_put(f"/products/{sku}", payload)


def run(skus):
    if not skus:
        log.warning("No SKUs supplied. Nothing to check, exiting.")
        return

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    flagged = 0

    for product in products_by_sku(skus):
        sku = product["sku"]
        stock_item = (product.get("extension_attributes") or {}).get("stock_item") or {}
        grid_in_stock = bool(stock_item.get("is_in_stock"))
        grid_qty = float(stock_item.get("qty", stock_item.get("quantity", 0)) or 0)

        salable = salable_quantity(sku, STOCK_ID)
        result = diagnose_stock_mismatch(sku, grid_in_stock, grid_qty, salable, MIN_QTY_THRESHOLD)

        if not result["mismatched"]:
            continue

        flagged += 1
        log.warning(
            "sku=%s is_in_stock=%s grid_qty=%s salable_qty=%s stock_id=%s severity=%s timestamp=%s reason=%s",
            sku, grid_in_stock, grid_qty, salable, STOCK_ID, result["severity"], now, result["reason"],
        )

        if result["severity"] == "critical" and not DRY_RUN:
            force_out_of_stock(sku, grid_in_stock)

    log.info("Done. %d SKU(s) flagged.", flagged)


if __name__ == "__main__":
    run(os.environ.get("CHECK_SKUS", "").split(",") if os.environ.get("CHECK_SKUS") else [])
