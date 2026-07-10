"""Flag Magento 2 products where is_in_stock disagrees with zero salable quantity.

MSI keeps is_in_stock as a slow-changing flag refreshed by the cataloginventory
and legacy stock indexers, while salable quantity is computed on demand from
source_items minus active reservations. A checkout reservation lands
synchronously, so salable quantity can hit zero immediately while is_in_stock
keeps reporting true until a cron run or reindex catches up. This is a data
consistency symptom, not something safe to silently rewrite, so it reports by
default and only gates a real correction behind DRY_RUN=false. Run on a
schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_phantom_in_stock")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
STOCK_ID = os.environ.get("STOCK_ID", "1")
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))
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


def magento_put(path, body):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def is_phantom_in_stock(stock_item, salable_qty, backorders_allowed):
    """Pure decision: true only when the flag says buyable but nothing is left to sell.

    Returns False whenever manage_stock is False (unmanaged stock is intentionally
    always in stock), whenever backorders are allowed (a zero or negative salable
    qty is expected there), or whenever is_in_stock is already False.
    """
    if not stock_item.get("is_in_stock"):
        return False
    if not stock_item.get("manage_stock"):
        return False
    if backorders_allowed:
        return False
    return salable_qty <= 0


def stock_item_of(product):
    return (product.get("extension_attributes") or {}).get("stock_item") or {}


def enabled_products(page_size, current_page):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "1",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/products", params)["items"]


def all_enabled_products(page_size):
    page = 1
    while True:
        items = enabled_products(page_size, page)
        if not items:
            return
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def salable_quantity(sku, stock_id):
    return magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}")


def source_items_total(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    items = magento_get("/inventory/source-items", params)["items"]
    return sum(item.get("quantity", 0) for item in items)


def correct_flag(sku):
    body = {"product": {"sku": sku, "extension_attributes": {"stock_item": {"is_in_stock": False}}}}
    return magento_put(f"/products/{sku}", body)


def run():
    flagged = 0
    for product in all_enabled_products(PAGE_SIZE):
        sku = product.get("sku")
        stock_item = stock_item_of(product)
        stock_id = stock_item.get("stock_id", STOCK_ID)
        backorders_allowed = bool(stock_item.get("backorders"))

        qty_response = salable_quantity(sku, stock_id)
        salable_qty = qty_response[0] if isinstance(qty_response, list) else qty_response

        if not is_phantom_in_stock(stock_item, salable_qty, backorders_allowed):
            continue

        total_qty = source_items_total(sku)
        log.warning(
            "Mismatch: sku=%s stock_id=%s is_in_stock=%s salable_qty=%s source_items_total=%s. %s",
            sku, stock_id, stock_item.get("is_in_stock"), salable_qty, total_qty,
            "would correct" if DRY_RUN else "correcting",
        )
        if not DRY_RUN:
            correct_flag(sku)
            log.info(
                "Corrected %s. Run bin/magento indexer:reindex cataloginventory_stock inventory "
                "or bin/magento cron:run to reconcile.", sku,
            )
        flagged += 1

    log.info("Done. %d mismatched SKU(s) %s.", flagged, "to review" if DRY_RUN else "corrected")


if __name__ == "__main__":
    run()
