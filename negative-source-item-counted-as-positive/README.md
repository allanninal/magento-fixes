# Negative source item quantity still counted as positive stock

MSI legitimately allows a `source_item` to carry a negative quantity, for a drop-ship or oversell tracking source signalling a deficit. Magento's stock indexer, `Magento\InventoryIndexer\Indexer\SelectBuilder::execute`, only forces a source's contribution to 0 in the `SUM()` when that source's `is_in_stock` flag is 0, via `getCheckSql()`. When a negative-quantity source is left marked in-stock, or the zeroing branch never fires for how sources combine into a stock, the raw negative number is summed as is, and a depleted source can cancel out or invert the sign of otherwise healthy sources, producing an impossible positive salable total (for example `2 + 3 + (-29)` computing as salable instead of correctly zeroing the product out).

This is tracked upstream as [magento/inventory#3346](https://github.com/magento/inventory/issues/3346) and [magento/inventory#3165](https://github.com/magento/inventory/issues/3165), both still open as of Magento 2.4.x, so a store has to detect this itself rather than rely on a documented fix.

This job cross-checks the raw `source-items` rows behind a stock, the `stock-source-links`, and the authoritative `get-product-salable-quantity` value for each SKU. It never rewrites `source_items` automatically. It reports every SKU and stock pair where the impossible-total signature appears, and only performs the guarded zero-out write after an operator has confirmed a specific row is bad data and set `DRY_RUN=false`. A CLI reindex is always still required afterward for the storefront to reflect the correction.

**Full guide with diagrams:** https://www.allanninal.dev/magento/negative-source-item-counted-as-positive/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export CHECK_SKUS="SKU-1,SKU-2,SKU-3"
export DRY_RUN="true"

python negative-source-item-counted-as-positive/python/flag_negative_source_masked.py
node   negative-source-item-counted-as-positive/node/flag-negative-source-masked.js
```

`is_impossible_stock_total` is a pure function: given the source rows feeding one stock (source code, quantity, status), it returns a deterministic `{flagged, sum, negativeSources, reason}` verdict without touching the network, the database, or the CLI. It flags a stock's naive sum as impossible when at least one negative-quantity row exists but the sum is non-negative, or otherwise fails to propagate that source's deficit, which cannot happen with a genuinely depleted source.

Start with `DRY_RUN=true` to review every flagged SKU and stock pair first. Even with `DRY_RUN=false`, the only write is zeroing a source row an operator has explicitly named as confirmed bad data via the `fixSourceCodes` / `fix_source_codes` map; nothing is corrected automatically.

## Test

```bash
pytest negative-source-item-counted-as-positive/python
node --test negative-source-item-counted-as-positive/node
```
