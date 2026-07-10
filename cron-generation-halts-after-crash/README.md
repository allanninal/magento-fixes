# Cron generation halts entirely after a crash

Before scheduling a new run for a job code, Magento's cron scheduler (`Magento\Cron\Model\Schedule` and `Observer\ProcessCronQueueObserver`) checks whether an existing `cron_schedule` row for that job code is still status `running`. If that job's process is killed mid-execution, by an out of memory error, a PHP fatal, or a container restart, the row never flips to `success` or `error`, because that transition only happens in the job's own try or finally block. Magento then believes the job code is still active and quietly stops generating its next run, forever, while every other job code keeps working normally.

There is no REST resource for `cron_schedule`, so this script cannot repair the lock over the API alone. It reads `cron_schedule` directly through a caller-supplied database handle, cross checks staleness against REST-visible symptoms such as `GET /rest/V1/products` or `GET /rest/V1/inventory/get-product-salable-quantity/{sku}/{stockId}`, and flags any job code whose `running` row is older than its own expected cadence times a stale multiplier. By default it only reports a structured alert per stalled job code. The real repair, marking the row `missed` or clearing it and confirming `bin/magento cron:run` resumes, needs CLI or database access and is intentionally left as a manual step, so it defaults to safe.

**Full guide with diagrams:** https://www.allanninal.dev/magento/cron-generation-halts-after-crash/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STALE_MULTIPLIER="3.0"
export DRY_RUN="true"

python cron-generation-halts-after-crash/python/flag_stalled_cron.py
node   cron-generation-halts-after-crash/node/flag-stalled-cron.js
```

`is_job_stalled` / `isJobStalled` is a pure function (the current time is passed in): it returns true only when a job code's last known status is `running`, its `executed_at` is known, and the time since `executed_at` exceeds its own expected interval times `STALE_MULTIPLIER` (default 3.0). Any other status, `success`, `error`, `missed`, or `pending`, always returns false, since those never block generation. It does no I/O, so it needs no network, no database, and no Magento store to test. The database read and the REST cross check both live behind `run()`, which requires a database handle to be passed in, so importing the module never requires credentials. Start with `DRY_RUN=true`; this script only ever reports, since there is no `cron_schedule` REST endpoint to write through safely.

## Test

```bash
pytest cron-generation-halts-after-crash/python
node --test cron-generation-halts-after-crash/node
```
