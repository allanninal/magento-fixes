# cron_schedule fills with duplicate pending jobs

Magento's cron generator, `ProcessCronQueueObserver::_generate()`, only checks rows already in `pending` status when it decides what is already scheduled. It ignores rows stuck in `running` status. If a job's previous run is still executing, whether because it is genuinely long running, stuck, or crashed without ever flipping to `success` or `error`, the generator does not see it as scheduled and inserts a fresh pending row for the same `job_code` on every `cron:run` pass, by default every minute. Combined with `schedule_ahead_for` pre-populating several minutes of future rows each pass, duplicate pending rows for the same `job_code` can accumulate faster than they are consumed, delaying or starving real cron work.

There is no `webapi.xml` route for `cron_schedule` in `module-cron`, so this script queries and prunes the table directly instead of going through REST. It groups pending rows by `job_code`, collapses true duplicates (same `job_code` and `scheduled_at`), and flags any job_code whose deduplicated backlog still exceeds a threshold. It only ever deletes the surplus pending rows a pure decision function selected, and always keeps the single earliest pending row per `job_code` so the job still fires. Both `schedule_lifetime` and `history_cleanup_every` only prune old `success`, `error`, and `missed` rows, so they never retroactively clean an already bloated pending backlog; this script's guarded manual prune is the corrective action for that.

**Full guide with diagrams:** https://www.allanninal.dev/magento/cron-schedule-duplicate-pending-jobs/

## Run it

```bash
export MAGENTO_DB_HOST="127.0.0.1"
export MAGENTO_DB_NAME="magento"
export MAGENTO_DB_USER="magento"
export MAGENTO_DB_PASSWORD="change-me"
export MAX_PENDING_PER_JOB="20"
export DRY_RUN="true"

python cron-schedule-duplicate-pending-jobs/python/prune_cron_schedule.py
node   cron-schedule-duplicate-pending-jobs/node/prune-cron-schedule.js
```

`decide_pending_schedules_to_prune` / `decidePendingSchedulesToPrune` is a pure function (no I/O): given already-fetched pending rows (`schedule_id`, `job_code`, `status`, `scheduled_at`, `created_at`) and a `maxPendingPerJob` threshold, it groups by `job_code`, keeps only the lowest `schedule_id` per identical `scheduled_at` (true duplicates), and if the deduplicated remainder still exceeds the threshold, marks the oldest excess rows for pruning by `created_at`. It always keeps at least the single soonest-scheduled pending row per `job_code`. Start with `DRY_RUN=true` to review exactly which `schedule_id` values would be deleted before enabling the actual `DELETE`.

## Test

```bash
pytest cron-schedule-duplicate-pending-jobs/python
node --test cron-schedule-duplicate-pending-jobs/node
```

Both test suites exercise only the pure decision function, no network and no Magento database required.
