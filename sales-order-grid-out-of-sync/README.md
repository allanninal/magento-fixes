# Sales order grid permanently out of sync with sales_order

With asynchronous grid indexing enabled (`dev/grid/async_indexing=1`), orders are written to `sales_order` immediately, but the admin grid reads from a separate table, `sales_order_grid`, that a scheduled cron job fills in later within a window bounded by a cached watermark on `updated_at`. A documented race (`magento/magento2` issue #40803) lets one cron run advance that watermark past an order whose grid row write was still in flight or failed. Because every later cron cycle only looks forward from the watermark, that order's timestamp stays permanently below the new floor and is never picked up again. The same pipeline can also drop rows if cron is killed mid-batch or the grid re-save throws on missing customer or address data.

`sales_order_grid` has no REST endpoint, and there is no public API to force a single order's grid row rebuild, so this job pulls the entity source of truth from `GET /rest/V1/orders` filtered by `updated_at`, cross checks each `entity_id` against what the grid-backed list view returns, and classifies every drifted id as `MISSING_FROM_GRID`, `STALE_STATUS`, or `STALE_TOTAL`. It never writes to `sales_order_grid`. It only reports, per drifted order, `entity_id`, `increment_id`, the last-known-good entity fields, and the drift type, and recommends running `bin/magento indexer:reindex sales_order_grid` for exactly those ids.

**Full guide with diagrams:** https://www.allanninal.dev/magento/sales-order-grid-out-of-sync/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export SYNC_SINCE="2026-07-01 00:00:00"
export WATERMARK="2026-07-09 00:00:00"
export DRY_RUN="true"

python sales-order-grid-out-of-sync/python/flag_grid_sync_drift.py
node   sales-order-grid-out-of-sync/node/flag-grid-sync-drift.js
```

`classify_order_sync` (Python) and `classifyOrderSync` (Node) are pure functions that take an entity row, a grid row or null, and the current watermark, and return a drift type plus an action, so the decision is fully testable without a network call. A missing grid row older than the watermark is the watermark-race signature and gets flagged; a missing row newer than the watermark is simply not due yet. `DRY_RUN` defaults to true and gates the only unsafe path: an explicit, opt-in nudge that adds a no-op system comment to bump `updated_at` for ids in `NUDGE_ALLOWLIST`, letting the async cron re-pick the row. Without both `DRY_RUN=false` and an allowlist, the script only reports and never writes anything.

## Test

```bash
pytest sales-order-grid-out-of-sync/python
node --test sales-order-grid-out-of-sync/node
```
