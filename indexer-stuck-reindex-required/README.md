# Indexer stuck at reindex required or processing

Update on Schedule indexers hold `indexer_state.status = 'working'` while a cron job processes the changelog tables, then flip it back to `valid` when done. If that cron process is killed, by an out of memory error, a deploy restarting PHP-FPM, or a fatal error, the row never flips back, and Magento believes the indexer is stuck running forever. Every later cron tick or manual `bin/magento indexer:reindex` sees `working` and refuses to proceed, while the `*_cl` changelog tables keep growing unread.

There is no public REST resource for indexer control, so this script cannot repair the lock over the API alone. It reads `indexer_state` (and `mview_state`) directly, cross checks staleness against `GET /rest/V1/products`, and inspects the `*_cl` changelog backlog size. By default it only reports a structured alert per stuck indexer. A real reset (`bin/magento indexer:reset`, clearing `mview_state`, clearing lock files) needs CLI or database access and is gated behind `DRY_RUN=false` plus a confirmed-dead process, so it defaults to safe.

**Full guide with diagrams:** https://www.allanninal.dev/magento/indexer-stuck-reindex-required/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STUCK_THRESHOLD_MINUTES="60"
export CHANGELOG_BACKLOG_MAX="5000"
export DRY_RUN="true"

python indexer-stuck-reindex-required/python/flag_stuck_indexers.py
node   indexer-stuck-reindex-required/node/flag-stuck-indexers.js
```

`classify_indexer_row` / `classifyIndexerRow` is a pure function (the current time is passed in): a row is only ever `ok`, `flag_backlog`, or `reset_candidate` based on its status, how stale `updated_at` is against `STUCK_THRESHOLD_MINUTES`, and the optional changelog backlog size against `CHANGELOG_BACKLOG_MAX`. It does no I/O, so it needs no network, no database, and no Magento store to test. The database reads and the reset path both live behind `run()`, which requires a database handle to be passed in, so importing the module never requires credentials. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest indexer-stuck-reindex-required/python
node --test indexer-stuck-reindex-required/node
```
