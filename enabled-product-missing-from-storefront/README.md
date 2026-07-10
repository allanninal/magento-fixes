# Enabled product missing from storefront

A Magento 2 product can show Enabled in the admin grid and still be invisible on the storefront, because status is only one of several conditions Magento checks. Visibility has to include catalog or search, the product has to carry the storefront's `website_id` in its website assignment, and it has to link to at least one category that is itself active. Even when all three agree in the database, a stale or invalid indexer (`catalog_category_product`, `catalog_product_index`, `catalogsearch_fulltext`) or a missed cron run can still hide it. This script checks each condition over the REST API and reports which one is failing, or flags the SKU as an indexer/cron suspect when the data says it should be eligible but the storefront still does not show it.

**Full guide with diagrams:** https://www.allanninal.dev/magento/enabled-product-missing-from-storefront/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export TARGET_WEBSITE_ID="1"
export TARGET_SKUS="sku-one,sku-two"
export DRY_RUN="true"

python enabled-product-missing-from-storefront/python/diagnose_missing_product.py
node   enabled-product-missing-from-storefront/node/diagnose-missing-product.js
```

`decide_storefront_eligibility` / `decideStorefrontEligibility` is a pure function: a product is eligible only when it is enabled, its visibility is not "Not Visible Individually", it carries the target website id, and at least one linked category is active. Otherwise it returns every failing reason, so a "genuinely ineligible" SKU can be told apart from one where the data looks correct but the storefront still disagrees, which points at a stale indexer or cron instead. Repairs (status, visibility, website assignment) only run when `DRY_RUN=false`, and always send the full `extension_attributes.website_ids` array rather than a partial one, since omitting it is the documented cause of websites being silently reassigned or dropped.

## Test

```bash
pytest enabled-product-missing-from-storefront/python
node --test enabled-product-missing-from-storefront/node
```
