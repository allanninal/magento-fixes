# Grid refresh by schedule caps at batch size, backlog grows

Magento's Update by Schedule grid sync for `sales_order_grid`, `sales_invoice_grid`, `sales_shipment_grid`, and `sales_creditmemo_grid` runs through `Magento\Sales\Model\ResourceModel\Grid::refreshBySchedule()`. It asks a provider (`UpdatedIdListProvider` / `IdListBuilder`) for the not-yet-synced entity ids, then chunks that list into batches of `Grid::BATCH_SIZE` (100) with `array_chunk()`. The provider's own SQL select already carries a `LIMIT` equal to that same 100, so the query never returns more than 100 candidate ids, no matter how many rows are actually out of sync. During a bulk import, a busy sale, or a grid rebuild, more than 100 rows can fall out of sync between cron ticks, and each scheduled run only ever drains 100, so the backlog leaks out instead of shrinking to zero.

The grid tables and their changelog are database-internal and are not exposed over REST, so this script infers the backlog from the REST-visible order `updated_at` stream: it polls how many orders changed since the last checkpoint and looks for a streak of consecutive polls at or above the batch size, the signature of the batch cap rather than a merely busy cron. There is no REST endpoint that forces a grid resync or removes the cap, and writing to orders through PUT just to force a resync is not safe, so this script only reports. The real repair, `bin/magento indexer:reindex sales_order_grid`, re-running the grid async-insert cron, or switching to Update on Save, is left to the admin or CLI team.

**Full guide with diagrams:** https://www.allanninal.dev/magento/grid-refresh-batch-size-backlog/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export GRID_BATCH_SIZE="100"
export CONSECUTIVE_THRESHOLD="2"
export DRY_RUN="true"

python grid-refresh-batch-size-backlog/python/flag_grid_sync_backlog.py
node   grid-refresh-batch-size-backlog/node/flag-grid-sync-backlog.js
```

`classify_grid_sync_backlog` / `classifyGridSyncBacklog` is a pure function (the poll history is passed in): given a chronological list of poll samples, each recording how many orders had `updated_at` newer than the previous poll's checkpoint, it counts consecutive samples where the count is at or above the batch size. A healthy cron drains the full delta each run, so the count should fall below the batch size once caught up; a capped `refreshBySchedule` leaves it at or above the batch size run after run. Once the streak reaches `CONSECUTIVE_THRESHOLD`, the function flags a suspected backlog and estimates how many rows are still pending. It does no I/O, so it needs no network and no Magento store to test. The REST calls and the poll loop both live behind `run()`, so importing the module never requires credentials. This script never writes to Magento, `DRY_RUN` only changes the log wording, not the behavior, since detection is the only safe action available here.

## Test

```bash
pytest grid-refresh-batch-size-backlog/python
node --test grid-refresh-batch-size-backlog/node
```
