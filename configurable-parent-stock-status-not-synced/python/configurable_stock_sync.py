"""Flag Magento 2 configurable products whose cached is_in_stock flag disagrees
with the true OR-of-salable-children aggregate, safely.

A configurable's own is_in_stock flag lives in cataloginventory_stock_item and
is only refreshed by the Magento\\ConfigurableProduct stock-status plugin and
indexer path when specific save events fire and the inventory indexers are
caught up. A child quantity edited through an import, the API, or a
source-level change without triggering that path leaves the parent's cached
flag stale. This reports the mismatch by default and only gates a narrow
corrective PUT behind DRY_RUN=false. That write only fixes the cached flag,
not the MSI index itself, so a full bin/magento indexer:reindex is still
recommended afterward. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/configurable-parent-stock-status-not-synced/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("configurable_stock_sync")

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


def magento_put(path, payload):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def compute_expected_parent_stock_status(children):
    """Pure decision function: OR of salable children.

    Returns True only if children is non-empty AND at least one child has
    isInStock True AND salableQty > 0. Returns False if children is empty or
    every child fails that test.
    """
    if not children:
        return False
    return any(
        bool(child.get("isInStock")) and float(child.get("salableQty", 0) or 0) > 0
        for child in children
    )


def configurable_products(page_size=50):
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "type_id",
            "searchCriteria[filterGroups][0][filters][0][value]": "configurable",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        data = magento_get("/products", params)
        items = data.get("items", [])
        if not items:
            return
        for item in items:
            yield item
        if page * page_size >= data.get("total_count", 0):
            return
        page += 1


def children_for(sku):
    return magento_get(f"/configurable-products/{sku}/children")


def salable_quantity(sku, stock_id):
    data = magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}")
    return data if isinstance(data, (int, float)) else data.get("quantity", 0)


def child_stock_item(product):
    stock_item = (product.get("extension_attributes") or {}).get("stock_item") or {}
    return bool(stock_item.get("is_in_stock"))


def actual_parent_status(product):
    return child_stock_item(product)


def build_child_snapshot(child_sku, stock_id):
    child_product = magento_get(f"/products/{child_sku}")
    return {
        "sku": child_sku,
        "isInStock": child_stock_item(child_product),
        "salableQty": salable_quantity(child_sku, stock_id),
    }


def correct_parent_status(sku, expected_status):
    payload = {
        "product": {
            "sku": sku,
            "extension_attributes": {
                "stock_item": {"is_in_stock": expected_status, "manage_stock": True}
            },
        }
    }
    log.info("Correcting %s: is_in_stock -> %s (reindex still recommended)", sku, expected_status)
    return magento_put(f"/products/{sku}", payload)


def run():
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    flagged = 0

    for parent in configurable_products():
        sku = parent["sku"]
        children_raw = children_for(sku)
        if not children_raw:
            continue

        children = [
            build_child_snapshot(child["sku"], STOCK_ID) for child in children_raw
        ]
        expected = compute_expected_parent_stock_status(children)
        actual = actual_parent_status(parent)

        if expected == actual:
            continue

        flagged += 1
        log.warning(
            "sku=%s expected_in_stock=%s actual_in_stock=%s child_count=%s stock_id=%s timestamp=%s",
            sku, expected, actual, len(children), STOCK_ID, now,
        )

        if not DRY_RUN:
            correct_parent_status(sku, expected)

    log.info("Done. %d configurable(s) flagged.", flagged)


if __name__ == "__main__":
    run()
