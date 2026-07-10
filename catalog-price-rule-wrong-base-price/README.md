# Catalog price rule discounts base price instead of group price

The catalog price rule indexer (`Magento\CatalogRule\Model\Indexer\IndexBuilder`) computes `rule_price` in `catalogrule_product_price` by applying the rule's discount action to the product's base/website price row, rather than looking up the customer-group-specific tier price row in `catalog_product_entity_tier_price`. So a rule scoped to one customer group can discount the wrong starting amount, or leak its discount to a customer group outside its configured `customer_group_ids` scope.

This script has no write path. Catalog price rules have no public `catalogRule/save` REST endpoint, and `catalogrule_product_price` rows are indexer-generated and get overwritten on the next cron run, so directly editing them is unsafe. It reads each SKU's base price, tier prices, and actual price, computes the expected price from the tier price applicable to the rule's target customer group, and reports any SKU where the actual price matches the base price discounted instead, or where the discount leaked to a group outside the rule's scope.

**Full guide with diagrams:** https://www.allanninal.dev/magento/catalog-price-rule-wrong-base-price/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export SKUS="SKU-1,SKU-2"
export RULE_CUSTOMER_GROUP_ID="3"
export RULE_DISCOUNT_PERCENT="10"
export DRY_RUN="true"

python catalog-price-rule-wrong-base-price/python/detect_rule_price_mismatch.py
node   catalog-price-rule-wrong-base-price/node/detect-rule-price-mismatch.js
```

`evaluate_rule_price_mismatch` / `evaluateRulePriceMismatch` is a pure function: given the base price, the tier price rows (customer group id, price, price type, qty) fetched from `POST /rest/V1/products/tier-prices-information`, the rule's target customer group id and discount percent, and the actual price, it resolves the qty=1 tier price row matching the rule's customer group (falling back to group 32000, ALL GROUPS, if no group-specific row exists), computes `expectedPrice = tierOrBasePrice * (1 - discountPercent / 100)`, and compares it to the actual price within a one cent tolerance. A mismatch is classified as `base_price_used` when the actual price matches the base price discounted instead of the tier price, or `scope_leak` when the actual price reflects the discount for a different customer group.

The catalog price rule itself has no REST endpoint, so `RULE_CUSTOMER_GROUP_ID` and `RULE_DISCOUNT_PERCENT` must be supplied out of band, for example from an admin export or a config file. The script only ever reports. If mismatches are found, the fix is to re-save the catalog price rule scoped strictly to the intended customer group(s) and websites, then run `bin/magento indexer:reindex catalogrule_rule catalogrule_product catalog_product_price` outside REST to force a full, non-partial reindex.

## Test

```bash
pytest catalog-price-rule-wrong-base-price/python
node --test catalog-price-rule-wrong-base-price/node
```
