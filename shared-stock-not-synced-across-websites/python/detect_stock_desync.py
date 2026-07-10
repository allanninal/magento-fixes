"""Detect Magento 2 or Adobe Commerce websites whose shared stock has drifted
out of sync.

MSI computes salable quantity per stock_id, source item quantity assigned to
that stock minus every outstanding reservation keyed by SKU and stock_id. Two
websites only share one pool of stock when their sales channels both resolve
to the same stock_id. "Not synced" oversell almost always means that mapping
drifted, a website's sales channel was reassigned to a different stock, or
some legacy or third party code wrote quantity directly into the deprecated
cataloginventory_stock_item table instead of creating a reservation, bypassing
the reservation ledger entirely. This script resolves each website's actual
stock_id, reads its salable quantity for a SKU, and flags any drift or
mismatch. It never reassigns a stock or writes product data: that stays a
deliberate admin decision made in Stores, Configuration, Sales Channels, plus
a CLI reindex and manual reservation reconciliation for legacy write paths.
Safe to run again and again.

Guide: https://www.allanninal.dev/magento/shared-stock-not-synced-across-websites/
"""
import os
import sys
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_stock_desync")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
SKU = os.environ.get("SKU", "")
EXPECTED_SHARED_STOCK_ID = int(os.environ.get("EXPECTED_SHARED_STOCK_ID", "1"))
WEBSITE_CODES = [w.strip() for w in os.environ.get("WEBSITE_CODES", "").split(",") if w.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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


def product_website_ids(token, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/products/{sku}/websites",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def resolve_stock_id_for_website(token, website_code):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/inventory/stock-resolver/website/{website_code}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def salable_qty(token, sku, stock_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/{sku}/{stock_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def source_items_for_sku(token, sku):
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
    return r.json().get("items", [])


def detect_stock_desync(website_stock_reports, expected_shared_stock_id):
    drifted_websites = []
    qty_mismatches = []

    for report in website_stock_reports:
        if report["stock_id"] != expected_shared_stock_id:
            drifted_websites.append(report["website_code"])

    in_sync_group = [r for r in website_stock_reports if r["stock_id"] == expected_shared_stock_id]
    if in_sync_group:
        base_qty = in_sync_group[0]["salable_qty"]
        for report in in_sync_group:
            if report["salable_qty"] != base_qty:
                qty_mismatches.append({
                    "website_code": report["website_code"],
                    "salable_qty": report["salable_qty"],
                })

    in_sync = not drifted_websites and not qty_mismatches
    return {
        "inSync": in_sync,
        "driftedWebsites": drifted_websites,
        "qtyMismatches": qty_mismatches,
    }


def run():
    if not SKU or not WEBSITE_CODES:
        log.error("SKU and WEBSITE_CODES must both be set.")
        return 2

    token = get_token()
    assigned_website_ids = product_website_ids(token, SKU)
    log.info("SKU %s is assigned to website ids: %s", SKU, assigned_website_ids)

    reports = []
    for website_code in WEBSITE_CODES:
        stock_id = resolve_stock_id_for_website(token, website_code)
        qty = salable_qty(token, SKU, stock_id)
        reports.append({"website_code": website_code, "stock_id": stock_id, "salable_qty": qty})

    source_items = source_items_for_sku(token, SKU)
    source_qty_sum = sum(item.get("quantity", 0) for item in source_items)

    verdict = detect_stock_desync(reports, EXPECTED_SHARED_STOCK_ID)

    report = {
        "sku": SKU,
        "expected_shared_stock_id": EXPECTED_SHARED_STOCK_ID,
        "websites": reports,
        "source_items_qty_sum": source_qty_sum,
        "in_sync": verdict["inSync"],
        "drifted_websites": verdict["driftedWebsites"],
        "qty_mismatches": verdict["qtyMismatches"],
    }
    print(json.dumps(report, indent=2))

    if verdict["inSync"]:
        log.info("Done. Websites are in sync for SKU %s.", SKU)
        return 0

    log.warning(
        "Done. SKU %s is NOT in sync. Drifted websites: %s. Qty mismatches: %s. %s",
        SKU, verdict["driftedWebsites"], verdict["qtyMismatches"],
        "dry run, nothing written" if DRY_RUN else "report only, no write ever attempted",
    )
    return 1


if __name__ == "__main__":
    sys.exit(run())
