/**
 * Find and prune duplicate pending jobs in Magento 2 or Adobe Commerce cron_schedule.
 *
 * Magento's cron generator, ProcessCronQueueObserver::_generate(), only checks
 * rows already in pending status when it decides what is already scheduled. It
 * ignores rows stuck in running status. If a job's previous run is still
 * executing, whether long running, stuck, or crashed without flipping to
 * success or error, the generator keeps inserting a fresh pending row for the
 * same job_code on every cron:run pass. cron_schedule has no webapi.xml route,
 * so this script queries and prunes the table directly. It only ever deletes
 * surplus pending rows, always keeping the single earliest pending row per
 * job_code so the job still fires. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/cron-schedule-duplicate-pending-jobs/
 */
import { pathToFileURL } from "node:url";

const DB_HOST = process.env.MAGENTO_DB_HOST || "127.0.0.1";
const DB_NAME = process.env.MAGENTO_DB_NAME || "magento";
const DB_USER = process.env.MAGENTO_DB_USER || "magento";
const DB_PASSWORD = process.env.MAGENTO_DB_PASSWORD || "";
const MAX_PENDING_PER_JOB = Number(process.env.MAX_PENDING_PER_JOB || 20);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure function. Decides which pending cron_schedule rows to prune per job_code.
 *
 * rows: array of {schedule_id, job_code, status, scheduled_at, created_at}
 * maxPendingPerJob: number, the max pending rows to keep per job_code once
 *   true duplicates (same job_code + scheduled_at) are collapsed.
 *
 * Returns an array of {job_code, prune_ids, keep_ids}. Always keeps at least
 * one row (the soonest scheduled) per job_code. No I/O.
 */
export function decidePendingSchedulesToPrune(rows, maxPendingPerJob) {
  const byJob = new Map();
  for (const row of rows) {
    if (!byJob.has(row.job_code)) byJob.set(row.job_code, []);
    byJob.get(row.job_code).push(row);
  }

  const results = [];
  for (const [jobCode, jobRows] of byJob) {
    const byTime = new Map();
    for (const row of jobRows) {
      if (!byTime.has(row.scheduled_at)) byTime.set(row.scheduled_at, []);
      byTime.get(row.scheduled_at).push(row);
    }

    let deduped = [];
    let pruneIds = [];
    for (const group of byTime.values()) {
      const sorted = [...group].sort((a, b) => a.schedule_id - b.schedule_id);
      deduped.push(sorted[0]);
      pruneIds.push(...sorted.slice(1).map((r) => r.schedule_id));
    }

    deduped.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.schedule_id - b.schedule_id);
    let keepIds = deduped.map((r) => r.schedule_id);

    // Never prune the last remaining pending row for a job_code, even if
    // maxPendingPerJob is 0: the job still needs to fire at least once.
    const effectiveMax = Math.max(maxPendingPerJob, 1);
    if (deduped.length > effectiveMax) {
      const excess = deduped.slice(0, deduped.length - effectiveMax);
      pruneIds.push(...excess.map((r) => r.schedule_id));
      keepIds = deduped.slice(deduped.length - effectiveMax).map((r) => r.schedule_id);
    }

    results.push({
      job_code: jobCode,
      prune_ids: pruneIds.sort((a, b) => a - b),
      keep_ids: keepIds.sort((a, b) => a - b),
    });
  }
  return results;
}

async function getConnection() {
  const mysql = await import("mysql2/promise");
  return mysql.default.createConnection({
    host: DB_HOST, database: DB_NAME, user: DB_USER, password: DB_PASSWORD,
  });
}

async function fetchPendingRows(conn) {
  const [rows] = await conn.execute(
    "SELECT schedule_id, job_code, status, scheduled_at, created_at " +
    "FROM cron_schedule WHERE status = 'pending'"
  );
  return rows;
}

async function pruneSchedules(conn, scheduleIds) {
  if (scheduleIds.length === 0) return 0;
  const placeholders = scheduleIds.map(() => "?").join(",");
  const [result] = await conn.execute(
    `DELETE FROM cron_schedule WHERE schedule_id IN (${placeholders})`,
    scheduleIds
  );
  return result.affectedRows;
}

export async function run() {
  const conn = await getConnection();
  try {
    const rows = await fetchPendingRows(conn);
    const plans = decidePendingSchedulesToPrune(rows, MAX_PENDING_PER_JOB);
    let totalPruned = 0;
    for (const plan of plans) {
      if (plan.prune_ids.length === 0) continue;
      console.log(`job_code=${plan.job_code} would prune ${plan.prune_ids.length} row(s): ${plan.prune_ids}`);
      if (!DRY_RUN) {
        const deleted = await pruneSchedules(conn, plan.prune_ids);
        totalPruned += deleted;
        console.log(`job_code=${plan.job_code} pruned ${deleted} row(s)`);
      } else {
        totalPruned += plan.prune_ids.length;
      }
    }
    console.log(`Done. ${totalPruned} row(s) ${DRY_RUN ? "would be pruned (dry run)" : "pruned"}.`);
  } finally {
    await conn.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
