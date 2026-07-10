"""Find Magento category product assignments that never reached the search index.

catalog_category_product edits are only visible to a scheduled catalogsearch_fulltext
reindex if they wrote a row into the Mview changelog. When the mview.xml subscription
for that table is missing or overwritten by another indexer, admin and API category
assignments never produce a changelog row, so the product silently never appears in
category or fulltext search until a full reindex is forced.

This script is diagnostic only. It compares the admin-truth assignment list from
/V1/categories/{id}/products against the search-index-backed /V1/products listing,
rules out products that are legitimately absent (disabled or Not Visible Individually),
and reports the rest. DRY_RUN stays true, there is no write or reindex call in here.

Guide: https://www.allanninal.dev/magento/category-assignment-missing-from-search-index/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_category_assignments")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "dummy-token")
CATEGORY_IDS = [c.strip() for c in os.environ.get("CATEGORY_IDS", "").split(",") if c.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAGE_SIZE = 100
DISABLED_STATUS = 2
NOT_VISIBLE_INDIVIDUALLY = 1


def get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def assigned_skus(category_id):
    links = get(f"/categories/{category_id}/products")
    return [link["sku"] for link in links]


def search_index_skus(category_id):
    skus, page = [], 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "category_id",
            "searchCriteria[filterGroups][0][filters][0][value]": category_id,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": PAGE_SIZE,
            "searchCriteria[currentPage]": page,
        }
        data = get("/products", params)
        items = data.get("items", [])
        skus.extend(item["sku"] for item in items)
        if len(items) < PAGE_SIZE:
            return skus
        page += 1


def product_status(sku):
    product = get(f"/products/{sku}")
    return {"status": product.get("status"), "visibility": product.get("visibility")}


def find_missing_category_assignments(assigned_skus_list, search_index_skus_list, product_status_by_sku):
    """Pure function: returns the subset of assigned_skus_list not present in
    search_index_skus_list, excluding any SKU whose product_status_by_sku entry
    shows status=2 (disabled) or visibility=1 (Not Visible Individually), since
    those are legitimately absent rather than indexer-stale. Pure set-difference
    plus status filter over already-fetched data, no I/O.
    """
    search_index_set = set(search_index_skus_list)
    missing = []
    for sku in assigned_skus_list:
        if sku in search_index_set:
            continue
        info = product_status_by_sku.get(sku)
        if info and (info["status"] == DISABLED_STATUS or info["visibility"] == NOT_VISIBLE_INDIVIDUALLY):
            continue
        missing.append(sku)
    return missing


def run():
    total_gaps = 0
    for category_id in CATEGORY_IDS:
        assigned = assigned_skus(category_id)
        indexed = search_index_skus(category_id)
        candidates = [sku for sku in assigned if sku not in set(indexed)]
        product_status_by_sku = {sku: product_status(sku) for sku in candidates}
        gaps = find_missing_category_assignments(assigned, indexed, product_status_by_sku)
        for sku in gaps:
            log.warning("Category %s: SKU %s is assigned but missing from the search index.", category_id, sku)
        total_gaps += len(gaps)
    if total_gaps:
        log.info(
            "Done. %d category/SKU pair(s) look stuck in the changelog gap. "
            "Recommend: php bin/magento indexer:reindex catalogsearch_fulltext "
            "(or reset the mview_state for that view). %s",
            total_gaps,
            "Dry run, no write performed." if DRY_RUN else "This script never writes regardless of DRY_RUN.",
        )
    else:
        log.info("Done. No category/SKU gaps found across %d category/categories.", len(CATEGORY_IDS))


if __name__ == "__main__":
    run()
