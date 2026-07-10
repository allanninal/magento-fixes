/**
 * Flag a Magento 2 sales_order_grid (and invoice/shipment/creditmemo grid)
 * sync backlog caused by the refreshBySchedule batch size cap, safely.
 *
 * Magento's Update by Schedule grid sync asks a provider for not-yet-synced
 * entity ids, and that provider's own SQL select carries a LIMIT equal to
 * Grid::BATCH_SIZE (100). When more than 100 rows fall out of sync between
 * cron ticks (bulk import, a busy sale, a grid rebuild), each scheduled run
 * only ever drains 100 rows, and the backlog can grow faster than it
 * shrinks. The grid tables are database-internal and are not exposed over
 * REST, so this script infers the backlog from the REST-visible order
 * updated_at stream: it polls how many orders changed since the last
 * checkpoint and looks for a streak of consecutive polls at or above the
 * batch size, which is the signature of the batch cap rather than a merely
 * busy cron.
 *
 * This script never writes to Magento. There is no REST endpoint that
 * forces a grid resync or removes the batch cap, and touching orders
 * through PUT just to force a resync is not a safe workaround. It only
 * reports. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/grid-refresh-batch-size-backlog/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const GRID_BATCH_SIZE = Number(process.env.GRID_BATCH_SIZE || 100);
const CONSECUTIVE_THRESHOLD = Number(process.env.CONSECUTIVE_THRESHOLD || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function classifyGridSyncBacklog(pollHistory, batchSize = 100, consecutiveThreshold = 2) {
  let consecutive = 0;
  let bestStreak = 0;
  let streakExcess = 0;
  let bestExcess = 0;

  for (const sample of pollHistory) {
    const count = sample.updatedSinceLastPollCount;
    if (count >= batchSize) {
      consecutive += 1;
      streakExcess += count - batchSize;
    } else {
      consecutive = 0;
      streakExcess = 0;
    }
    if (consecutive >= bestStreak) {
      bestStreak = consecutive;
      bestExcess = streakExcess;
    }
  }

  return {
    backlogSuspected: bestStreak >= consecutiveThreshold,
    consecutiveOverBatchRuns: bestStreak,
    estimatedBacklogRows: bestStreak >= consecutiveThreshold ? bestExcess : 0,
  };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function ordersUpdatedSince(sinceIso, pageSize = 200, currentPage = 1) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
    "searchCriteria[filterGroups][0][filters][0][value]": sinceIso,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  return magentoGet("/orders", params);
}

async function newestOrderUpdatedAt() {
  const params = {
    "searchCriteria[pageSize]": 1,
    "searchCriteria[currentPage]": 1,
    "searchCriteria[sortOrders][0][field]": "updated_at",
    "searchCriteria[sortOrders][0][direction]": "DESC",
  };
  const data = await magentoGet("/orders", params);
  return data.items[0]?.updated_at || null;
}

async function pollOnce(sinceIso, pageSize = 200) {
  const data = await ordersUpdatedSince(sinceIso, pageSize);
  const items = data.items || [];
  const incrementIds = items.map((o) => o.increment_id);
  return { count: data.total_count ?? items.length, incrementIds };
}

export async function run(checkpointIso, pollHistory = []) {
  const checkpoint = checkpointIso || (await newestOrderUpdatedAt());
  if (!checkpoint) {
    console.log("No orders found. Nothing to poll yet.");
    return pollHistory;
  }

  const sample = await pollOnce(checkpoint);
  pollHistory.push({ timestampMs: Date.now(), updatedSinceLastPollCount: sample.count });

  const result = classifyGridSyncBacklog(pollHistory, GRID_BATCH_SIZE, CONSECUTIVE_THRESHOLD);

  if (result.backlogSuspected) {
    console.warn(
      `Suspected grid sync backlog: ${result.consecutiveOverBatchRuns} consecutive poll(s) at or above batch size ${GRID_BATCH_SIZE}, ` +
      `estimated ${result.estimatedBacklogRows} row(s) behind. Sample increment_ids: ${sample.incrementIds.slice(0, 20)}. ` +
      `${DRY_RUN ? "DRY_RUN, reporting only" : "reporting only, no auto-repair available over REST"}`
    );
  } else {
    console.log(`Grid sync looks healthy. ${sample.count} order(s) updated since checkpoint.`);
  }

  return pollHistory;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
