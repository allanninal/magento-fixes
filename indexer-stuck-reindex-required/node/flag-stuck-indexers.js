/**
 * Flag Magento 2 indexers stuck at Reindex required or Processing, safely.
 *
 * Update on Schedule indexers hold indexer_state.status = 'working' while a
 * cron job processes the changelog tables, then flip it back to 'valid' when
 * done. If that cron process is killed (an OOM, a deploy restarting
 * PHP-FPM, a fatal error), the row never flips back, and Magento believes
 * the indexer is stuck running forever. There is no public REST resource
 * for indexer control, so this reports by default and only gates a real
 * reset behind DRY_RUN=false plus a confirmed-dead process. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/indexer-stuck-reindex-required/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STUCK_THRESHOLD_MINUTES = Number(process.env.STUCK_THRESHOLD_MINUTES || 60);
const CHANGELOG_BACKLOG_MAX = Number(process.env.CHANGELOG_BACKLOG_MAX || 5000);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * @param {{status: "valid"|"invalid"|"working", updatedAt: string}} row
 * @param {Date} now - pass the current time in explicitly so this stays testable
 * @param {{stuckWorkingMinutes: number, changelogBacklogMax?: number}} thresholds
 * @param {number} [changelogRowCount] - backlog size of the matching *_cl table
 * @returns {{action: "ok"|"flag_backlog"|"reset_candidate", reason: string}}
 */
export function classifyIndexerRow(row, now, thresholds, changelogRowCount) {
  if (row.status !== "working") {
    return { action: "ok", reason: "not currently working" };
  }

  const ageMinutes = (now.getTime() - new Date(row.updatedAt).getTime()) / 60000;

  if (ageMinutes <= thresholds.stuckWorkingMinutes) {
    return { action: "ok", reason: "still within expected run time" };
  }

  const backlogMax = thresholds.changelogBacklogMax;
  if (changelogRowCount !== undefined && backlogMax !== undefined && changelogRowCount > backlogMax) {
    return { action: "flag_backlog", reason: "changelog backlog exceeds threshold, indexer likely starved" };
  }

  return { action: "reset_candidate", reason: "working status stale beyond threshold, indicates crashed process holding lock" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

/**
 * Cross check the storefront-facing catalog against the changelog claim.
 * Uses GET /rest/V1/products with searchCriteria filtering on updated_at >= sinceIso.
 */
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

/**
 * db is a caller-supplied read-only handle to indexer_state (and mview_state).
 * There is no public REST resource for indexer control, so this needs direct
 * database access, wired to whatever your deploy exposes (a read replica, an
 * internal endpoint, and so on). Kept out of the pure function so tests never
 * need it.
 */
async function fetchIndexerRows(db) {
  return db.query("SELECT indexer_id, view_id, status, updated_at FROM indexer_state");
}

async function fetchChangelogBacklog(db, changelogTable) {
  const rows = await db.query(`SELECT COUNT(*) AS n FROM ${changelogTable}`);
  return rows[0].n;
}

export async function run(db, changelogTables = {}) {
  const now = new Date();
  const thresholds = {
    stuckWorkingMinutes: STUCK_THRESHOLD_MINUTES,
    changelogBacklogMax: CHANGELOG_BACKLOG_MAX,
  };

  if (!db) {
    console.warn("No database handle supplied. Nothing to check, exiting.");
    return;
  }

  let flagged = 0;
  const rows = await fetchIndexerRows(db);
  for (const row of rows) {
    const changelogTable = changelogTables[row.indexer_id];
    const backlog = changelogTable ? await fetchChangelogBacklog(db, changelogTable) : undefined;

    const classifiedRow = { status: row.status, updatedAt: row.updated_at };
    const result = classifyIndexerRow(classifiedRow, now, thresholds, backlog);

    if (result.action === "ok") continue;

    const ageMinutes = (now.getTime() - new Date(row.updated_at).getTime()) / 60000;
    console.warn(
      `Indexer ${row.indexer_id}: ${result.action} (stuck ${ageMinutes.toFixed(0)} min, backlog=${backlog}). ${
        result.action === "reset_candidate" && !DRY_RUN ? "would reset" : "reporting only"
      }`
    );
    flagged++;
  }

  console.log(`Done. ${flagged} indexer(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
