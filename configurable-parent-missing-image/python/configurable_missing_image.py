"""Flag Magento 2 configurable products whose own media gallery is empty
while at least one simple child has images, safely.

A configurable's catalog_product_entity_media_gallery_value_to_entity
linkage is entirely independent of its children's gallery entries. Magento
never auto-copies or inherits images from children to the parent row. This
commonly appears after CSV or API bulk imports, or product creation flows,
where images are attached only to the simple SKUs. The storefront often
masks this by falling back to a child's image through ImageBuilder and the
configurable JavaScript widget, so the gap only surfaces when an API
consumer, a PWA, a marketplace feed, or a mobile app, requests the parent
directly. This reports the mismatch by default and only gates a narrow
corrective upload behind DRY_RUN=false. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/magento/configurable-parent-missing-image/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("configurable_missing_image")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
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


def magento_post(path, payload):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_missing_parent_image(parent_gallery, child_galleries):
    """Pure decision function. No I/O.

    parent_gallery: list of media gallery entry dicts for the parent SKU.
    child_galleries: dict mapping child SKU -> list of that child's entries.
    Returns a verdict dict, never mutates its inputs.
    """
    parent_image_count = sum(1 for e in parent_gallery if not e.get("disabled"))

    children_with_images = [
        sku for sku, entries in child_galleries.items()
        if sum(1 for e in entries if not e.get("disabled")) > 0
    ]

    flagged = parent_image_count == 0 and len(children_with_images) > 0

    recommended_fix_sku = None
    if flagged:
        recommended_fix_sku = _preferred_child(children_with_images, child_galleries)

    return {
        "flagged": flagged,
        "parentImageCount": parent_image_count,
        "childrenWithImages": children_with_images,
        "recommendedFixSku": recommended_fix_sku,
    }


def _preferred_child(children_with_images, child_galleries):
    for sku in children_with_images:
        entries = child_galleries.get(sku, [])
        if any(not e.get("disabled") and "image" in (e.get("types") or []) for e in entries):
            return sku
    return children_with_images[0]


def configurable_products(page_size=50):
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "type_id",
            "searchCriteria[filterGroups][0][filters][0][value]": "configurable",
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        data = magento_get("/products", params)
        items = data.get("items", [])
        if not items:
            return
        for item in items:
            yield item
        if page * page_size >= data.get("total_count", 0):
            return
        page += 1


def children_for(sku):
    return magento_get(f"/configurable-products/{sku}/children")


def gallery_for(sku):
    return magento_get(f"/products/{sku}/media")


def upload_entry_from_child(parent_sku, child_sku, child_entry):
    """Create a new gallery entry on the parent SKU. Never edits the child."""
    payload = {
        "entry": {
            "media_type": "image",
            "label": child_entry.get("label") or f"Copied from {child_sku}",
            "position": 1,
            "disabled": False,
            "types": ["image", "small_image", "thumbnail"],
            "content": {
                "base64_encoded_data": child_entry.get("base64_encoded_data", ""),
                "type": child_entry.get("content_type", "image/jpeg"),
                "name": child_entry.get("file", f"{child_sku}.jpg"),
            },
        }
    }
    log.info("Uploading gallery entry to %s from %s", parent_sku, child_sku)
    return magento_post(f"/products/{parent_sku}/media", payload)


def run():
    flagged = 0

    for parent in configurable_products():
        sku = parent["sku"]
        parent_id = parent.get("id")
        children_raw = children_for(sku)
        if not children_raw:
            continue

        parent_gallery = parent.get("media_gallery_entries") or gallery_for(sku)
        child_galleries = {
            child["sku"]: gallery_for(child["sku"]) for child in children_raw
        }

        verdict = decide_missing_parent_image(parent_gallery, child_galleries)
        if not verdict["flagged"]:
            continue

        flagged += 1
        log.warning(
            "parent_sku=%s parent_id=%s affected_children=%d recommended_fix_sku=%s",
            sku, parent_id, len(verdict["childrenWithImages"]), verdict["recommendedFixSku"],
        )

        if not DRY_RUN:
            log.info(
                "DRY_RUN is false, but this reference script still only reports. "
                "Fetch the recommended child's image content and call "
                "upload_entry_from_child(sku, verdict['recommendedFixSku'], entry) "
                "once a human has confirmed the file."
            )

    log.info("Done. %d configurable(s) flagged.", flagged)


if __name__ == "__main__":
    run()
