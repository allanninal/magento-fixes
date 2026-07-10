"""Repair Magento 2 or Adobe Commerce inventory_source_item rows left stale
after an Out-of-Stock Threshold change.

Saving a new cataloginventory/options/stock_threshold_qty value fires
admin_system_config_changed_section_cataloginventory, which correctly
recalculates the legacy cataloginventory_stock_item.is_in_stock flag. MSI has
no matching observer for inventory_source_item, so existing source items keep
whichever status value the old threshold produced until quantity changes on
its own or a full reindex and cron pass happen to touch them. This script
pages through the catalog, reads every source item's quantity and stored
status, recomputes the status each should have under the current threshold
and backorders setting, and by default only reports the mismatches. Only
under an explicit DRY_RUN=false operator override does it PUT the corrected
status. It never touches quantity. Run on a schedule after any threshold
change. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/threshold-change-not-applied-existing-items/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_threshold_source_items")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://demo.example.com").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "token_dummy")
STOCK_THRESHOLD_QTY = float(os.environ.get("STOCK_THRESHOLD_QTY", "0"))
BACKORDERS_ENABLED = os.environ.get("BACKORDERS_ENABLED", "false").lower() == "true"
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


def recompute_source_item_status(quantity, threshold, backorders_enabled):
    if backorders_enabled and threshold <= 0:
        return 1
    salable = quantity - threshold
    return 1 if salable > 0 else 0


def products_page(page_size, current_page):
    params = {
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/products", params)["items"]


def all_products(page_size):
    page = 1
    while True:
        items = products_page(page_size, page)
        if not items:
            return
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def source_items_for_sku(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/inventory/source-items", params)["items"]


def repair_source_item(sku, source_code, quantity, new_status):
    body = {"sourceItems": [{"sku": sku, "source_code": source_code, "quantity": quantity, "status": new_status}]}
    return magento_put("/inventory/source-items", body)


def run():
    fixed = 0
    for product in all_products(PAGE_SIZE):
        sku = product.get("sku")
        for item in source_items_for_sku(sku):
            source_code = item.get("source_code")
            quantity = item.get("quantity", 0)
            old_status = item.get("status")
            new_status = recompute_source_item_status(quantity, STOCK_THRESHOLD_QTY, BACKORDERS_ENABLED)

            if old_status == new_status:
                continue

            log.warning(
                "Stale status: sku=%s source_code=%s quantity=%s threshold=%s old_status=%s new_status=%s. %s",
                sku, source_code, quantity, STOCK_THRESHOLD_QTY, old_status, new_status,
                "would repair" if DRY_RUN else "repairing",
            )
            if not DRY_RUN:
                repair_source_item(sku, source_code, quantity, new_status)
            fixed += 1

    if not DRY_RUN and fixed:
        log.info("Run bin/magento indexer:reindex cataloginventory_stock and bin/magento cron:run to reconcile the legacy stock item and salable quantity index.")
    log.info("Done. %d source item(s) %s.", fixed, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
