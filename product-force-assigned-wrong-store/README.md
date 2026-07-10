# Product silently reassigned to the wrong store on save

`Magento\Catalog\Model\ProductRepository::save()` runs an internal `assignProductToWebsites()` step on every save. When the save context resolves to the admin store code, common for CLI scripts, cron-triggered imports, custom `catalog_product_save_after` observers, or REST calls that skip an explicit store scope, this step can force-assign the product only to the default website instead of preserving its existing `website_ids`, silently overwriting the `catalog_product_website` table. This has been reported independently for direct `ProductRepository::save()` PHP calls and for REST `PUT /V1/products/{sku}` updates.

This script reads the actual `website_ids` for each SKU in an expected mapping you maintain outside Magento, compares them with `decideWebsiteDrift`, and by default only reports the drift as: expected, actual, missing ids, unexpected ids, and whether it matches the `likelyForcedDefault` signature. Only when the drift is a pure lost assignment, missing ids with nothing unexpected, does it call `POST /V1/products/{sku}/websites` to add each missing id back, and only under an explicit `DRY_RUN=false` operator override. It never calls the `DELETE /V1/products/{sku}/websites/{websiteId}` endpoint, since a false-positive removal could take a product off a live storefront.

**Full guide with diagrams:** https://www.allanninal.dev/magento/product-force-assigned-wrong-store/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export ADMIN_STORE_CODE="admin"
export STORE_CONTEXT_CODE="admin"
export EXPECTED_WEBSITES_JSON='{"SKU-1": [1, 2], "SKU-2": [1, 3]}'
export DRY_RUN="true"

python product-force-assigned-wrong-store/python/repair_website_drift.py
node   product-force-assigned-wrong-store/node/repair-website-drift.js
```

`decide_website_drift` / `decideWebsiteDrift` is a pure function: it takes the actual website ids, the expected website ids, and the store context code the save ran under, and returns `{ isDrifted, missing, unexpected, likelyForcedDefault }`. It does no I/O, so it needs no network, no database, and no Magento store to test. The REST reads and the repair path both live behind `run()`, so importing the module never requires credentials. Start with `DRY_RUN=true` to review the list first, and treat any SKU with an unexpected website id as a flag for a human, not something the script should touch.

## Test

```bash
pytest product-force-assigned-wrong-store/python
node --test product-force-assigned-wrong-store/node
```
