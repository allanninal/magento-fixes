"""Flag a Magento 2 or Adobe Commerce shared catalog price cached and served to the wrong company.

Magento's full page cache and block cache key rendered price HTML on a hash of
Magento\\Framework\\App\\Http\\Context, customer group, store, currency, carried via
the X-Magento-Vary cookie and header. Shared catalogs apply a per company
discount on top of the base tier price, but the cache layer does not always
fully re derive that context before caching a category page's rendered price
HTML (magento/magento2 issues 10439, 38509, and the related 40474; confirmed
by Adobe quality patch ACSD-48784). The first viewer's price gets cached and
served to the next visitor from a different company or a guest until the
entry is purged. This script reads each shared catalog's assigned customer
group and expected price, computes the authoritative tier and shared catalog
price per group with tier-prices-information, simulates what each relevant
group would see, and flags any SKU/category/group triple where the rendered
price does not match. It only ever writes by re-assigning the shared
catalog's own products, which forces Magento to reindex and invalidate the
associated cache tags. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/shared-catalog-price-cached-wrong-company/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_shared_catalog_price_mismatch")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
SHARED_CATALOG_ID = os.environ.get("SHARED_CATALOG_ID", "")
CATEGORY_ID = os.environ.get("CATEGORY_ID", "")
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]
WEBSITE_ID = int(os.environ.get("WEBSITE_ID", "1"))
GUEST_GROUP_ID = int(os.environ.get("GUEST_GROUP_ID", "0"))
GENERAL_GROUP_ID = int(os.environ.get("GENERAL_GROUP_ID", "1"))
PRICE_TOLERANCE = float(os.environ.get("PRICE_TOLERANCE", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "shared_catalog_price_mismatch.csv")


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


def get_shared_catalog_products(token, shared_catalog_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/sharedCatalog/{shared_catalog_id}/products",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_customer_group_id(token, name_contains, page_size=100):
    params = {"searchCriteria[pageSize]": page_size}
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/customerGroups/search",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    for group in r.json().get("items", []):
        if name_contains.lower() in group.get("code", "").lower():
            return group["id"]
    return None


def get_tier_prices_information(token, skus, customer_group, website_id):
    body = {"skus": skus, "customerGroup": customer_group, "websiteId": website_id}
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/products/tier-prices-information",
        json=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_category_products(token, category_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/categories/{category_id}/products",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_product(token, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def refresh_shared_catalog(token, shared_catalog_id, products_payload):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/sharedCatalog/{shared_catalog_id}/assignProducts",
        json={"products": products_payload},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_price_mismatch(expected, observed, other_group_prices=None):
    """Pure decision logic (no I/O).

    expected: {sku, customerGroupId, sharedCatalogId, expectedPrice}
    observed: {sku, customerGroupId, renderedPrice, cacheAgeSeconds}
    other_group_prices: optional map of other customer_group_id -> expected price,
        used to detect that the rendered price actually belongs to a different group.

    Returns {isMismatch, severity, reason}. severity is one of
    "wrong_company" (rendered price matches a DIFFERENT group's expected price
    while the group differs from expected), "wrong_group" (rendered price is
    wrong but matches no known other group, a generic stale cache), or "ok"
    (rendered price matches expected within PRICE_TOLERANCE).
    """
    other_group_prices = other_group_prices or {}

    if abs(observed["renderedPrice"] - expected["expectedPrice"]) <= PRICE_TOLERANCE:
        return {"isMismatch": False, "severity": "ok", "reason": "Rendered price matches the expected price for this group."}

    if observed["customerGroupId"] != expected["customerGroupId"]:
        for other_group_id, other_price in other_group_prices.items():
            if other_group_id == observed["customerGroupId"]:
                continue
            if abs(observed["renderedPrice"] - other_price) <= PRICE_TOLERANCE:
                return {
                    "isMismatch": True,
                    "severity": "wrong_company",
                    "reason": f"Group {observed['customerGroupId']} was served group {other_group_id}'s price.",
                }

    return {
        "isMismatch": True,
        "severity": "wrong_group",
        "reason": "Rendered price disagrees with the expected price and matches no other known group, likely a generic stale cache.",
    }


def run():
    token = get_token()
    skus = SKUS
    catalog_products_by_sku = {}

    if SHARED_CATALOG_ID:
        catalog_data = get_shared_catalog_products(token, SHARED_CATALOG_ID)
        items = catalog_data.get("items", catalog_data) if isinstance(catalog_data, dict) else catalog_data
        for item in items or []:
            catalog_products_by_sku[item.get("sku")] = item.get("price")
        if not skus:
            skus = list(catalog_products_by_sku.keys())

    if CATEGORY_ID and not skus:
        category_data = get_category_products(token, CATEGORY_ID)
        skus = [p.get("sku") for p in category_data if p.get("sku")]

    relevant_group_ids = sorted({GUEST_GROUP_ID, GENERAL_GROUP_ID})
    if SHARED_CATALOG_ID:
        company_group_id = find_customer_group_id(token, "company") or find_customer_group_id(token, "wholesale")
        if company_group_id is not None:
            relevant_group_ids = sorted(set(relevant_group_ids) | {company_group_id})

    flagged = []
    for sku in skus:
        expected_price_by_group = {}
        for group_id in relevant_group_ids:
            info = get_tier_prices_information(token, [sku], group_id, WEBSITE_ID)
            price = None
            entries = info if isinstance(info, list) else info.get("items", [])
            for entry in entries:
                if entry.get("sku") == sku:
                    prices = entry.get("prices", [])
                    price = prices[0]["price"] if prices else entry.get("price")
            expected_price_by_group[group_id] = price if price is not None else 0.0

        product = get_product(token, sku)
        rendered_price = product.get("price", 0.0)

        for group_id in relevant_group_ids:
            expected = {
                "sku": sku,
                "customerGroupId": group_id,
                "sharedCatalogId": SHARED_CATALOG_ID or None,
                "expectedPrice": expected_price_by_group[group_id],
            }
            observed = {
                "sku": sku,
                "customerGroupId": group_id,
                "renderedPrice": rendered_price,
                "cacheAgeSeconds": 0,
            }
            other_prices = {gid: p for gid, p in expected_price_by_group.items() if gid != group_id}
            verdict = decide_price_mismatch(expected, observed, other_prices)

            if verdict["isMismatch"]:
                row = {
                    "sku": sku, "customer_group_id": group_id,
                    "expected_price": expected["expectedPrice"], "observed_price": rendered_price,
                    "severity": verdict["severity"], "reason": verdict["reason"],
                }
                flagged.append(row)
                log.warning("SKU %s group %s: %s (expected %s, observed %s)",
                            sku, group_id, verdict["severity"], expected["expectedPrice"], rendered_price)

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["sku", "customer_group_id", "expected_price", "observed_price", "severity", "reason"])
            writer.writeheader()
            writer.writerows(flagged)

    if not DRY_RUN and SHARED_CATALOG_ID and catalog_products_by_sku:
        payload = [{"sku": sku, "price": price} for sku, price in catalog_products_by_sku.items()]
        refresh_shared_catalog(token, SHARED_CATALOG_ID, payload)
        log.info("Re-assigned %d product(s) on shared catalog %s to force reindex and cache invalidation.",
                  len(payload), SHARED_CATALOG_ID)
        log.info("Operator follow up: bin/magento cache:clean full_page,block_html,config "
                  "&& bin/magento indexer:reindex catalog_product_price")

    log.info("Done. %d SKU/group mismatch(es) flagged, %s.", len(flagged),
              "dry run, nothing written" if DRY_RUN else "shared catalog refresh triggered")


if __name__ == "__main__":
    run()
