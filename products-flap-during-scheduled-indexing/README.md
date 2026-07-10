# Products flap out of category or search during scheduled indexing

When an indexer runs Update by Schedule, a cron job reads changed product IDs out of a changelog table and rebuilds their index entries in batches. For `catalogsearch_fulltext`, each batch deletes the existing search documents for those IDs before it recreates them, so for a short window the storefront can return zero or partial results for products that are actually fine. This script polls category and search-equivalent endpoints against a known good baseline of enabled products, and classifies any missing SKU as flapping (expected to self heal within a cycle or two) or stuck (missing across three or more consecutive polls, worth escalating). It never writes to the index; the only optional write is a no-op re-affirmation of a product's existing status, guarded by `DRY_RUN`.

**Full guide with diagrams:** https://www.allanninal.dev/magento/products-flap-during-scheduled-indexing/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export WATCH_CATEGORY_IDS="12,34"
export WATCH_SEARCH_TERMS="widget,gadget"
export POLL_INTERVAL_SEC="8"
export POLL_COUNT="6"
export CRON_INTERVAL_SEC="60"
export DRY_RUN="true"

python products-flap-during-scheduled-indexing/python/flag_flapping_products.py
node   products-flap-during-scheduled-indexing/node/flag-flapping-products.js
```

`is_product_flapping` is a pure function: given a baseline of enabled SKUs, the current category and search results, a tracker of SKUs already missing, and the current timestamp, it classifies each missing SKU as flapping (bounded to about one or two cron cycles) or stuck (missing past three cycles). Start with `DRY_RUN=true` to only log and report.

## Test

```bash
pytest products-flap-during-scheduled-indexing/python
node --test products-flap-during-scheduled-indexing/node
```
