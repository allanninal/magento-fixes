# Products vanish during price reindex

The `catalog_product_price` indexer rebuilds `catalog_product_index_price` by paging through eligible products in batches and issuing a delete followed by an insert for each batch. With small batch sizes and a catalog carrying many disabled or out of stock SKUs, a product's row can be deleted in one batch and not reinserted until a later one, so a category page, layered navigation, or a search hitting the price index during that gap can show the product as missing even though it is still in the catalog.

This is CLI and DB territory (`indexer:reindex`, cron, direct index-table access), not a writable REST resource, so this script detects the symptom rather than fixing it: it records the enabled and visible SKU set before, during, and after a known reindex window, cross references `GET /rest/V1/indexer` status for `catalog_product_price`, and reports whether a drop is the expected self-healing batching race or a genuine, still-missing product. It never calls a mutating endpoint for a transient gap.

**Full guide with diagrams:** https://www.allanninal.dev/magento/products-vanish-during-price-reindex/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export PAGE_SIZE="100"
export POLL_INTERVAL_SECONDS="5"
export DRY_RUN="true"

python products-vanish-during-price-reindex/python/reindex_anomaly.py
node   products-vanish-during-price-reindex/node/reindex-anomaly.js
```

`decide_reindex_anomaly` is a pure function (all SKU snapshots and indexer status are passed in): it computes `missing = beforeSkus - duringSkus` and `stillMissingAfter = missing - afterSkus`. If missing SKUs all return by the after snapshot and the indexer was `processing` or `invalid`, it recommends `flag_transient_index_gap` (expected, self healing, not a fix target). If SKUs never come back, it recommends `flag_permanent_loss` (a real problem needing human review, not auto-repair). The only REST-safe corrective action for a genuinely missing product is a human-confirmed `PUT /rest/V1/products/{sku}`, which this script never calls on its own.

## Test

```bash
pytest products-vanish-during-price-reindex/python
node --test products-vanish-during-price-reindex/node
```
