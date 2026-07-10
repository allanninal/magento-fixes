"""Flag Magento anchor categories that show products from a disabled
subcategory, because the catalog_category_product indexer aggregates the
full category subtree by path and never checks is_active on a child.
Report only by default.

is_anchor only controls whether a category aggregates its subtree's
products at all. It was never wired to also respect a child category's
is_active flag, so disabling a subcategory does not remove its products
from the parent anchor's indexed listing, and reindexing reproduces the
same leak every time. This script cannot change that core aggregation
logic over REST, so it detects and reports the exact leaked SKUs, and
only if you opt in with DRY_RUN=false does it unassign a confirmed SKU
from the disabled category.

Guide: https://www.allanninal.dev/magento/anchor-category-leaks-disabled-subcategory-products/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("anchor_leak_check")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
ROOT_CATEGORY_ID = os.environ.get("ROOT_CATEGORY_ID", "2")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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


def fetch_category_tree(root_category_id):
    return api_get("/categories", {"rootCategoryId": root_category_id})


def category_products(category_id):
    return api_get(f"/categories/{category_id}/products")


def fetch_product_index(skus):
    unique = sorted(set(skus))
    if not unique:
        return {}
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": ",".join(unique),
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[pageSize]": len(unique),
    }
    result = api_get("/products", params)
    return {
        item["sku"]: {"status": int(item.get("status", 0)), "visibility": int(item.get("visibility", 0))}
        for item in result.get("items", [])
    }


def to_plain_tree(raw_category):
    """Convert a raw Magento category API node into the plain shape the pure
    function expects: {id, isActive, isAnchor, children: [...]}."""
    attrs = raw_category.get("custom_attributes")
    return {
        "id": raw_category["id"],
        "isActive": str(custom_attr(attrs, "is_active", "1")) == "1",
        "isAnchor": str(custom_attr(attrs, "is_anchor", "0")) == "1",
        "children": [to_plain_tree(child) for child in raw_category.get("children_data") or []],
    }


def collect_category_ids(node):
    ids = [node["id"]]
    for child in node.get("children") or []:
        ids.extend(collect_category_ids(child))
    return ids


def find_leaked_anchor_products(category_tree, product_index, category_product_assignments):
    """Given the anchor's subtree (plain dict: id, isActive, isAnchor, children),
    a product_index map of sku -> {status, visibility}, and a
    category_product_assignments map of category_id -> [{sku}, ...], return a
    list of {anchorCategoryId, disabledCategoryId, sku}, deduped by sku and
    anchor id. No I/O: everything is passed in as plain data already fetched
    by the caller.
    """
    leaks = []
    seen = set()

    def walk(node, nearest_anchor_id):
        anchor_id = node["id"] if node.get("isAnchor") else nearest_anchor_id
        if not node.get("isActive", True) and anchor_id is not None:
            for assignment in category_product_assignments.get(node["id"], []):
                sku = assignment["sku"]
                info = product_index.get(sku)
                if not info:
                    continue
                if info.get("status") != 1 or info.get("visibility") == 1:
                    continue
                key = (sku, anchor_id)
                if key in seen:
                    continue
                seen.add(key)
                leaks.append({"anchorCategoryId": anchor_id, "disabledCategoryId": node["id"], "sku": sku})
        for child in node.get("children") or []:
            walk(child, anchor_id)

    walk(category_tree, category_tree["id"] if category_tree.get("isAnchor") else None)
    return leaks


def unassign_sku_from_category(category_id, sku):
    links = category_products(category_id)
    remaining = [link for link in links if link.get("sku") != sku]
    api_put(f"/categories/{category_id}", {"category": {"id": category_id, "productLinks": remaining}})


def run():
    raw_tree = fetch_category_tree(ROOT_CATEGORY_ID)
    tree = to_plain_tree(raw_tree)

    assignments = {}
    all_skus = []
    for category_id in collect_category_ids(tree):
        links = category_products(category_id)
        assignments[category_id] = links
        all_skus.extend(link["sku"] for link in links)

    product_index = fetch_product_index(all_skus)

    leaks = find_leaked_anchor_products(tree, product_index, assignments)
    for leak in leaks:
        log.warning(
            "Leak: anchor=%s disabled_category=%s sku=%s",
            leak["anchorCategoryId"], leak["disabledCategoryId"], leak["sku"],
        )
        if not DRY_RUN:
            unassign_sku_from_category(leak["disabledCategoryId"], leak["sku"])
            log.info("Unassigned sku=%s from disabled category=%s", leak["sku"], leak["disabledCategoryId"])
    log.info("Done. %d leaked product(s) %s.", len(leaks), "to review" if DRY_RUN else "unassigned")


if __name__ == "__main__":
    run()
