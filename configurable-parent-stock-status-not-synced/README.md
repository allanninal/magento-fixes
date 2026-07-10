# Configurable parent stock status not derived from children

A Magento 2 configurable product's own `is_in_stock` flag lives in `cataloginventory_stock_item` and is only refreshed by the `Magento\ConfigurableProduct` stock-status plugin and indexer path when specific save events fire and the inventory indexers are caught up. Edit a child's quantity through an import, the API, or a source-level change without triggering that path, and the parent's cached flag goes stale, showing In Stock while every child is out of stock, or the reverse.

This script lists configurables, reads each child's `is_in_stock` and salable quantity, computes the expected parent status as the boolean OR of salable children, and flags every parent where its cached `is_in_stock` disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/magento/configurable-parent-stock-status-not-synced/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STOCK_ID="1"
export DRY_RUN="true"

python configurable-parent-stock-status-not-synced/python/configurable_stock_sync.py
node   configurable-parent-stock-status-not-synced/node/configurable-stock-sync.js
```

`compute_expected_parent_stock_status` is a pure function: it takes an array of children, each with a SKU, an `isInStock` flag, and a `salableQty`, and returns true only if children is non-empty and at least one child has `isInStock === true` and `salableQty > 0`. It returns false if children is empty or every child fails that test. With `DRY_RUN=true` (the default) the script only reports mismatched configurables. Setting `DRY_RUN=false` additionally issues a `PUT /rest/V1/products/{sku}` that corrects `extension_attributes.stock_item.is_in_stock` to the expected value. That write only fixes the cached legacy flag, not the MSI salable quantity index itself, so a full `bin/magento indexer:reindex` is still recommended afterward.

## Test

```bash
pytest configurable-parent-stock-status-not-synced/python
node --test configurable-parent-stock-status-not-synced/node
```
