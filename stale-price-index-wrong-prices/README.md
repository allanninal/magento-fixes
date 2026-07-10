# Stale price index shows wrong or old prices

Magento 2 and Adobe Commerce do not compute storefront prices live from the EAV attribute tables. They precompute prices into flat index tables, `catalog_product_price` and `catalog_product_index_price`, and the storefront only ever reads from those tables. Under Update by Schedule indexer mode, an admin price edit or a catalog price rule change is recorded as a pending row in a changelog table and only lands in the index tables when the price indexer cron actually runs. If cron is stalled, disabled, or an indexer is stuck in a working or invalid status, the storefront keeps serving the last price that was successfully indexed even though the admin already shows the new one.

This script pulls the admin truth price and the store scoped price for the same SKUs over the REST API, diffs them, and reports the mismatches with the product's `updated_at` so you know whether it looks like a normal pending reindex or something that needs a human. Reindexing itself is CLI and cron only (`bin/magento indexer:reindex catalog_product_price`) and is not exposed over REST, so this script never attempts it: it reports by default, and only performs the one REST-safe corrective nudge (a no-op price re-save that requeues the SKU in the changelog) when an operator explicitly opts in.

**Full guide with diagrams:** https://www.allanninal.dev/magento/stale-price-index-wrong-prices/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
# or, if you already have a token:
# export MAGENTO_ADMIN_TOKEN="..."
export STORE_CODE="default"
export SINCE="2026-07-01 00:00:00"
export LAST_REINDEX_AT=""   # optional ISO timestamp you track yourself
export PRICE_EPSILON="0.01"
export DRY_RUN="true"

python stale-price-index-wrong-prices/python/flag_stale_price_index.py
node   stale-price-index-wrong-prices/node/flag-stale-price-index.js
```

`decide_price_index_action` / `decidePriceIndexAction` is a pure function (no I/O): given an already-fetched admin price, storefront-scoped price, the product's `updated_at`, and the last known reindex timestamp, it returns whether the mismatch is stale and, if so, whether it is safe to flag for a normal reindex (`flag_reindex`) or needs a human to investigate (`flag_investigate`). A mismatch is only ever `flag_reindex` when the edit happened after the last known reindex; otherwise it is `flag_investigate` and the script never writes to it. Start with `DRY_RUN=true` to review the flagged SKUs (written to `stale_price_index.csv` in Python) before enabling the no-op re-save nudge.

## Test

```bash
pytest stale-price-index-wrong-prices/python
node --test stale-price-index-wrong-prices/node
```

Both test suites exercise only the pure decision function, no network and no Magento instance required.
