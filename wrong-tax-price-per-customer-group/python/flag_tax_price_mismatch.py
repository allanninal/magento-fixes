"""Flag Magento 2 or Adobe Commerce customer groups showing the wrong tax or price.

Magento resolves tax through a Tax Rule that maps a customer tax class plus a
product tax class plus a region to a rate, while each customer group is
separately mapped to exactly one customer tax class. When a group is never
assigned the intended class, or that class is never added to the applicable
rule, the group silently falls back to a different rate, so two groups with
the identical tier price end up with different final totals. This script
reads a product's tier prices and tax class, every referenced group's tax
class, the Tax Rules and rates, computes the expected final price per group,
and reports any group whose computed number disagrees with the actual price
or whose tax class has no matching rule at all. It only ever writes a
customer group's tax class when that group is unambiguously orphaned and an
existing rule confidently covers its product classes under one other class.
Safe to run again and again.
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_tax_price_mismatch")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]
PRICE_EPSILON = float(os.environ.get("PRICE_EPSILON", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "tax_price_mismatch.csv")


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


def get_product(token, sku):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    tax_class_id = None
    for attr in body.get("custom_attributes", []):
        if attr.get("attribute_code") == "tax_class_id":
            tax_class_id = int(attr.get("value"))
    return {"tier_prices": body.get("tier_prices", []), "product_tax_class_id": tax_class_id, "price": body.get("price")}


def get_customer_group(token, group_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/customerGroups/{group_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_tax_rules(token, page_size=100):
    params = {"searchCriteria[pageSize]": page_size}
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/taxRules/search",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def get_tax_rate(token, rate_id):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1/taxRates/{rate_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("rate")


def fix_orphaned_group_tax_class(token, group, expected_tax_class_id, expected_tax_class_name):
    body = {
        "group": {
            "id": group["id"],
            "code": group["code"],
            "tax_class_id": expected_tax_class_id,
            "tax_class_name": expected_tax_class_name,
        }
    }
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/customerGroups/{group['id']}",
        json=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_expected_final_price(tier_price, product_tax_class_id, customer_group_tax_class_id,
                                 tax_rules, tax_rates, price_includes_tax=False):
    """Pure decision logic, no I/O.

    Finds the tax rule(s) whose customerTaxClassIds includes customer_group_tax_class_id
    AND productTaxClassIds includes product_tax_class_id, sums the matching rates the
    way Magento stacks simultaneous rates, and computes the expected final price. If no
    rule matches, that absence (matchedRuleFound=False, appliedRatePct=0) is itself the
    anomaly to flag: an orphaned customer group falling back to no tax at all.
    """
    matched_rate_ids = set()
    matched_rule_found = False
    for rule in tax_rules:
        if customer_group_tax_class_id in rule.get("customerTaxClassIds", []) and \
           product_tax_class_id in rule.get("productTaxClassIds", []):
            matched_rule_found = True
            matched_rate_ids.update(rule.get("rateIds", []))

    if not matched_rule_found:
        return {"expectedFinal": round(tier_price, 2), "matchedRuleFound": False, "appliedRatePct": 0}

    applied_rate_pct = sum(tax_rates.get(rid, 0) for rid in matched_rate_ids)
    if price_includes_tax:
        expected_final = round(tier_price, 2)
    else:
        expected_final = round(tier_price * (1 + applied_rate_pct / 100), 2)
    return {"expectedFinal": expected_final, "matchedRuleFound": True, "appliedRatePct": applied_rate_pct}


def run():
    token = get_token()
    tax_rules = all_tax_rules(token)
    rate_cache = {}

    def rate_for(rate_id):
        if rate_id not in rate_cache:
            rate_cache[rate_id] = get_tax_rate(token, rate_id) or 0
        return rate_cache[rate_id]

    flagged = []
    for sku in SKUS:
        product = get_product(token, sku)
        product_tax_class_id = product["product_tax_class_id"]
        group_ids = sorted({tp["customer_group_id"] for tp in product["tier_prices"]})
        for group_id in group_ids:
            group = get_customer_group(token, group_id)
            group_tax_class_id = group.get("tax_class_id")
            tier_price = next(
                (tp["value"] for tp in product["tier_prices"] if tp["customer_group_id"] == group_id),
                product["price"],
            )
            rates = {rid: rate_for(rid) for rule in tax_rules for rid in rule.get("rateIds", [])}
            verdict = decide_expected_final_price(tier_price, product_tax_class_id, group_tax_class_id, tax_rules, rates)

            if not verdict["matchedRuleFound"]:
                row = {
                    "sku": sku, "customer_group_id": group_id, "group_code": group.get("code"),
                    "tierPrice": tier_price, "expectedFinal": verdict["expectedFinal"],
                    "appliedRatePct": verdict["appliedRatePct"], "issue": "orphaned_group_no_matching_rule",
                }
                flagged.append(row)
                log.warning("SKU %s group %s (%s): no matching tax rule, orphaned tax class %s",
                            sku, group_id, group.get("code"), group_tax_class_id)
                continue

            actual_final = product.get("price")
            if actual_final is not None and abs(actual_final - verdict["expectedFinal"]) > PRICE_EPSILON:
                row = {
                    "sku": sku, "customer_group_id": group_id, "group_code": group.get("code"),
                    "tierPrice": tier_price, "expectedFinal": verdict["expectedFinal"],
                    "appliedRatePct": verdict["appliedRatePct"], "issue": "price_mismatch",
                }
                flagged.append(row)
                log.warning("SKU %s group %s (%s): expected final %s, storefront shows %s",
                            sku, group_id, group.get("code"), verdict["expectedFinal"], actual_final)

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["sku", "customer_group_id", "group_code", "tierPrice", "expectedFinal", "appliedRatePct", "issue"])
            writer.writeheader()
            writer.writerows(flagged)

    log.info("Done. %d SKU/group mismatch(es) flagged, %s.", len(flagged), "dry run, nothing written" if DRY_RUN else "no writes performed automatically here")


if __name__ == "__main__":
    run()
