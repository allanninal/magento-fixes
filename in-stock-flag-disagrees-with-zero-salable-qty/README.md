# Product shows in stock while salable quantity is zero

MSI keeps `is_in_stock` on the stock item as a slow-changing flag refreshed by the cataloginventory and legacy stock indexers, while salable quantity is computed on demand from `source_items` minus active reservations (`InventoryReservationsApi`). A checkout reservation lands synchronously, so salable quantity can hit zero immediately, while `is_in_stock` keeps reporting true until a cron run or reindex catches up. The result: the storefront and the raw REST product data both say In Stock, so shoppers can add phantom stock to cart until checkout rejects it.

This is a data consistency symptom of an indexer and reservation race, not something safe to fix by silently rewriting the stock flag. This script pages through enabled products, compares each one's `is_in_stock` flag against its live salable quantity from `GET /rest/V1/inventory/get-product-salable-quantity/{sku}/{stockId}`, and by default only reports a structured mismatch row per SKU: sku, stock_id, is_in_stock, salable_qty, and the source_items total. Only under an explicit `DRY_RUN=false` operator override does it send a guarded `PUT /rest/V1/products/{sku}` to set `is_in_stock` to false for confirmed zero-salable-qty items. It never writes `is_in_stock=true` automatically, and it logs a reminder that `bin/magento indexer:reindex cataloginventory_stock inventory` or `bin/magento cron:run` is the real reconciliation step, since that is CLI-only and out of REST's reach.

**Full guide with diagrams:** https://www.allanninal.dev/magento/in-stock-flag-disagrees-with-zero-salable-qty/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STOCK_ID="1"
export PAGE_SIZE="100"
export DRY_RUN="true"

python in-stock-flag-disagrees-with-zero-salable-qty/python/flag_phantom_in_stock.py
node   in-stock-flag-disagrees-with-zero-salable-qty/node/flag-phantom-in-stock.js
```

`is_phantom_in_stock` / `isPhantomInStock` is a pure function: it takes only the stock item's `is_in_stock` and `manage_stock` flags, the current salable quantity, and whether backorders are allowed, and returns true only when the flag says buyable, stock is managed, backorders are off, and salable quantity is at or below zero. It does no I/O, so it needs no network, no database, and no Magento store to test. The REST reads and the correction path both live behind `run()`, so importing the module never requires credentials. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest in-stock-flag-disagrees-with-zero-salable-qty/python
node --test in-stock-flag-disagrees-with-zero-salable-qty/node
```
