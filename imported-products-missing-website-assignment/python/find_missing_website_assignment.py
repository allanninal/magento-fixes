"""Find Magento products imported without a website assignment.

A product is only visible on a storefront when catalog_product_website has a row
linking its entity id to that website's id. Neither the CSV importer, when the
product_websites column is blank or has a typo'd code, nor the REST product-create
endpoint, which has no plain website_ids field, is guaranteed to write that row.
The product still saves and indexes fine, it is just invisible everywhere on the
storefront.

By default this script only reports affected SKUs. It repairs a SKU only when
TARGET_WEBSITE_ID is set, DRY_RUN is false, and the store has exactly one website,
since the correct assignment cannot be inferred safely when there is more than one.

Guide: https://www.allanninal.dev/magento/imported-products-missing-website-assignment/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_website_assignment")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
UPDATED_SINCE = os.environ.get("UPDATED_SINCE", "1970-01-01 00:00:00")
EXPECTED_WEBSITE_IDS = [
    int(w) for w in os.environ.get("EXPECTED_WEBSITE_IDS", "1").split(",") if w.strip()
]
TARGET_WEBSITE_ID = os.environ.get("TARGET_WEBSITE_ID", "").strip()
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAGE_SIZE = 200


def get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def post(path, body):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def recent_products(since):
    products, page = [], 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
            "searchCriteria[filterGroups][0][filters][0][value]": since,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
            "searchCriteria[pageSize]": PAGE_SIZE,
            "searchCriteria[currentPage]": page,
        }
        data = get("/products", params)
        items = data.get("items", [])
        products.extend(items)
        if len(items) < PAGE_SIZE:
            return products
        page += 1


def is_missing_website_assignment(product, expected_website_ids=(1,)):
    extension_attributes = product.get("extension_attributes") or {}
    actual = extension_attributes.get("website_ids") or []
    missing_website_ids = [wid for wid in expected_website_ids if wid not in actual]
    affected = len(actual) == 0 or len(missing_website_ids) > 0
    return {
        "sku": product.get("sku"),
        "affected": affected,
        "missingWebsiteIds": missing_website_ids,
    }


def confirmed_website_ids(sku):
    return get(f"/products/{sku}/websites")


def store_website_count():
    return len(get("/store/websites"))


def link_website(sku, website_id):
    body = {"productWebsiteLink": {"sku": sku, "website_id": website_id}}
    post(f"/products/{sku}/websites", body)


def run():
    candidates = recent_products(UPDATED_SINCE)
    affected_skus = []
    for product in candidates:
        decision = is_missing_website_assignment(product, EXPECTED_WEBSITE_IDS)
        if not decision["affected"]:
            continue
        confirmed = confirmed_website_ids(decision["sku"])
        if confirmed:
            continue
        affected_skus.append(decision["sku"])
        log.warning(
            "SKU %s has no website assignment. Missing website id(s): %s",
            decision["sku"], decision["missingWebsiteIds"],
        )

    if not affected_skus:
        log.info("Done. No products missing a website assignment out of %d checked.", len(candidates))
        return

    if not TARGET_WEBSITE_ID:
        log.info(
            "Done. %d SKU(s) missing a website assignment. Set TARGET_WEBSITE_ID and DRY_RUN=false "
            "to link them, only if this store has a single website.", len(affected_skus),
        )
        return

    if store_website_count() > 1:
        log.warning(
            "Store has more than one website. Skipping repair for all %d SKU(s), "
            "the correct assignment cannot be inferred safely.", len(affected_skus),
        )
        return

    website_id = int(TARGET_WEBSITE_ID)
    for sku in affected_skus:
        action = "would link" if DRY_RUN else "linking"
        log.info("SKU %s. %s website %d", sku, action, website_id)
        if not DRY_RUN:
            link_website(sku, website_id)
    log.info("Done. %d SKU(s) %s to website %d.", len(affected_skus), "to link" if DRY_RUN else "linked", website_id)


if __name__ == "__main__":
    run()
