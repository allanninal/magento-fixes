/**
 * Flag Magento 2 job codes whose cron generation halted after a crash, safely.
 *
 * Before scheduling a new run for a job code, Magento's cron scheduler checks
 * whether an existing cron_schedule row for that job code is still status
 * running. If that job's process was killed mid-execution (an OOM, a PHP
 * fatal, a container restart), the row never flips to success or error, and
 * Magento quietly stops generating new runs for that job code forever, while
 * every other job code keeps working. There is no REST resource for
 * cron_schedule, so this reports by default and never writes. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/cron-generation-halts-after-crash/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STALE_MULTIPLIER = Number(process.env.STALE_MULTIPLIER || 3.0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O, no clock reads.
 *
 * Returns true only when lastStatus is "running", executedAt is known, and
 * the elapsed time since executedAt exceeds the job's own expected cadence
 * multiplied by staleMultiplier. A job in that state is blocking all future
 * generation for jobCode, because Magento's scheduler will not write a new
 * cron_schedule row while an existing row for the same job code still
 * reports running.
 *
 * Any other lastStatus (success, error, missed, pending) never blocks
 * generation, so this always returns false for those.
 */
export function isJobStalled(jobCode, lastStatus, executedAt, expectedIntervalMinutes, now, staleMultiplier = 3.0) {
  if (lastStatus !== "running") return false;
  if (executedAt === null || executedAt === undefined) return false;
  const thresholdMs = expectedIntervalMinutes * staleMultiplier * 60000;
  return (now.getTime() - new Date(executedAt).getTime()) > thresholdMs;
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function recentlyUpdatedProducts(sinceIso) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
    "searchCriteria[filterGroups][0][filters][0][value]": sinceIso,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[pageSize]": 100,
    "searchCriteria[currentPage]": 1,
  };
  const data = await magentoGet("/products", params);
  return data.items;
}

async function salableQuantity(sku, stockId) {
  return magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
}

async function fetchRunningRows(db) {
  // db is a caller-supplied read-only handle to cron_schedule.
  // Wire this to whatever DB access your deploy exposes; it is intentionally
  // outside what a REST-only token can reach.
  return db.query(
    "SELECT job_code, status, created_at, scheduled_at, executed_at, finished_at " +
    "FROM cron_schedule WHERE status = 'running'"
  );
}

/**
 * Reads cron_schedule rows through the caller-supplied db handle, flags any
 * job_code whose running row is stalled, and logs a report. Never issues an
 * UPDATE or DELETE; there is no cron_schedule REST endpoint to write through
 * safely, so repair stays a manual or CLI step.
 */
export async function run(db, jobIntervalsMinutes = {}) {
  const now = new Date();

  if (!db) {
    console.warn("No database handle supplied. Nothing to check, exiting.");
    return;
  }

  let flagged = 0;
  const rows = await fetchRunningRows(db);
  for (const row of rows) {
    const interval = jobIntervalsMinutes[row.job_code] ?? 60;
    const stalled = isJobStalled(row.job_code, row.status, row.executed_at, interval, now, STALE_MULTIPLIER);
    if (!stalled) continue;

    const ageMinutes = row.executed_at ? (now.getTime() - new Date(row.executed_at).getTime()) / 60000 : -1;
    console.warn(
      `Job code ${row.job_code} stalled. status=${row.status}, stuck ${ageMinutes.toFixed(0)} min ` +
      `(expected interval ${interval} min). Recommended: mark this cron_schedule row missed, ` +
      `then verify cron:run resumes ${row.job_code}.`
    );
    flagged++;
  }

  console.log(`Done. ${flagged} job code(s) flagged. Dry run=${DRY_RUN} (report only, no writes issued).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
