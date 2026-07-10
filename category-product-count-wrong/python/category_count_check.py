"""Flag Magento categories whose reported product_count disagrees with the
real product to category assignments, especially anchor categories after a
partial catalog_category_product reindex. Report only by default.

The catalog_category_product indexer rebuilds catalog_category_product_index
(and the per store index) with a temp table swap rather than updating rows in
place. If that swap is interrupted the index table can go stale or zero out
while the live assignment table is untouched. This script cannot trigger a
real reindex over REST, so it detects and reports the gap, and only if you
opt in with MAGENTO_ALLOW_INDEXER_INVALIDATE=true does it resave the category
to nudge Magento's own indexer invalidation for the next scheduled cron run.

Guide: https://www.allanninal.dev/magento/category-product-count-wrong/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("category_count_check")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
TOLERANCE = int(os.environ.get("COUNT_TOLERANCE", "0"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ALLOW_INVALIDATE = os.environ.get("MAGENTO_ALLOW_INDEXER_INVALIDATE", "false").lower() == "true"


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


def list_category_ids():
    result = api_get("/categories/list", {
        "searchCriteria[pageSize]": 200,
    })
    return [item["id"] for item in result.get("items", [])]


def reported_category_count(category_id):
    cat = api_get(f"/categories/{category_id}")
    attrs = cat.get("custom_attributes")
    reported = int(custom_attr(attrs, "product_count", 0) or 0)
    is_anchor = str(custom_attr(attrs, "is_anchor", "0")) == "1"
    return reported, is_anchor, cat


def actual_category_count(category_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "category_id",
        "searchCriteria[filterGroups][0][filters][0][value]": category_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": 1,
    }
    result = api_get("/products", params)
    return int(result.get("total_count", 0))


def decide_category_count_discrepancy(reported_count, actual_count, is_anchor, tolerance=0):
    delta = actual_count - reported_count
    if actual_count > 0 and reported_count == 0:
        return {"flagged": True, "severity": "zeroed", "delta": delta}
    if abs(delta) > tolerance:
        return {"flagged": True, "severity": "drift", "delta": delta}
    return {"flagged": False, "severity": "none", "delta": delta}


def nudge_indexer_invalidate(category_id, category):
    name = category.get("name")
    api_put(f"/categories/{category_id}", {"category": {"id": category_id, "name": name}})


def run():
    flagged = 0
    for category_id in list_category_ids():
        reported, is_anchor, category = reported_category_count(category_id)
        actual = actual_category_count(category_id)
        decision = decide_category_count_discrepancy(reported, actual, is_anchor, TOLERANCE)
        if not decision["flagged"]:
            continue
        flagged += 1
        log.warning(
            "Category %s %s: reported=%d actual=%d delta=%+d anchor=%s",
            category_id, decision["severity"], reported, actual, decision["delta"], is_anchor,
        )
        if ALLOW_INVALIDATE and not DRY_RUN:
            nudge_indexer_invalidate(category_id, category)
            log.info("Category %s: resaved to invalidate catalog_category_product indexer", category_id)
    log.info("Done. %d categor%s flagged.", flagged, "y" if flagged == 1 else "ies")


if __name__ == "__main__":
    run()
