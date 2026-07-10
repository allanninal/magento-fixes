# Catalog price rule cron failure blocks downstream indexers

The daily `catalogrule_apply_all` cron recalculates catalog price rule prices and invalidates `catalog_product_price` and `catalogsearch_fulltext` for every store view. A new store view with an incomplete locale or timezone setup, or a rule whose `catalogrule_product` relationship has not been built yet, can make that job throw and exit non zero. Magento's scheduler then treats the lock as still held, so `indexer_reindex_all_invalid` and `indexer_update_all_views` cannot acquire it and stop running for every store, not only the new one.

This script compares the expected catalog price rule discount to the live storefront price per SKU and store, and separately checks `cron_schedule` for error or stale running rows on the three job codes involved. It reports by default and never forces `catalogrule_apply_all`, a reindex, or a `cron_schedule` write itself, since those are CLI and database operator operations with no public REST endpoint.

**Full guide with diagrams:** https://www.allanninal.dev/magento/catalog-price-rule-cron-blocks-indexers/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export STORE_CODES="default,eu_de"
export LOCK_TIMEOUT_MINUTES="15"
export SKUS="SKU-1,SKU-2"
export RULES_JSON='[{"ruleId":7,"websiteIds":[1,2],"discountAmount":20,"simpleAction":"by_percent","fromDate":null,"toDate":null}]'
export CRON_ROWS_JSON='[{"jobCode":"catalogrule_apply_all","status":"error","scheduledAt":"2026-07-10T00:00:00Z"}]'
export DRY_RUN="true"

python catalog-price-rule-cron-blocks-indexers/python/detect_stuck_catalog_rule.py
node   catalog-price-rule-cron-blocks-indexers/node/detect-stuck-catalog-rule.js
```

`detect_stuck_catalog_rule_pricing` / `detectStuckCatalogRulePricing` is a pure function: given the active rules, the fetched base and live prices per SKU and store, and the `cron_schedule` rows for `catalogrule_apply_all`, `indexer_reindex_all_invalid`, and `indexer_update_all_views`, it computes the expected discounted price for each applicable rule, flags SKUs where that disagrees with the live price by more than a cent, separately flags cron rows in `error` or stuck `running` past `LOCK_TIMEOUT_MINUTES`, and only calls the situation `stuck` when both a price mismatch and a stale cron job are present.

The script only ever reports, by design. Resetting the specific stuck `cron_schedule` rows to `missed` is a narrowly scoped, reversible SQL statement an operator runs manually with database access after reading the report, never something this script performs itself.

## Test

```bash
pytest catalog-price-rule-cron-blocks-indexers/python
node --test catalog-price-rule-cron-blocks-indexers/node
```
