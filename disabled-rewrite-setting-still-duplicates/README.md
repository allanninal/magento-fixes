# Disabling rewrite setting still creates duplicate rewrites

Turning Catalog, Search Engine Optimization, Generate category/product URL Rewrites to No is supposed to stop products from getting a second, category-prefixed rewrite. It does not. `ProductProcessUrlRewriteSavingObserver` writes a plain product rewrite on every product save regardless of the setting, while `CategoryProcessUrlRewriteSavingObserver` and `CanonicalUrlRewriteGenerator` can still write a category-prefixed rewrite for the same product on a category save. This is a confirmed core bug (`magento/magento2` issues 38317 and 39070), not a misconfiguration.

This script resolves each product id to a SKU over REST, reads that product's `url_rewrite` rows from a read-only export or admin-exposed rewrite list (`url_rewrite` has no public REST search endpoint), flags the duplicate pairs, and only performs a guarded delete of the redundant row when `--apply` is explicitly passed.

**Full guide with diagrams:** https://www.allanninal.dev/magento/disabled-rewrite-setting-still-duplicates/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export GENERATE_CATEGORY_PRODUCT_REWRITES="false"
export PRODUCT_IDS="42,99"
export URL_REWRITE_EXPORT_CSV="url_rewrite_export.csv"
export DRY_RUN="true"

python disabled-rewrite-setting-still-duplicates/python/disabled_rewrite_setting_still_duplicates.py
node   disabled-rewrite-setting-still-duplicates/node/disabled-rewrite-setting-still-duplicates.js
```

`find_duplicate_product_rewrites` is a pure function: it groups a product's `url_rewrite` rows by store and target path, and flags a pair only when the setting is off and one `request_path` is category-prefixed next to a shorter, plain one. It never assumes a delete is safe. Report only by default; a delete only happens with both `DRY_RUN=false` and `--apply`, and the row matching the product's current `url_key` (the one serving live traffic) is never removed.

## Test

```bash
pytest disabled-rewrite-setting-still-duplicates/python
node --test disabled-rewrite-setting-still-duplicates/node
```
