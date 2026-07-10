# Cron jobs stuck in running state block all future runs

Magento's cron runner, `Magento\Cron\Observer\ProcessCronQueueObserver`, writes a `cron_schedule` row with `status = 'running'` and `executed_at` set to now before it invokes the job callback, then updates that row to `success` or `error` only after the callback returns. If that process is killed, an out of memory error, a deploy restarting PHP-FPM, a server crash, or an infinite loop, that final update never happens, and the row is orphaned on `running` forever. Magento only reschedules a job once its cron group's configured `max_run_time` has elapsed, which defaults to twenty four hours, and many job codes are singleton guarded so they will not queue a new run while one of the same code is `running`.

There is no public REST resource for `cron_schedule`, so this script cannot repair the lock over the API alone. It reads `cron_schedule` directly, cross checks against REST-facing symptoms such as unprocessed orders through `GET /rest/V1/orders`, and classifies each `running` row with a pure function. By default it only reports a structured alert per stale row. A real unlock (`bin/magento cron:unlock`, `bin/magento cron:unlock --job-code=<job_code>`, or the database fallback `UPDATE cron_schedule SET status='error' ...`) needs CLI or database access and is gated behind `DRY_RUN=false`, so it defaults to safe.

**Full guide with diagrams:** https://www.allanninal.dev/magento/cron-stuck-running-blocks-jobs/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export CRON_STALE_TIMEOUT_SECONDS="7200"
export CRON_UNSTARTED_GRACE_SECONDS="300"
export DRY_RUN="true"

python cron-stuck-running-blocks-jobs/python/flag_stuck_cron.py
node   cron-stuck-running-blocks-jobs/node/flag-stuck-cron.js
```

`classify_stale_cron_row` / `classifyStaleCronRow` is a pure function (the current time is passed in): a row is only ever `ok`, `stale_running`, or `stale_unstarted` based on its status, how stale `executed_at` is against `CRON_STALE_TIMEOUT_SECONDS`, and a separate short grace window for rows that never started executing at all. It does no I/O, so it needs no network, no database, and no Magento store to test. The database read and the unlock path both live behind `run()`, which requires a database handle to be passed in, so importing the module never requires credentials. Start with `DRY_RUN=true` to review the list first, and never lower the timeout below the longest legitimate job in that cron group.

## Test

```bash
pytest cron-stuck-running-blocks-jobs/python
node --test cron-stuck-running-blocks-jobs/node
```
