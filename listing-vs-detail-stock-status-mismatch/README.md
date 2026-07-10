# Listing page and product page disagree on stock status

The category grid renders from the `cataloginventory_stock_status` index, rebuilt by the Category Products or Product indexers, typically on schedule or cron. The product page and add to cart flow instead call the live `InventorySalesApi` (`GetProductSalableQtyInterface`, `IsProductSalableInterface`), which nets source item quantities against active reservations in real time. A sale or a pending, unshipped order zeroes the live salable quantity instantly, but the index only catches up on the next reindex, so the grid can say In Stock while the product page correctly blocks the purchase.

This script compares the indexed grid-side signal against the live salable quantity for a list of SKUs and reports every mismatch with a severity, rather than guessing at a data rewrite.

**Full guide with diagrams:** https://www.allanninal.dev/magento/listing-vs-detail-stock-status-mismatch/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export STOCK_ID="1"
export MIN_QTY_THRESHOLD="0"
export DRY_RUN="true"
export CHECK_SKUS="SKU1,SKU2,SKU3"

python listing-vs-detail-stock-status-mismatch/python/diagnose_stock_mismatch.py
node   listing-vs-detail-stock-status-mismatch/node/diagnose-stock-mismatch.js
```

`diagnose_stock_mismatch` is a pure function: given a SKU's grid-side `is_in_stock` and quantity plus the live salable quantity, it returns whether the two sides are mismatched and how severe. A mismatch is `critical` when the grid shows In Stock with a positive quantity while the live salable quantity is zero or less, since a shopper can add to cart something the live check will immediately refuse. The mirror case, a restock the grid has not caught up to yet, is flagged as `stale_index`.

This is index staleness, not corrupted data, so the real fix is a reindex, `bin/magento indexer:reindex cataloginventory_stock` or `cataloginventory_category_flat`, which needs CLI access and is outside what this script does. The default behavior only reports. Only when `DRY_RUN=false` is explicitly set does it also write the one safe, reversible correction, forcing `stock_item.is_in_stock` to `false` on a `critical` mismatch, logging the prior value. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest listing-vs-detail-stock-status-mismatch/python
node --test listing-vs-detail-stock-status-mismatch/node
```
