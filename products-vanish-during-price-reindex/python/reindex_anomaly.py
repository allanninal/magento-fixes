"""Detect the transient product-vanishing gap in Magento's catalog_product_price reindex.

Reindex/cron and direct index-table access are CLI/DB-only, so this detects the symptom
over REST: it records the enabled and visible SKU set before, during, and after a known
reindex window, cross references indexer status, and reports whether a drop is the
expected self-healing batching race or a genuine, still-missing product. It never calls
a mutating endpoint for a transient gap. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/products-vanish-during-price-reindex/
"""
import os
import time
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reindex_anomaly")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))
POLL_INTERVAL_SECONDS = float(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def enabled_visible_skus():
    """Full pageSize iteration over enabled, visible products. Returns a list of SKUs."""
    skus = []
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "status",
            "searchCriteria[filterGroups][0][filters][0][value]": "1",
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[filterGroups][1][filters][0][field]": "visibility",
            "searchCriteria[filterGroups][1][filters][0][value]": "2,3,4",
            "searchCriteria[filterGroups][1][filters][0][conditionType]": "in",
            "searchCriteria[pageSize]": PAGE_SIZE,
            "searchCriteria[currentPage]": page,
        }
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/products",
            params=params,
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        items = body.get("items", [])
        skus.extend(item["sku"] for item in items)
        if len(items) < PAGE_SIZE:
            return skus
        page += 1


def price_indexer_status():
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/indexer",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    for row in r.json():
        if row.get("indexer_id") == "catalog_product_price":
            return {"code": row["indexer_id"], "status": row.get("status", "")}
    return {"code": "catalog_product_price", "status": "unknown"}


def decide_reindex_anomaly(before_skus, during_skus, after_skus, indexer_status):
    """Pure decision logic. No I/O; all inputs are pre-fetched arrays/status strings.

    Returns a dict with:
      isTransientDropDetected: bool
      missingDuringWindow: sorted list of SKUs missing between before and during
      falsePositive: bool
      recommendation: "flag_transient_index_gap" | "flag_permanent_loss" | "ok"
    """
    before_set, during_set, after_set = set(before_skus), set(during_skus), set(after_skus)
    missing = before_set - during_set
    still_missing_after = missing - after_set

    if not missing:
        return {
            "isTransientDropDetected": False,
            "missingDuringWindow": [],
            "falsePositive": len(before_skus) != len(after_skus),
            "recommendation": "ok",
        }

    reindexing = indexer_status.get("code") == "catalog_product_price" and indexer_status.get("status") in ("processing", "invalid")

    if not still_missing_after and reindexing:
        return {
            "isTransientDropDetected": True,
            "missingDuringWindow": sorted(missing),
            "falsePositive": False,
            "recommendation": "flag_transient_index_gap",
        }

    if still_missing_after:
        return {
            "isTransientDropDetected": False,
            "missingDuringWindow": sorted(missing),
            "falsePositive": False,
            "recommendation": "flag_permanent_loss",
        }

    return {
        "isTransientDropDetected": False,
        "missingDuringWindow": sorted(missing),
        "falsePositive": True,
        "recommendation": "ok",
    }


def run():
    log.info("Recording before snapshot.")
    before_skus = enabled_visible_skus()

    log.info("Waiting %ss to bracket the reindex window.", POLL_INTERVAL_SECONDS)
    time.sleep(POLL_INTERVAL_SECONDS)

    log.info("Recording during snapshot and indexer status.")
    during_skus = enabled_visible_skus()
    indexer_status = price_indexer_status()

    log.info("Waiting %ss for the reindex to finish before the after snapshot.", POLL_INTERVAL_SECONDS)
    time.sleep(POLL_INTERVAL_SECONDS)

    log.info("Recording after snapshot.")
    after_skus = enabled_visible_skus()

    result = decide_reindex_anomaly(before_skus, during_skus, after_skus, indexer_status)

    if result["recommendation"] == "ok":
        log.info("No anomaly detected. %d before, %d after.", len(before_skus), len(after_skus))
    elif result["recommendation"] == "flag_transient_index_gap":
        log.warning(
            "Transient index gap detected during catalog_product_price reindex. %d SKU(s) dipped and returned: %s",
            len(result["missingDuringWindow"]), result["missingDuringWindow"],
        )
        log.warning("This is expected, self healing batching behavior. No write performed. DRY_RUN=%s", DRY_RUN)
    elif result["recommendation"] == "flag_permanent_loss":
        log.error(
            "%d SKU(s) missing during the window and still missing after it finished: %s",
            len(result["missingDuringWindow"]), result["missingDuringWindow"],
        )
        log.error("This looks like a real removal, not a reindex race. A human should confirm before any product is re-enabled. No write performed.")

    return result


if __name__ == "__main__":
    run()
