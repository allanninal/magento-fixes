"""Detect Magento 2 products that flap out of category or search results during
a scheduled reindex, and tell flapping (transient, self healing) apart from
stuck (worth escalating). Never writes to the index. Run on a schedule during
a known reindex window. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/products-flap-during-scheduled-indexing/
"""
import os
import time
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_flapping_products")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CATEGORY_IDS = [c for c in os.environ.get("WATCH_CATEGORY_IDS", "").split(",") if c]
SEARCH_TERMS = [t for t in os.environ.get("WATCH_SEARCH_TERMS", "").split(",") if t]
POLL_INTERVAL_SEC = float(os.environ.get("POLL_INTERVAL_SEC", "8"))
POLL_COUNT = int(os.environ.get("POLL_COUNT", "6"))
CRON_INTERVAL_SEC = int(os.environ.get("CRON_INTERVAL_SEC", "60"))


def get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def put(path, body):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def baseline_skus():
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][value]": "1",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": "200",
    }
    data = get("products", params)
    return {item["sku"] for item in data.get("items", [])}


def category_skus(category_id):
    data = get(f"categories/{category_id}/products")
    return {row["sku"] for row in data}


def search_skus(name_like):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "name",
        "searchCriteria[filterGroups][0][filters][0][value]": f"%{name_like}%",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "like",
        "searchCriteria[pageSize]": "200",
    }
    data = get("products", params)
    return {item["sku"] for item in data.get("items", [])}


def is_product_flapping(baseline_skus, current_category_skus, current_search_skus,
                         previous_missing, now_ts, cron_interval_sec=60):
    """Pure decision function. No I/O.

    baseline_skus: set of SKUs expected to be enabled and visible.
    current_category_skus: set of SKUs currently returned by category listing(s).
    current_search_skus: set of SKUs currently returned by the search-equivalent query.
    previous_missing: dict of sku -> timestamp it was first seen missing.
    now_ts: current unix timestamp.
    cron_interval_sec: how often the scheduled indexer cron runs, default 60s.

    Returns {flapping, stuck, missing_from_category, missing_from_search}.
    """
    missing_from_category = baseline_skus - current_category_skus
    missing_from_search = baseline_skus - current_search_skus
    missing_now = missing_from_category | missing_from_search

    flapping = set()
    stuck = set()
    for sku in missing_now:
        first_seen_ts = previous_missing.get(sku, now_ts)
        missing_for = now_ts - first_seen_ts
        if missing_for > cron_interval_sec * 3:
            stuck.add(sku)
        else:
            flapping.add(sku)

    return {
        "flapping": flapping,
        "stuck": stuck,
        "missing_from_category": missing_from_category,
        "missing_from_search": missing_from_search,
    }


def advance_missing_tracker(previous_missing, missing_now, now_ts):
    """Pure helper. Carries forward first-missing timestamps for SKUs still
    missing, and drops entries for SKUs that recovered."""
    updated = {}
    for sku in missing_now:
        updated[sku] = previous_missing.get(sku, now_ts)
    return updated


def reaffirm_product(sku, status):
    """No-op safe write: re-affirms the product's existing status so it is
    written back into the next changelog batch. Only called when DRY_RUN is
    explicitly turned off."""
    body = {"product": {"sku": sku, "status": status}}
    return put(f"products/{sku}", body)


def run():
    baseline = baseline_skus()
    log.info("Baseline has %d enabled, visible product(s).", len(baseline))

    previous_missing = {}
    stuck_reported = set()

    for poll_n in range(POLL_COUNT):
        now_ts = time.time()

        current_category = set()
        for category_id in CATEGORY_IDS:
            current_category |= category_skus(category_id)
        current_search = set()
        for term in SEARCH_TERMS:
            current_search |= search_skus(term)

        # If no categories or terms were configured, treat that side as fully present
        # so the check does not falsely flag everything as missing.
        current_category_effective = current_category if CATEGORY_IDS else set(baseline)
        current_search_effective = current_search if SEARCH_TERMS else set(baseline)

        result = is_product_flapping(
            baseline, current_category_effective, current_search_effective,
            previous_missing, now_ts, CRON_INTERVAL_SEC,
        )

        for sku in result["flapping"]:
            log.info("Poll %d: %s is flapping (transient, expected to self heal).", poll_n, sku)

        for sku in result["stuck"]:
            if sku in stuck_reported:
                continue
            log.warning("Poll %d: %s is stuck missing for over %ds. Check indexer:show-mode "
                        "and reindex catalogsearch_fulltext catalog_category_product.",
                        poll_n, sku, CRON_INTERVAL_SEC * 3)
            stuck_reported.add(sku)
            if not DRY_RUN:
                log.info("DRY_RUN is off: re-affirming %s status=1 as a no-op workaround.", sku)
                reaffirm_product(sku, 1)

        missing_now = result["missing_from_category"] | result["missing_from_search"]
        previous_missing = advance_missing_tracker(previous_missing, missing_now, now_ts)

        if poll_n < POLL_COUNT - 1:
            time.sleep(POLL_INTERVAL_SEC)

    log.info("Done. %d SKU(s) stuck across the polling window.", len(stuck_reported))


if __name__ == "__main__":
    run()
