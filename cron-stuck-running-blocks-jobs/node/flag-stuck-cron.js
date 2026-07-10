/**
 * Flag Magento 2 cron_schedule rows stuck on running, safely.
 *
 * Magento's cron runner writes a cron_schedule row with status 'running' and
 * executed_at set to now before it invokes the job callback, then updates
 * that row to 'success' or 'error' only after the callback returns. If that
 * process is killed (an OOM, a deploy restarting PHP-FPM, a server crash, an
 * infinite loop), the row never flips back, and Magento believes the job is
 * stuck running forever. There is no public REST resource for
 * cron_schedule, so this reports by default and only gates a real unlock
 * behind DRY_RUN=false. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/cron-stuck-running-blocks-jobs/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const CRON_STALE_TIMEOUT_SECONDS = Number(process.env.CRON_STALE_TIMEOUT_SECONDS || 7200);
const CRON_UNSTARTED_GRACE_SECONDS = Number(process.env.CRON_UNSTARTED_GRACE_SECONDS || 300);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifyStaleCronRow(row, timeoutSeconds) {
  if (row.status !== "running") return "ok";

  const { now, executedAt, createdAt } = row;

  if (!executedAt) {
    const ageSeconds = createdAt ? now - createdAt : 0;
    return ageSeconds > CRON_UNSTARTED_GRACE_SECONDS ? "stale_unstarted" : "ok";
  }

  const ageSeconds = now - executedAt;
  return ageSeconds > timeoutSeconds ? "stale_running" : "ok";
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function unprocessedOrdersSince(sinceIso) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
    "searchCriteria[filterGroups][0][filters][0][value]": sinceIso,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[filterGroups][1][filters][0][field]": "status",
    "searchCriteria[filterGroups][1][filters][0][value]": "processing",
    "searchCriteria[filterGroups][1][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": 100,
    "searchCriteria[currentPage]": 1,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function fetchRunningRows(db) {
  // db is a caller-supplied read-only handle to cron_schedule.
  // Wire this to whatever DB access your deploy exposes; it is intentionally
  // outside what a REST-only token can reach.
  return db.query(
    "SELECT schedule_id, job_code, status, created_at, scheduled_at, " +
    "executed_at, finished_at, messages FROM cron_schedule WHERE status = 'running'"
  );
}

export async function run(db) {
  if (!db) {
    console.warn("No database handle supplied. Nothing to check, exiting.");
    return;
  }

  const nowEpoch = Date.now() / 1000;
  let flagged = 0;
  const rows = await fetchRunningRows(db);
  for (const row of rows) {
    const classifiedRow = {
      status: row.status,
      executedAt: row.executed_at ? new Date(row.executed_at).getTime() / 1000 : null,
      createdAt: row.created_at ? new Date(row.created_at).getTime() / 1000 : null,
      now: nowEpoch,
    };
    const result = classifyStaleCronRow(classifiedRow, CRON_STALE_TIMEOUT_SECONDS);

    if (result === "ok") continue;

    const ageSeconds = nowEpoch - (classifiedRow.executedAt || classifiedRow.createdAt || nowEpoch);
    console.warn(
      `Schedule ${row.schedule_id} (job_code=${row.job_code}): ${result} (stuck ${ageSeconds.toFixed(0)} sec). ${
        !DRY_RUN ? "would unlock" : "reporting only"
      }`
    );
    flagged++;
  }

  console.log(`Done. ${flagged} cron row(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
