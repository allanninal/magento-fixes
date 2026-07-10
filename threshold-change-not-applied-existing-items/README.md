# Threshold change not applied to existing items

Saving a new Out-of-Stock Threshold in Magento 2 or Adobe Commerce fires `admin_system_config_changed_section_cataloginventory`, which correctly recalculates the legacy `cataloginventory_stock_item.is_in_stock` flag. MSI has no matching observer for `inventory_source_item`, so existing source items keep whichever `status` value the old threshold produced until quantity changes on its own or a full reindex and cron pass happen to touch them. This is a confirmed defect (see `magento/inventory` issue #3061): the admin grid, the storefront, and the MSI salable quantity API end up disagreeing on the same SKU.

This script pages through the catalog, reads every SKU's source items from `GET /rest/V1/inventory/source-items`, recomputes the `status` each one should have under the current threshold and backorders setting, and by default only reports a structured mismatch: sku, source_code, quantity, threshold, old_status, new_status. Only under an explicit `DRY_RUN=false` operator override does it send a guarded `PUT /rest/V1/inventory/source-items` that overwrites just the `status` field, leaving quantity untouched. It never invents a source item that was not already there, and it logs a reminder that `bin/magento indexer:reindex cataloginventory_stock` plus `bin/magento cron:run` are the CLI-only follow-up steps that reconcile the legacy stock item and the salable quantity index.

**Full guide with diagrams:** https://www.allanninal.dev/magento/threshold-change-not-applied-existing-items/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STOCK_THRESHOLD_QTY="5"
export BACKORDERS_ENABLED="false"
export PAGE_SIZE="100"
export DRY_RUN="true"

python threshold-change-not-applied-existing-items/python/repair_threshold_source_items.py
node   threshold-change-not-applied-existing-items/node/repair-threshold-source-items.js
```

`recompute_source_item_status` / `recomputeSourceItemStatus` is a pure function: it takes only quantity, the current threshold, and whether backorders are enabled, and returns 0 or 1. Salable quantity is quantity minus threshold, and status flips to out of stock at salable quantity zero or below, except when backorders are enabled and the threshold is zero or negative, since that combination keeps the item salable regardless of quantity. It does no I/O, so it needs no network, no database, and no Magento store to test. The REST reads and the repair path both live behind `run()`, so importing the module never requires credentials. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest threshold-change-not-applied-existing-items/python
node --test threshold-change-not-applied-existing-items/node
```
