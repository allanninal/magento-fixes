# Category product count wrong or zero on large catalogs

Magento's category product count is read from a precomputed index table, `catalog_category_product_index`, that the `catalog_category_product` indexer rebuilds with a temp table swap rather than updating rows in place. If that swap is interrupted, the index table can go stale or zero out while the real product to category assignments on disk are untouched. Anchor categories are hit hardest since their count aggregates every subcategory in the same pass.

This script diffs the reported `product_count` from `GET /rest/V1/categories/{id}` against the real total from `GET /rest/V1/products` filtered by `category_id`, and flags every category where they disagree, calling out anchor categories separately.

**Full guide with diagrams:** https://www.allanninal.dev/magento/category-product-count-wrong/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export COUNT_TOLERANCE="0"
export DRY_RUN="true"
export MAGENTO_ALLOW_INDEXER_INVALIDATE="false"

python category-product-count-wrong/python/category_count_check.py
node   category-product-count-wrong/node/category-count-check.js
```

`decide_category_count_discrepancy` is a pure function: a category is flagged `zeroed` whenever the reported count is zero but real assignments exist (regardless of tolerance), flagged `drift` when the absolute difference exceeds the tolerance, and left unflagged otherwise. The script never fixes the index itself, that requires `bin/magento indexer:reindex catalog_category_product`, a CLI or cron action outside REST. With `DRY_RUN=true` (the default) it only reports. Setting `MAGENTO_ALLOW_INDEXER_INVALIDATE=true` and `DRY_RUN=false` additionally resaves the category with an unchanged payload to nudge Magento's own indexer invalidation, so the next scheduled cron reindex picks it up. That is a soft nudge, not a guaranteed fix.

## Test

```bash
pytest category-product-count-wrong/python
node --test category-product-count-wrong/node
```
