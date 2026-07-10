"""Reconcile Magento 2 or Adobe Commerce coupon usage against real orders.

CouponUsagesIncrement hooks beforeSubmit on QuoteManagement and commits
usage counters to salesrule_coupon, salesrule_coupon_usage, and
salesrule_customer before the nested submitQuote call actually validates
the cart and creates the order. If that validation throws, for example a
minimum order amount check fails, the order is never created but the
usage increment already committed. There is no REST endpoint that
decrements these counters, so this script only ever reads coupons and
orders and writes a JSON report of orphaned usage for a human to review.

Guide: https://www.allanninal.dev/magento/coupon-marked-used-without-order/

Safe to run again and again.
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_coupon_usage")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
COUPON_CODES = [c.strip() for c in os.environ.get("COUPON_CODES", "").split(",") if c.strip()]
EXCLUDED_STATES = [s.strip() for s in os.environ.get("EXCLUDED_STATES", "canceled").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_JSON = os.environ.get("OUTPUT_JSON", "orphaned_coupon_usage.json")
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))


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


def fetch_coupon(token, code):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "code",
        "searchCriteria[filterGroups][0][filters][0][value]": code,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/salesRules/coupons/search",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    items = r.json().get("items", [])
    return items[0] if items else None


def orders_for_coupon(token, code, page_size=PAGE_SIZE):
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
            "searchCriteria[filterGroups][0][filters][0][value]": code,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/orders",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        items = r.json().get("items", [])
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def compute_orphaned_coupon_usages(coupons, orders_by_coupon_code, excluded_states=("canceled",)):
    """Pure decision logic (no I/O): for each coupon, count real, non-excluded-state
    orders that reference its code, subtract from the recorded times_used counter,
    and flag any positive remainder as orphaned (usage recorded but no corresponding
    valid order).
    """
    results = []
    for c in coupons:
        orders = orders_by_coupon_code.get(c["code"], [])
        actual_order_count = sum(1 for o in orders if o.get("state") not in excluded_states)
        orphaned_count = max(0, c["timesUsed"] - actual_order_count)
        if orphaned_count > 0:
            results.append({
                "couponId": c["couponId"],
                "code": c["code"],
                "timesUsed": c["timesUsed"],
                "actualOrderCount": actual_order_count,
                "orphanedCount": orphaned_count,
            })
    return results


def write_report(rows, path):
    with open(path, "w") as fh:
        json.dump(rows, fh, indent=2)


def run():
    token = get_token()
    coupons = []
    orders_by_code = {}
    for code in COUPON_CODES:
        coupon = fetch_coupon(token, code)
        if coupon is None:
            log.warning("Coupon code %s not found, skipping.", code)
            continue
        coupons.append({
            "couponId": coupon["coupon_id"],
            "ruleId": coupon["rule_id"],
            "code": coupon["code"],
            "timesUsed": coupon["times_used"],
        })
        orders_by_code[code] = [
            {"entityId": o.get("entity_id"), "incrementId": o.get("increment_id"), "state": o.get("state")}
            for o in orders_for_coupon(token, code)
        ]

    orphaned = compute_orphaned_coupon_usages(coupons, orders_by_code, EXCLUDED_STATES)

    for row in orphaned:
        log.info(
            "Coupon %s: times_used=%s actual_orders=%s orphaned=%s",
            row["code"], row["timesUsed"], row["actualOrderCount"], row["orphanedCount"],
        )

    if orphaned:
        write_report(orphaned, OUTPUT_JSON)

    log.info(
        "Done. %d coupon(s) with orphaned usage. %s",
        len(orphaned),
        "DRY_RUN=%s. This script only reads and reports; no database write happens either way." % DRY_RUN,
    )


if __name__ == "__main__":
    run()
