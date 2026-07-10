"""Detect and safely repair Magento products force-assigned to the wrong website on save.

Magento\\Catalog\\Model\\ProductRepository::save() runs an internal
assignProductToWebsites() step on every save. When the save context resolves to
the admin store code, common for CLI scripts, cron-triggered imports, custom
catalog_product_save_after observers, or REST calls that skip an explicit store
scope, this step can force-assign the product only to the default website,
silently overwriting catalog_product_website and dropping every other website
the product used to be on.

This script reads the actual website_ids for each SKU in your expected mapping,
compares them with decide_website_drift, and by default only reports the drift.
Only when the drift is a pure lost assignment, missing ids with nothing
unexpected, does it call POST /V1/products/{sku}/websites to add each missing
id back, and only under an explicit DRY_RUN=false operator override. It never
calls the DELETE websites endpoint. Run on a schedule after any bulk save,
import, or deploy that touches ProductRepository::save. Safe to run again and
again.

Guide: https://www.allanninal.dev/magento/product-force-assigned-wrong-store/
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_website_drift")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://demo.example.com").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "token_dummy")
ADMIN_STORE_CODE = os.environ.get("ADMIN_STORE_CODE", "admin")
STORE_CONTEXT_CODE = os.environ.get("STORE_CONTEXT_CODE", ADMIN_STORE_CODE)
EXPECTED_WEBSITES_JSON = os.environ.get("EXPECTED_WEBSITES_JSON", "{}")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DEFAULT_WEBSITE_ID = 1


def magento_get(path):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_post(path, body):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def actual_website_ids(sku):
    product = magento_get(f"/products/{sku}")
    ext = product.get("extension_attributes", {}) or {}
    ids = ext.get("website_ids")
    if ids is not None:
        return ids
    return magento_get(f"/products/{sku}/websites")


def decide_website_drift(actual_website_ids, expected_website_ids, store_context_code, admin_store_code="admin"):
    """Pure function. No I/O. Compares actual vs expected website id sets.

    Returns a dict with:
      isDrifted: True when missing or unexpected ids exist
      missing: expected ids that are absent from actual (lost assignment)
      unexpected: actual ids that are not expected (possibly a deliberate edit)
      likelyForcedDefault: True when actual is exactly the default website id,
        expected has more than one id, and the save's store context code
        equals the admin store code, the signature of the forced-default bug.
    """
    actual = sorted(set(actual_website_ids))
    expected = sorted(set(expected_website_ids))
    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    is_drifted = bool(missing) or bool(unexpected)
    likely_forced_default = (
        actual == [DEFAULT_WEBSITE_ID]
        and len(expected) > 1
        and store_context_code == admin_store_code
    )
    return {
        "isDrifted": is_drifted,
        "missing": missing,
        "unexpected": unexpected,
        "likelyForcedDefault": likely_forced_default,
    }


def add_website_link(sku, website_id):
    body = {"productWebsiteLink": {"sku": sku, "website_id": website_id}}
    return magento_post(f"/products/{sku}/websites", body)


def run():
    expected_map = json.loads(EXPECTED_WEBSITES_JSON)
    flagged = 0
    repaired = 0

    for sku, expected_ids in expected_map.items():
        actual_ids = actual_website_ids(sku)
        drift = decide_website_drift(actual_ids, expected_ids, STORE_CONTEXT_CODE, ADMIN_STORE_CODE)

        if not drift["isDrifted"]:
            continue

        flagged += 1
        log.warning(
            "Drift on sku=%s expected=%s actual=%s missing=%s unexpected=%s likely_forced_default=%s",
            sku, sorted(set(expected_ids)), sorted(set(actual_ids)),
            drift["missing"], drift["unexpected"], drift["likelyForcedDefault"],
        )

        safe_to_repair = drift["missing"] and not drift["unexpected"]
        if not safe_to_repair:
            log.warning("Sku=%s has an unexpected website id, flagging only, no auto-repair.", sku)
            continue

        if DRY_RUN:
            log.info("Sku=%s would add missing website id(s) %s (dry run).", sku, drift["missing"])
            continue

        for website_id in drift["missing"]:
            add_website_link(sku, website_id)
            log.info("Sku=%s added back website id %s.", sku, website_id)
        repaired += 1

    log.info("Done. %d sku(s) flagged, %d sku(s) repaired.", flagged, repaired)


if __name__ == "__main__":
    run()
