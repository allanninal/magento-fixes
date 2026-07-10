# Imported products missing website assignment

A product imported by CSV or created through the REST API only becomes visible on a storefront when a row exists in `catalog_product_website` linking it to that website's id. The CSV importer skips writing that row silently when `product_websites` is blank or has a typo'd code, and `POST /V1/products` has no plain `website_ids` field at all, so a flat REST payload can create a fully valid, fully indexed product that is invisible everywhere on the site. This job lists recently updated products, reads `extension_attributes.website_ids`, confirms with the dedicated `/V1/products/{sku}/websites` endpoint, and reports every SKU with an empty assignment. It only repairs a SKU when an explicit target website id is supplied and the store has exactly one website, since the correct assignment cannot be inferred safely.

**Full guide with diagrams:** https://www.allanninal.dev/magento/imported-products-missing-website-assignment/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export UPDATED_SINCE="2026-07-01 00:00:00"
export EXPECTED_WEBSITE_IDS="1"
export TARGET_WEBSITE_ID=""   # leave empty to only report, set to repair
export DRY_RUN="true"

python imported-products-missing-website-assignment/python/find_missing_website_assignment.py
node   imported-products-missing-website-assignment/node/find-missing-website-assignment.js
```

`isMissingWebsiteAssignment` (Python: `is_missing_website_assignment`) is a pure function: it reads `extension_attributes.website_ids` from an already-fetched product, treats a missing key the same as an empty array, and returns the SKU, whether it is affected, and the expected website ids still missing. By default the script only reports affected SKUs after confirming with `GET /V1/products/{sku}/websites`. Only when `TARGET_WEBSITE_ID` is set, `DRY_RUN=false`, and `GET /V1/store/websites` shows exactly one website does it call `POST /V1/products/{sku}/websites` with `{"productWebsiteLink":{"sku":"<sku>","website_id":<id>}}` for each affected SKU, which is idempotent. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest imported-products-missing-website-assignment/python
node --test imported-products-missing-website-assignment/node
```
