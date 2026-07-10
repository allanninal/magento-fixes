"""Detect Magento 2 and Adobe Commerce coupons that are being reused past their
configured limit, safely.

Since Magento 2.4.3, coupon usage bookkeeping (salesrule_coupon.times_used,
salesrule_customer.times_used, and salesrule_coupon_usage rows) is
incremented asynchronously by the sales.rule.update.coupon.usage message
queue consumer instead of during order placement. If that consumer is not
running, lags under load, or the order crashes after the coupon is applied
but before the message is consumed, times_used never increments even though
the coupon was used on a real order, so uses_per_coupon and
uses_per_customer silently stop being enforced.

This reports every discrepancy by default. It never cancels, refunds, or
holds an order. The only gated corrective action, behind DRY_RUN=false and
--apply, recomputes times_used to match the real order count. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/coupon-usage-limit-not-enforced/
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("evaluate_coupon_usage")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
APPLY = "--apply" in sys.argv


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_put_coupon_times_used(coupon_id, times_used):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/coupons",
        json={"entity": {"coupon_id": coupon_id, "times_used": times_used}},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def active_coupon_rules(page_size=100):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "coupon_type",
        "searchCriteria[filterGroups][0][filters][0][value]": "2,3",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[filterGroups][1][filters][0][field]": "is_active",
        "searchCriteria[filterGroups][1][filters][0][value]": 1,
        "searchCriteria[pageSize]": page_size,
    }
    return magento_get("/salesRules", params)["items"]


def coupons_for_rule(rule_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "rule_id",
        "searchCriteria[filterGroups][0][filters][0][value]": rule_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/coupons", params)["items"]


def orders_for_coupon(code, page_size=100):
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
            "searchCriteria[filterGroups][0][filters][0][value]": code,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        items = magento_get("/orders", params)["items"]
        if not items:
            return
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def evaluate_coupon_usage(rule, coupon_record, real_orders):
    """Pure decision function. No network or DB calls.

    rule: {ruleId, usesPerCoupon, usesPerCustomer}
    couponRecord: {couponId, code, reportedTimesUsed}
    realOrders: list of {orderId, incrementId, customerId, state}
    """
    active = [o for o in real_orders if o.get("state") != "canceled"]
    real_total_count = len(active)

    per_customer_counts = {}
    for o in active:
        key = str(o.get("customerId")) if o.get("customerId") is not None else "guest"
        per_customer_counts[key] = per_customer_counts.get(key, 0) + 1

    uses_per_coupon = rule.get("usesPerCoupon")
    uses_per_customer = rule.get("usesPerCustomer")
    reported_times_used = coupon_record.get("reportedTimesUsed", 0)

    reason = None
    if uses_per_coupon and real_total_count > uses_per_coupon:
        reason = "per_coupon_exceeded"
    elif uses_per_customer and any(c > uses_per_customer for c in per_customer_counts.values()):
        reason = "per_customer_exceeded"
    elif reported_times_used < real_total_count:
        reason = "times_used_drift"

    allowed = uses_per_coupon if reason == "per_coupon_exceeded" else 0
    offending = [o["incrementId"] for o in active[allowed:]] if reason == "per_coupon_exceeded" else (
        [o["incrementId"] for o in active] if reason else []
    )

    return {
        "isViolation": reason is not None,
        "reason": reason,
        "realTotalCount": real_total_count,
        "perCustomerCounts": per_customer_counts,
        "offendingOrderIncrementIds": offending,
    }


def to_plain_rule(raw):
    return {
        "ruleId": raw["rule_id"],
        "usesPerCoupon": raw.get("uses_per_coupon") or None,
        "usesPerCustomer": raw.get("uses_per_customer") or None,
    }


def to_plain_coupon(raw):
    return {
        "couponId": raw["coupon_id"],
        "code": raw["code"],
        "reportedTimesUsed": raw.get("times_used") or 0,
    }


def to_plain_orders(raw_items):
    return [
        {
            "orderId": str(item["entity_id"]),
            "incrementId": item.get("increment_id", ""),
            "customerId": item.get("customer_id"),
            "state": item.get("state", ""),
        }
        for item in raw_items
    ]


def run():
    flagged = 0
    for raw_rule in active_coupon_rules():
        rule = to_plain_rule(raw_rule)
        for raw_coupon in coupons_for_rule(rule["ruleId"]):
            coupon_record = to_plain_coupon(raw_coupon)
            real_orders = to_plain_orders(list(orders_for_coupon(coupon_record["code"])))

            result = evaluate_coupon_usage(rule, coupon_record, real_orders)
            if not result["isViolation"]:
                continue

            flagged += 1
            log.warning(
                "Rule %s coupon %s (%s): reason=%s real_count=%s reported_times_used=%s "
                "uses_per_coupon=%s uses_per_customer=%s offending_orders=%s",
                rule["ruleId"], coupon_record["couponId"], coupon_record["code"],
                result["reason"], result["realTotalCount"], coupon_record["reportedTimesUsed"],
                rule["usesPerCoupon"], rule["usesPerCustomer"], result["offendingOrderIncrementIds"],
            )

            if not DRY_RUN and APPLY:
                log.warning(
                    "DRY_RUN is false and --apply is set: recomputing times_used for coupon %s "
                    "from %s to %s. Confirm sales.rule.update.coupon.usage is running so this "
                    "does not drift again.",
                    coupon_record["code"], coupon_record["reportedTimesUsed"], result["realTotalCount"],
                )
                magento_put_coupon_times_used(coupon_record["couponId"], result["realTotalCount"])

    log.info("Done. %d coupon(s) flagged.", flagged)


if __name__ == "__main__":
    run()
