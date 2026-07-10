# Category product assignment missing from search index

A product can be correctly assigned to a category in `catalog_category_product` and still never show up in category or fulltext search results, because Magento's `catalogsearch_fulltext` indexer only reindexes rows named in its Mview changelog. When the `mview.xml` subscription for that table is missing or gets overwritten by another indexer's subscription, the assignment change never writes a changelog row, so Update by Schedule cron never sees it even though cron is healthy.

This script is diagnostic only. It compares the admin-truth assignment list from `/V1/categories/{id}/products` against what the category-filtered `/V1/products` search actually returns, confirms each candidate's status and visibility via `/V1/products/{sku}`, and reports the SKUs that are genuinely stuck rather than legitimately excluded (disabled or Not Visible Individually).

**Full guide with diagrams:** https://www.allanninal.dev/magento/category-assignment-missing-from-search-index/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export CATEGORY_IDS="20,21,35"
export DRY_RUN="true"

python category-assignment-missing-from-search-index/python/find_missing_category_assignments.py
node   category-assignment-missing-from-search-index/node/find-missing-category-assignments.js
```

`find_missing_category_assignments` (Python) and `findMissingCategoryAssignments` (Node) are pure functions: given the assigned SKUs, the search index SKUs, and a status/visibility lookup, they return only the SKUs that are stuck in the changelog gap. The script never calls a reindex or write endpoint. If it finds gaps, it recommends running `php bin/magento indexer:reindex catalogsearch_fulltext` (or resetting the `mview_state` for that view) yourself, since that needs CLI access this REST-only script does not have.

## Test

```bash
pytest category-assignment-missing-from-search-index/python
node --test category-assignment-missing-from-search-index/node
```
