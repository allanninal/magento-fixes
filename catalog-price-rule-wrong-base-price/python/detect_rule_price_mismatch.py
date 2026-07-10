"""Detect a Magento 2 or Adobe Commerce catalog price rule discounting the
wrong starting price.

The catalog price rule indexer (Magento\\CatalogRule\\Model\\Indexer\\IndexBuilder)
computes rule_price in catalogrule_product_price by applying the rule's discount
action to the product's base/website price row, rather than looking up the
customer-group-specific tier price row in catalog_product_entity_tier_price. So
a rule scoped to one customer group can discount the wrong starting amount, or
leak its discount to a customer group outside its configured customer_group_ids
scope. This script has no write path: catalog price rules have no public
catalogRule/save REST endpoint, and catalogrule_product_price rows are
indexer-generated and get overwritten on the next cron run, so directly editing
them is unsafe. It only detects and reports. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/catalog-price-rule-wrong-base-price/
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_rule_price_mismatch")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_JSON = os.environ.get("OUTPUT_JSON", "rule_price_mismatch_report.json")

# There is no public /V1/catalogRule REST endpoint, so the rule's target
# customer group and discount percent must be supplied out of band, for
# example from an admin export or a config file.
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]
RULE_CUSTOMER_GROUP_ID = int(os.environ.get("RULE_CUSTOMER_GROUP_ID", "1"))
RULE_DISCOUNT_PERCENT = float(os.environ.get("RULE_DISCOUNT_PERCENT", "10"))

ALL_GROUPS_ID = 32000


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


def tier_prices(token, skus):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/products/tier-prices-information",
        json={"skus": skus},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def actual_price(token, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    for attr in body.get("custom_attributes", []):
        if attr.get("attribute_code") == "special_price" and attr.get("value"):
            return float(attr["value"])
    return body["price"]


def evaluate_rule_price_mismatch(base_price_value, tier_prices_list, rule_customer_group_id,
                                  rule_discount_percent, actual_price_value, tolerance=0.01):
    """Pure function. No network or DB I/O.

    Resolves the qty=1 tier price row matching rule_customer_group_id (falling
    back to group 32000, ALL GROUPS, if no group-specific row exists), computes
    expected_price = tier_or_base_price * (1 - rule_discount_percent / 100),
    compares it to actual_price within tolerance, and classifies the failure as
    base_price_used when actual_price matches base_price * (1 - discount)
    instead of the tier price, or scope_leak when actual_price reflects the
    discount for a customer_group_id outside rule_customer_group_id.
    """
    starting_price = _resolve_tier_price(base_price_value, tier_prices_list, rule_customer_group_id)
    expected_price = starting_price * (1 - rule_discount_percent / 100)
    is_mismatch = abs(expected_price - actual_price_value) > tolerance

    mismatch_type = None
    if is_mismatch:
        base_discounted = base_price_value * (1 - rule_discount_percent / 100)
        if abs(actual_price_value - base_discounted) <= tolerance and abs(starting_price - base_price_value) > tolerance:
            mismatch_type = "base_price_used"
        else:
            mismatch_type = _detect_scope_leak(
                base_price_value, tier_prices_list, rule_customer_group_id, rule_discount_percent, actual_price_value, tolerance
            )

    return {
        "expectedPrice": expected_price,
        "isMismatch": is_mismatch,
        "mismatchType": mismatch_type,
    }


def _resolve_tier_price(base_price_value, tier_prices_list, rule_customer_group_id):
    qty1_rows = [tp for tp in tier_prices_list if tp.get("qty", 1) == 1]

    for tp in qty1_rows:
        if tp.get("customerGroupId") == rule_customer_group_id:
            return _apply_price_type(base_price_value, tp)

    for tp in qty1_rows:
        if tp.get("customerGroupId") == ALL_GROUPS_ID:
            return _apply_price_type(base_price_value, tp)

    return base_price_value


def _apply_price_type(base_price_value, tier_price_row):
    if tier_price_row.get("priceType") == "discount":
        return base_price_value * (1 - tier_price_row["price"] / 100)
    return tier_price_row["price"]


def _detect_scope_leak(base_price_value, tier_prices_list, rule_customer_group_id,
                        rule_discount_percent, actual_price_value, tolerance):
    qty1_rows = [tp for tp in tier_prices_list if tp.get("qty", 1) == 1]
    for tp in qty1_rows:
        other_group = tp.get("customerGroupId")
        if other_group == rule_customer_group_id:
            continue
        other_starting_price = _apply_price_type(base_price_value, tp)
        other_expected = other_starting_price * (1 - rule_discount_percent / 100)
        if abs(other_expected - actual_price_value) <= tolerance:
            return "scope_leak"
    return "base_price_used"


def run():
    token = get_token()

    if not SKUS:
        log.warning("No SKUS configured. Set SKUS to a comma separated list to check.")
        return

    tier_info = tier_prices(token, SKUS)
    tier_by_sku = {}
    for row in tier_info:
        tier_by_sku.setdefault(row["sku"], []).append({
            "customerGroupId": row.get("customer_group_id", ALL_GROUPS_ID),
            "price": row["price"],
            "priceType": row.get("price_type", "fixed"),
            "qty": row.get("qty", 1),
        })

    report = []
    for sku in SKUS:
        base = base_price(token, sku)
        rows = tier_by_sku.get(sku, [])
        actual = actual_price(token, sku)

        result = evaluate_rule_price_mismatch(
            base, rows, RULE_CUSTOMER_GROUP_ID, RULE_DISCOUNT_PERCENT, actual
        )

        if result["isMismatch"]:
            entry = {
                "sku": sku,
                "customerGroupId": RULE_CUSTOMER_GROUP_ID,
                "expectedPrice": round(result["expectedPrice"], 2),
                "actualPrice": actual,
                "delta": round(actual - result["expectedPrice"], 2),
                "mismatchType": result["mismatchType"],
            }
            report.append(entry)
            log.warning(
                "MISMATCH sku=%s group=%s expected=%.2f actual=%.2f type=%s",
                sku, RULE_CUSTOMER_GROUP_ID, result["expectedPrice"], actual, result["mismatchType"],
            )

    with open(OUTPUT_JSON, "w") as fh:
        json.dump(report, fh, indent=2)

    if report and not DRY_RUN:
        log.warning(
            "DRY_RUN is false, but this script never rewrites catalog price rules or "
            "catalogrule_product_price rows itself. Review %s and, if confirmed, re-save "
            "the rule scoped strictly to the intended customer group(s)/websites, then run "
            "bin/magento indexer:reindex catalogrule_rule catalogrule_product catalog_product_price.",
            OUTPUT_JSON,
        )

    log.info("Done. %d mismatch(es) written to %s.", len(report), OUTPUT_JSON)


if __name__ == "__main__":
    run()
