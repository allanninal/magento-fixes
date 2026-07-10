"""Detect a stuck Magento 2 or Adobe Commerce catalogrule_apply_all lock.

catalogrule_apply_all recalculates catalog price rule prices and invalidates
catalog_product_price and catalogsearch_fulltext for every store view. A new
store view with an incomplete locale or timezone setup, or a rule whose
catalogrule_product relationship has not been built yet, can make the job
throw and exit non zero. Magento's scheduler then treats the lock as still
held, so indexer_reindex_all_invalid and indexer_update_all_views cannot
acquire it and stop running for every store. This script compares the
expected rule discounted price to the live storefront price, and separately
checks cron_schedule for error or stale running rows on the relevant job
codes. It never forces catalogrule_apply_all, a reindex, or a cron_schedule
write itself: that is CLI and database operator territory. Safe to run
again and again.

Guide: https://www.allanninal.dev/magento/catalog-price-rule-cron-blocks-indexers/
"""
import os
import json
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_stuck_catalog_rule")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
STORE_CODES = [s.strip() for s in os.environ.get("STORE_CODES", "default").split(",") if s.strip()]
LOCK_TIMEOUT_MINUTES = float(os.environ.get("LOCK_TIMEOUT_MINUTES", "15"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_JSON = os.environ.get("OUTPUT_JSON", "stuck_catalog_rule_report.json")

# Rules and cron rows are supplied by the operator: there is no public
# /V1/catalogRule REST endpoint, and cron_schedule is a database table with
# no REST route. Populate these from your own Admin/DB access, or wire in
# your own fetchers where noted in run() below.
RULES = json.loads(os.environ.get("RULES_JSON", "[]"))
CRON_ROWS = json.loads(os.environ.get("CRON_ROWS_JSON", "[]"))
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]

STUCK_JOB_CODES = {"catalogrule_apply_all", "indexer_reindex_all_invalid", "indexer_update_all_views"}


def get_token():
    if ADMIN_TOKEN:
        return ADMIN_TOKEN
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/integration/admin/token",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def base_price(token, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["price"]


def live_price(token, store_code, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/{store_code}/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["price"]


def _expected_price(base, rule):
    if rule["simpleAction"] == "by_percent":
        return base * (1 - rule["discountAmount"] / 100)
    return base - rule["discountAmount"]


def _rule_active(rule, now_iso):
    if rule.get("fromDate") and now_iso < rule["fromDate"]:
        return False
    if rule.get("toDate") and now_iso > rule["toDate"]:
        return False
    return True


def _parse(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def detect_stuck_catalog_rule_pricing(rules, product_prices, cron_rows, now_iso, lock_timeout_minutes=LOCK_TIMEOUT_MINUTES):
    """Pure decision function. No network, no I/O.

    rules: [{ruleId, websiteIds, discountAmount, simpleAction, fromDate, toDate}]
    product_prices: [{sku, storeId, basePrice, livePrice}]
    cron_rows: [{jobCode, status, scheduledAt}]
    now_iso: ISO 8601 timestamp string
    """
    now = _parse(now_iso)

    affected_skus = []
    affected_rule_ids = set()
    for pp in product_prices:
        for rule in rules:
            if pp["storeId"] not in set(rule["websiteIds"]):
                continue
            if not _rule_active(rule, now_iso):
                continue
            expected = _expected_price(pp["basePrice"], rule)
            if abs(expected - pp["livePrice"]) > 0.01:
                affected_skus.append(pp["sku"])
                affected_rule_ids.add(rule["ruleId"])

    stale_cron_jobs = []
    for row in cron_rows:
        if row["jobCode"] not in STUCK_JOB_CODES:
            continue
        if row["status"] == "error":
            stale_cron_jobs.append(row["jobCode"])
        elif row["status"] == "running":
            age_minutes = (now - _parse(row["scheduledAt"])).total_seconds() / 60
            if age_minutes > lock_timeout_minutes:
                stale_cron_jobs.append(row["jobCode"])

    stuck = len(affected_skus) > 0 and len(stale_cron_jobs) > 0
    return {
        "stuck": stuck,
        "affectedSkus": sorted(set(affected_skus)),
        "affectedRuleIds": sorted(affected_rule_ids),
        "staleCronJobs": sorted(set(stale_cron_jobs)),
    }


def _store_ids(store_codes):
    # Maps configured store codes to numeric store ids for comparison against
    # rule websiteIds. Wire this to your own store code -> store id lookup,
    # for example GET /rest/V1/store/storeViews, if the codes are not the ids.
    return {code: idx + 1 for idx, code in enumerate(store_codes)}


def run():
    token = get_token()
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    product_prices = []
    for sku in SKUS:
        base = base_price(token, sku)
        for store_code, store_id in _store_ids(STORE_CODES).items():
            try:
                live = live_price(token, store_code, sku)
            except requests.HTTPError as exc:
                log.warning("Could not read live price for %s in %s: %s", sku, store_code, exc)
                continue
            product_prices.append({"sku": sku, "storeId": store_id, "basePrice": base, "livePrice": live})

    result = detect_stuck_catalog_rule_pricing(RULES, product_prices, CRON_ROWS, now_iso)

    log.info(
        "stuck=%s affectedSkus=%s affectedRuleIds=%s staleCronJobs=%s",
        result["stuck"], result["affectedSkus"], result["affectedRuleIds"], result["staleCronJobs"],
    )

    with open(OUTPUT_JSON, "w") as fh:
        json.dump(result, fh, indent=2)

    if result["stuck"] and not DRY_RUN:
        log.warning(
            "DRY_RUN is false, but this script never resets cron_schedule or forces "
            "catalogrule_apply_all itself. Review %s and, if confirmed, run the "
            "reset SQL manually with DB access.",
            OUTPUT_JSON,
        )

    log.info("Done. Report written to %s.", OUTPUT_JSON)


if __name__ == "__main__":
    run()
