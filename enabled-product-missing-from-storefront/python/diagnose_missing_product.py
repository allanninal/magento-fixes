"""Diagnose a Magento 2 product that shows Enabled but is missing from the storefront.

Status Enabled is only one of several conditions Magento checks. Visibility has
to include catalog or search, the product has to carry the storefront's
website_id in its website assignment (a REST create/update that omits
extension_attributes.website_ids can silently drop or fail to set this, per
magento2 GitHub issues #8173, #10495, #11324), and it has to link to at least
one active category. Even when all three agree, a stale or invalid indexer
(catalog_category_product, catalog_product_index, catalogsearch_fulltext) or a
missed cron run can still hide the product, and that can only be fixed with
bin/magento indexer:reindex, not over REST. This reports by default. Run on a
schedule or on demand. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/enabled-product-missing-from-storefront/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_missing_product")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
TARGET_WEBSITE_ID = int(os.environ.get("TARGET_WEBSITE_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

NOT_VISIBLE_INDIVIDUALLY = 1
SUSPECT_INDEXERS = ["catalog_category_product", "catalog_product_index", "catalogsearch_fulltext"]


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


def decide_storefront_eligibility(product, categories, target_website_id):
    """Pure decision logic, no I/O.

    product: {status: 1|2, visibility: 1|2|3|4, websiteIds: [int], categoryIds: [int]}
    categories: [{id: int, isActive: bool}]
    target_website_id: int
    Returns {"eligible": bool, "reasons": [str]}.

    eligible is True only if status == 1 AND visibility != 1 (Not Visible
    Individually) AND target_website_id is in websiteIds AND at least one
    linked category is active. Otherwise reasons lists every failing
    condition, so the caller can tell "should be eligible per data but still
    missing from storefront" (stale index/cron) apart from "genuinely
    ineligible per data".
    """
    reasons = []

    if product["status"] != 1:
        reasons.append("disabled")

    if product["visibility"] == NOT_VISIBLE_INDIVIDUALLY:
        reasons.append("not_visible_individually")

    if target_website_id not in product["websiteIds"]:
        reasons.append("website_not_assigned")

    active_ids = {c["id"] for c in categories if c["isActive"]}
    if not any(cid in active_ids for cid in product["categoryIds"]):
        reasons.append("no_active_category")

    return {"eligible": len(reasons) == 0, "reasons": reasons}


def find_product_by_sku(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    items = magento_get("/products", params)["items"]
    return items[0] if items else None


def visibility_of(product):
    for attr in product.get("custom_attributes", []):
        if attr["attribute_code"] == "visibility":
            return int(attr["value"])
    return None


def category_ids_of(product):
    for attr in product.get("custom_attributes", []):
        if attr["attribute_code"] == "category_ids":
            return [int(c) for c in attr["value"]]
    return []


def product_website_ids(sku):
    return magento_get(f"/products/{sku}/websites")


def fetch_categories(category_ids):
    result = []
    for cid in category_ids:
        data = magento_get(f"/categories/{cid}")
        result.append({"id": cid, "isActive": bool(data.get("is_active"))})
    return result


def storefront_has_product(storefront_url):
    r = requests.get(storefront_url, timeout=15, allow_redirects=True)
    return r.status_code == 200


def build_product_snapshot(sku):
    product = find_product_by_sku(sku)
    if product is None:
        return None
    category_ids = category_ids_of(product)
    snapshot = {
        "status": product["status"],
        "visibility": visibility_of(product),
        "websiteIds": product_website_ids(sku),
        "categoryIds": category_ids,
    }
    categories = fetch_categories(category_ids)
    return snapshot, categories


def diagnose(sku, storefront_url=None):
    built = build_product_snapshot(sku)
    if built is None:
        return {"sku": sku, "status": "not_found"}

    snapshot, categories = built
    verdict = decide_storefront_eligibility(snapshot, categories, TARGET_WEBSITE_ID)

    if not verdict["eligible"]:
        return {"sku": sku, "status": "ineligible", "reasons": verdict["reasons"]}

    if storefront_url and not storefront_has_product(storefront_url):
        return {"sku": sku, "status": "indexer_or_cron_suspected", "suspects": SUSPECT_INDEXERS}

    return {"sku": sku, "status": "ok"}


def repair_product(sku, fixes):
    """fixes may include status, visibility, and/or website_ids (a FULL list).
    Never send a partial website_ids list; that is the documented bug (#11324)
    that reassigns or drops websites. Always prints a diff before writing.
    """
    body = {"product": {"sku": sku}}
    if "status" in fixes:
        body["product"]["status"] = fixes["status"]
    if "visibility" in fixes:
        body["product"]["visibility"] = fixes["visibility"]
    if "website_ids" in fixes:
        body["product"]["extension_attributes"] = {"website_ids": fixes["website_ids"]}

    log.info("DRY_RUN diff for %s: %s", sku, body)
    if DRY_RUN:
        return {"sku": sku, "applied": False, "dry_run": True, "body": body}

    magento_put(f"/products/{sku}", body)
    return {"sku": sku, "applied": True, "dry_run": False, "body": body}


def run(skus, storefront_urls=None):
    storefront_urls = storefront_urls or {}
    reports = []
    for sku in skus:
        report = diagnose(sku, storefront_urls.get(sku))
        log.info("SKU %s: %s", sku, report["status"])
        reports.append(report)
    log.info("Done. %d SKU(s) checked.", len(reports))
    return reports


if __name__ == "__main__":
    target_skus = [s.strip() for s in os.environ.get("TARGET_SKUS", "").split(",") if s.strip()]
    run(target_skus)
