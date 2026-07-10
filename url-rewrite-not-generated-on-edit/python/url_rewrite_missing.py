"""Detect Magento products whose url_rewrite row was not generated on
save or duplicate, and report the safe repair.

ProductProcessUrlRewriteSavingObserver regenerates url_rewrite rows on
catalog_product_save_after using Product::getStoreIds() to resolve which
stores to write for. In single-store mode, and reliably when a product is
saved through PUT /V1/products/{sku} instead of the admin form,
getStoreIds() mishandles website_ids and resolves the wrong or an empty
scope, so no rewrite row is written. No exception is thrown and the save
still returns 200 OK. There is no public API to insert a url_rewrite row
directly, and a blind write risks a URL_REWRITE_REQUEST_PATH_STORE_ID
collision, so this script only reports affected SKUs and, when DRY_RUN is
explicitly disabled, applies the documented re-save workaround. Report
only by default.

Guide: https://www.allanninal.dev/magento/url-rewrite-not-generated-on-edit/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("url_rewrite_missing")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SKUS = [s.strip() for s in os.environ.get("CHECK_SKUS", "").split(",") if s.strip()]
STORE_BASE_URLS = os.environ.get("STORE_BASE_URLS", "")  # "1:https://store1.example.com,2:https://store2.example.com"


def api_get(path, params=None):
    r = requests.get(f"{MAGENTO_URL}/rest/V1{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, payload):
    r = requests.put(f"{MAGENTO_URL}/rest/V1{path}", headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def custom_attr(attrs, code, default=None):
    for a in attrs or []:
        if a.get("attribute_code") == code:
            return a.get("value")
    return default


def fetch_product(sku):
    item = api_get(f"/products/{sku}")
    return {
        "sku": item["sku"],
        "urlKey": custom_attr(item.get("custom_attributes"), "url_key"),
        "storeIds": (item.get("extension_attributes") or {}).get("website_ids", []),
    }


def fetch_url_suffix(store_code):
    configs = api_get("/store/storeConfigs", {"storeCodes[]": store_code})
    if not configs:
        return ".html"
    return configs[0].get("product_url_suffix") or ".html"


def parse_store_base_urls(raw):
    mapping = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or ":" not in pair:
            continue
        store_id, url = pair.split(":", 1)
        mapping[int(store_id)] = url
    return mapping


def is_url_rewrite_missing(product, expected_suffix, existing_rewrite_paths):
    """Pure decision function. No I/O.

    For each store the product belongs to, compute the expected request_path
    and check whether it is present in the pre-fetched existing_rewrite_paths
    map (store_id -> set of known request_paths). Returns a list of
    {sku, storeId, expectedPath} for every store missing that path.
    """
    missing = []
    for store_id in product["storeIds"]:
        expected_path = f"{product['urlKey']}{expected_suffix}"
        known_paths = existing_rewrite_paths.get(store_id, set())
        if expected_path not in known_paths:
            missing.append({
                "sku": product["sku"],
                "storeId": store_id,
                "expectedPath": expected_path,
            })
    return missing


def path_resolves(store_base_url, expected_path):
    r = requests.head(f"{store_base_url.rstrip('/')}/{expected_path}", timeout=15, allow_redirects=False)
    if r.status_code == 405:
        r = requests.get(f"{store_base_url.rstrip('/')}/{expected_path}", timeout=15, allow_redirects=False)
    return r.status_code in (200, 301, 302)


def repair_with_duplicated_website_ids(sku, website_ids):
    """Documented core workaround: PUT the product with website_ids
    intentionally duplicated, e.g. [1, 1], which forces getStoreIds() down
    a code path that resolves the store scope correctly."""
    doubled = list(website_ids) + list(website_ids)
    payload = {"product": {"sku": sku, "extension_attributes": {"website_ids": doubled}}}
    return api_put(f"/products/{sku}", payload)


def run():
    store_base_urls = parse_store_base_urls(STORE_BASE_URLS)
    flagged = 0

    for sku in SKUS:
        product = fetch_product(sku)
        if not product["urlKey"]:
            log.warning("SKU %s has no url_key, skipping", sku)
            continue

        existing_rewrite_paths = {}
        for store_id in product["storeIds"]:
            base_url = store_base_urls.get(store_id)
            if not base_url:
                log.warning("No STORE_BASE_URLS entry for store_id=%s, skipping check", store_id)
                continue
            suffix = fetch_url_suffix(str(store_id))
            expected_path = f"{product['urlKey']}{suffix}"
            existing_rewrite_paths[store_id] = (
                {expected_path} if path_resolves(base_url, expected_path) else set()
            )

        default_suffix = ".html"
        missing = is_url_rewrite_missing(product, default_suffix, existing_rewrite_paths)

        for gap in missing:
            log.warning(
                "Missing url_rewrite: sku=%s store_id=%s expected_path=%s",
                gap["sku"], gap["storeId"], gap["expectedPath"],
            )
            flagged += 1

        if missing:
            log.info(
                "%s sku=%s website_ids=%s (duplicated workaround)",
                "Would PUT" if DRY_RUN else "PUTting",
                sku, product["storeIds"],
            )
            if not DRY_RUN:
                repair_with_duplicated_website_ids(sku, product["storeIds"])

    log.info("Done. %d missing rewrite(s) found.", flagged)


if __name__ == "__main__":
    run()
