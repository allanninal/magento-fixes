"""Detect Magento 2 or Adobe Commerce orders where the applied tax rate does
not match the address the store's own Tax Calculation Based On setting says
should have been used.

Magento resolves the applicable tax zone using the address selected by the
store-wide Tax Calculation Based On setting (Stores, Configuration, Sales,
Tax, Calculation Settings), which can be Billing Address, Shipping Address,
or Shipping Origin. For a logged-in customer with more than one saved
address, quote and order totals collection can resolve the tax class against
the customer's default address record instead of re-resolving it against the
shipping address actually selected at checkout, especially across
multi-address customers or multi-country carts. This is confirmed in
magento2 issue 38232, where a French address was taxed at 0% because the
customer's default Belgium address was used instead. The tax rule engine
itself is deterministic; the defect is an address resolution problem
upstream of rule matching, not a rule configuration error.

This script never rewrites tax_amount on a placed order, since there is no
supported REST endpoint for that. It independently computes the expected
rate for the address the store's based_on setting points at, compares it to
what the order actually applied, and separately flags any order whose
shipping address customer_address_id differs from the customer's own
default_shipping or default_billing id, the highest risk signature of this
leak. It writes a report row for every order it flags and exits non-zero so
CI or alerting notices. A human reconciles a confirmed mismatch with a
credit memo to refund the wrong tax line, followed by a corrected invoice.
Only with DRY_RUN=false and REPAIR_CONFIRM=true does it post a documentation
comment via /rest/V1/orders/{id}/comments; it never mutates tax or money on
its own. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/tax-rate-wrong-for-shipping-address/
"""
import os
import csv
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_tax_address_mismatch")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD", "change-me")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
ORDER_IDS = [o.strip() for o in os.environ.get("ORDER_IDS", "").split(",") if o.strip()]
RATE_EPSILON = float(os.environ.get("RATE_EPSILON", "0.05"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPAIR_CONFIRM = os.environ.get("REPAIR_CONFIRM", "false").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "tax_address_mismatches.csv")
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


def get_store_tax_based_on(token):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/store/storeConfigs",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    configs = r.json()
    first = configs[0] if configs else {}
    return (first.get("extension_attributes", {}) or {}).get(
        "tax_calculation_based_on", "shipping"
    )


def get_order(token, order_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/orders/{order_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_customer(token, customer_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/customers/{customer_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def search_all(token, path, page_size=PAGE_SIZE):
    items = []
    page = 1
    while True:
        params = {
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        batch = body.get("items", [])
        items.extend(batch)
        if len(batch) < page_size:
            return items
        page += 1


def get_tax_rules(token):
    return search_all(token, "taxRules/search")


def get_tax_rates(token):
    return search_all(token, "taxRates/search")


def post_order_comment(token, order_id, message):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/orders/{order_id}/comments",
        json={"statusHistory": {"comment": message, "isVisibleOnFront": 0}},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _rate_matches_address(rate, address):
    if str(rate.get("tax_country_id")) != str(address.get("country_id")):
        return False
    region_id = rate.get("tax_region_id")
    if region_id not in (None, 0, "0") and str(region_id) != str(address.get("region_id")):
        return False
    postcode = rate.get("tax_postcode") or "*"
    if postcode in ("*", ""):
        return True
    if "-" in postcode:
        lo, hi = postcode.split("-", 1)
        pc = address.get("postcode") or ""
        return lo <= pc <= hi
    return postcode == address.get("postcode")


def expected_tax_rate(resolved_address, customer_tax_class_id, product_tax_class_id, tax_rules, tax_rates):
    """Pure function. Resolves the expected tax rate for a given address,
    customer tax class, and product tax class against fixture rule/rate
    tables. No I/O, fully unit-testable.

    resolvedAddress: {country_id, region_id, postcode}
    Returns: {expectedRate, matchedRuleId}
    """
    rates_by_id = {r["id"]: r for r in tax_rates}

    candidate_rules = [
        rule for rule in tax_rules
        if customer_tax_class_id in (rule.get("customer_tax_class_ids") or [])
        and product_tax_class_id in (rule.get("product_tax_class_ids") or [])
    ]
    candidate_rules.sort(key=lambda rule: rule.get("priority", 0))

    for rule in candidate_rules:
        matched_rate_total = 0.0
        matched_any = False
        for rate_id in rule.get("tax_rate_ids") or []:
            rate = rates_by_id.get(rate_id)
            if not rate:
                continue
            if _rate_matches_address(rate, resolved_address):
                matched_rate_total += float(rate.get("rate", 0) or 0)
                matched_any = True
        if matched_any:
            return {"expectedRate": matched_rate_total, "matchedRuleId": rule.get("id")}

    return {"expectedRate": 0.0, "matchedRuleId": None}


def detect_tax_mismatch(order_actual_rate, expected_result, epsilon=RATE_EPSILON):
    delta = abs(order_actual_rate - expected_result["expectedRate"])
    return {
        "isMismatch": delta > epsilon,
        "expectedRate": expected_result["expectedRate"],
        "actualRate": order_actual_rate,
        "delta": round(delta, 4),
        "matchedRuleId": expected_result["matchedRuleId"],
    }


def is_default_address_leak(shipping_customer_address_id, default_shipping_id, default_billing_id):
    if shipping_customer_address_id is None:
        return False
    return (
        str(shipping_customer_address_id) != str(default_shipping_id)
        and str(shipping_customer_address_id) != str(default_billing_id)
    )


def resolved_address_for_order(order, based_on):
    ext = order.get("extension_attributes", {}) or {}
    assignments = ext.get("shipping_assignments") or []
    shipping_address = {}
    if assignments:
        shipping_address = (assignments[0].get("shipping") or {}).get("address") or {}
    billing_address = order.get("billing_address") or {}
    if based_on == "billing":
        return billing_address
    return shipping_address


def order_actual_rate(order):
    applied = order.get("applied_taxes") or []
    if applied:
        return float(applied[0].get("percent", applied[0].get("rate", 0)) or 0)
    items = order.get("items") or []
    for item in items:
        if item.get("tax_percent") is not None:
            return float(item["tax_percent"])
    return 0.0


def build_report_row(order, mismatch, leak):
    return {
        "order_id": order.get("entity_id"),
        "increment_id": order.get("increment_id"),
        "expected_rate": mismatch["expectedRate"],
        "actual_rate": mismatch["actualRate"],
        "delta": mismatch["delta"],
        "matched_rule_id": mismatch["matchedRuleId"],
        "default_address_leak": leak,
    }


def run():
    token = get_token()
    based_on = get_store_tax_based_on(token)
    tax_rules = get_tax_rules(token)
    tax_rates = get_tax_rates(token)
    flagged = []

    for order_id in ORDER_IDS:
        order = get_order(token, order_id)
        address = resolved_address_for_order(order, based_on)
        if not address:
            continue

        customer_tax_class_id = order.get("customer_tax_class_id")
        items = order.get("items") or []
        product_tax_class_id = items[0].get("tax_class_id") if items else None

        expected = expected_tax_rate(address, customer_tax_class_id, product_tax_class_id, tax_rules, tax_rates)
        actual_rate = order_actual_rate(order)
        mismatch = detect_tax_mismatch(actual_rate, expected)

        customer_id = order.get("customer_id")
        leak = False
        if customer_id:
            customer = get_customer(token, customer_id)
            ext = order.get("extension_attributes", {}) or {}
            assignments = ext.get("shipping_assignments") or []
            shipping_customer_address_id = None
            if assignments:
                shipping_customer_address_id = (assignments[0].get("shipping") or {}).get("address", {}).get("customer_address_id")
            leak = is_default_address_leak(
                shipping_customer_address_id,
                customer.get("default_shipping"),
                customer.get("default_billing"),
            )

        if not mismatch["isMismatch"] and not leak:
            continue

        row = build_report_row(order, mismatch, leak)
        flagged.append(row)
        log.warning(
            "Order %s tax mismatch: expected_rate=%s actual_rate=%s delta=%s default_address_leak=%s",
            row["increment_id"], row["expected_rate"], row["actual_rate"], row["delta"], row["default_address_leak"],
        )

        if not DRY_RUN and REPAIR_CONFIRM:
            post_order_comment(
                token, order_id,
                f"Tax review: expected rate {row['expected_rate']}%, applied rate {row['actual_rate']}%, "
                f"delta {row['delta']}. Possible default-address leak: {row['default_address_leak']}. "
                "Flagged for finance review; no tax or money was changed automatically.",
            )

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=[
                "order_id", "increment_id", "expected_rate", "actual_rate", "delta",
                "matched_rule_id", "default_address_leak",
            ])
            writer.writeheader()
            writer.writerows(flagged)
        log.info("Wrote report to %s%s", OUTPUT_CSV, "" if not DRY_RUN else " (dry run, report only)")

    log.info("Done. %d order(s) flagged with a tax or address mismatch.", len(flagged))
    return flagged


if __name__ == "__main__":
    flagged_orders = run()
    sys.exit(1 if flagged_orders else 0)
