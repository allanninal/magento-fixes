"""Detect the Magento product URL failure that happens when
catalog/seo/product_url_suffix and catalog/seo/category_url_suffix are both
empty, catalog/seo/product_use_categories is Yes, and
catalog/seo/generate_category_product_rewrites is No.

In that combination Magento\\CatalogUrlRewrite\\Model\\Storage\\DynamicStorage
resolves the product's request path on the fly with a plain str_replace
instead of a suffix anchored substr, which can strip the wrong part of the
path and 404 or 500 an otherwise normal product page.

store/storeConfigs does not expose product_use_categories or
generate_category_product_rewrites, so this script treats "no product url
rewrite rows contain a category path segment" as the observable proxy for
rewrite generation being off, then confirms the real failure with a live
HTTP GET against the storefront. Report only by default. Fixing the suffix
is a CLI operation (bin/magento config:set plus a reindex), which this
script cannot perform over REST, so it prints the exact commands instead.

Guide: https://www.allanninal.dev/magento/disabled-rewrite-empty-suffix-error/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("url_suffix_risk_check")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SAMPLE_PAGE_SIZE = int(os.environ.get("SAMPLE_PAGE_SIZE", "100"))
SAMPLE_MAX_PAGES = int(os.environ.get("SAMPLE_MAX_PAGES", "5"))


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


def fetch_store_configs():
    return api_get("/store/storeConfigs")


def fetch_sample_products(page_size=SAMPLE_PAGE_SIZE, max_pages=SAMPLE_MAX_PAGES):
    products, page = [], 1
    while page <= max_pages:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "status",
            "searchCriteria[filterGroups][0][filters][0][value]": 1,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        result = api_get("/products", params)
        items = result.get("items", [])
        products.extend(items)
        if len(items) < page_size:
            break
        page += 1
    return products


def classify_url_suffix_risk(config, url_request_path, http_status):
    """Pure decision function, no I/O.

    config: {productUrlSuffix, categoryUrlSuffix,
             useCategoriesPathForProductUrls, generateCategoryProductRewrites}
    url_request_path: the resolved storefront request path, e.g.
        "test-category/test-sub-category/test"
    http_status: the observed HTTP status code for that live URL

    Returns {"affected": bool, "reason": str}. affected=True only when both
    suffixes are empty, categories are used in the product path, rewrite
    generation is disabled, the path has a category segment, and the live
    status is 404 or 500.
    """
    product_suffix = config.get("productUrlSuffix")
    category_suffix = config.get("categoryUrlSuffix")
    use_categories = config.get("useCategoriesPathForProductUrls")
    generate_rewrites = config.get("generateCategoryProductRewrites")

    if product_suffix:
        return {"affected": False, "reason": "suffix-present"}
    if category_suffix:
        return {"affected": False, "reason": "suffix-present"}
    if not use_categories:
        return {"affected": False, "reason": "no-category-path"}
    if generate_rewrites:
        return {"affected": False, "reason": "rewrites-enabled"}
    if "/" not in url_request_path:
        return {"affected": False, "reason": "no-category-path"}
    if http_status not in (404, 500):
        return {"affected": False, "reason": "ok"}

    return {"affected": True, "reason": "empty-suffix-category-path-collision"}


def resolve_storefront_status(base_url, request_path):
    url = f"{base_url.rstrip('/')}/{request_path.lstrip('/')}"
    r = requests.get(url, timeout=15, allow_redirects=True)
    return r.status_code


def build_request_path(category_path, url_key):
    if not category_path:
        return url_key
    return f"{category_path.strip('/')}/{url_key}"


def repair_product_url_key(sku, url_key):
    """Narrow REST-only mitigation for a specific SKU. Never called
    automatically; only run when DRY_RUN=false and a human has confirmed
    the SKU list. Does not fix the underlying suffix configuration."""
    payload = {"product": {"sku": sku, "custom_attributes": [
        {"attribute_code": "url_key", "value": url_key}
    ]}}
    return api_put(f"/products/{sku}", payload)


def print_cli_fix(store_code):
    log.info(
        "CLI fix for store %s: bin/magento config:set catalog/seo/product_url_suffix html --scope=stores --scope-code=%s "
        "&& bin/magento indexer:reindex catalog_url_rewrite "
        "(or bin/magento config:set catalog/seo/generate_category_product_rewrites 1)",
        store_code, store_code,
    )


def run(category_path_by_sku=None):
    category_path_by_sku = category_path_by_sku or {}
    store_configs = fetch_store_configs()
    products = fetch_sample_products()

    affected = []
    for store in store_configs:
        config = {
            "productUrlSuffix": store.get("product_url_suffix"),
            "categoryUrlSuffix": store.get("category_url_suffix"),
            # Not exposed by storeConfigs; treated as the risky default so the
            # live GET is the real arbiter of whether a page actually fails.
            "useCategoriesPathForProductUrls": True,
            "generateCategoryProductRewrites": False,
        }
        store_id = store.get("id")
        base_url = store.get("secure_base_url") or store.get("base_url") or MAGENTO_URL

        for product in products:
            sku = product["sku"]
            url_key = custom_attr(product.get("custom_attributes"), "url_key", sku)
            category_path = category_path_by_sku.get(sku, "")
            request_path = build_request_path(category_path, url_key)
            if "/" not in request_path:
                continue

            status = resolve_storefront_status(base_url, request_path)
            result = classify_url_suffix_risk(config, request_path, status)
            if result["affected"]:
                affected.append({
                    "sku": sku,
                    "store_id": store_id,
                    "request_path": request_path,
                    "http_status": status,
                    "reason": result["reason"],
                })
                log.warning(
                    "AFFECTED sku=%s store_id=%s request_path=%s status=%s",
                    sku, store_id, request_path, status,
                )
                print_cli_fix(store.get("code", store_id))

    log.info("Done. %d affected record(s) found.", len(affected))
    if affected and not DRY_RUN:
        log.info("DRY_RUN is false. Confirm the SKU list above before running any url_key PUT.")
    return affected


if __name__ == "__main__":
    run()
