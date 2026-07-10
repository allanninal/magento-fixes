/**
 * Flag Magento 2 credit memos that appear to be duplicates from a single
 * refund action.
 *
 * Magento does not guard credit memo creation with an idempotency key. The
 * admin Refund controller, the REST refund endpoints, and payment gateway
 * async notifications such as a PayPal Payflow IPN all call
 * CreditmemoService::refund() independently. If the same refund fires twice
 * in close succession, two sales_creditmemo records can land against the
 * same invoice before the first transaction commits. There is no supported
 * endpoint to delete a creditmemo, so this only reports the duplicate, it
 * never cancels or mutates one. Run on a schedule. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/magento/duplicate-credit-memo-created/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const TOLERANCE_SECONDS = Number(process.env.TOLERANCE_SECONDS || 60);
const AMOUNT_EPSILON = Number(process.env.AMOUNT_EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * Groups input records by orderId, sorts each group by createdAtEpoch, and
 * walks pairwise clustering records whose grandTotal differs by no more
 * than amountEpsilon AND whose createdAtEpoch differs by no more than
 * toleranceSeconds. Any orderId with more than one record in a cluster is
 * returned with its duplicate entityIds and the excess amount (sum of
 * cluster grandTotal minus one representative grandTotal). Returns an empty
 * array if no clusters are found.
 */
export function detectDuplicateCreditMemos(creditmemos, toleranceSeconds = 60, amountEpsilon = 0.01) {
  const byOrder = new Map();
  for (const cm of creditmemos) {
    if (!byOrder.has(cm.orderId)) byOrder.set(cm.orderId, []);
    byOrder.get(cm.orderId).push(cm);
  }

  const results = [];
  for (const [orderId, records] of byOrder) {
    const ordered = [...records].sort((a, b) => a.createdAtEpoch - b.createdAtEpoch);
    const clusters = [];
    for (const record of ordered) {
      let placed = false;
      for (const cluster of clusters) {
        const last = cluster[cluster.length - 1];
        if (
          Math.abs(record.grandTotal - last.grandTotal) <= amountEpsilon &&
          Math.abs(record.createdAtEpoch - last.createdAtEpoch) <= toleranceSeconds
        ) {
          cluster.push(record);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([record]);
    }

    for (const cluster of clusters) {
      if (cluster.length > 1) {
        const totalOverRefund = round2(
          cluster.reduce((sum, r) => sum + r.grandTotal, 0) - cluster[0].grandTotal
        );
        results.push({
          orderId,
          duplicateGroup: cluster.map((r) => r.entityId),
          totalOverRefund,
        });
      }
    }
  }
  return results;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

function sinceIso(lookbackDays) {
  const since = new Date(Date.now() - lookbackDays * 86400 * 1000);
  return since.toISOString().slice(0, 19).replace("T", " ");
}

async function recentCreditmemos(since, pageSize = 100, currentPage = 1) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[filterGroups][0][filters][0][value]": since,
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/creditmemos", params);
  return data.items;
}

function isoToEpoch(iso) {
  return Date.parse(iso) / 1000;
}

function normalizeCreditmemo(raw) {
  return {
    entityId: raw.entity_id,
    incrementId: raw.increment_id,
    orderId: raw.order_id,
    grandTotal: Number(raw.grand_total || 0),
    createdAtEpoch: isoToEpoch(raw.created_at),
  };
}

export async function run() {
  const since = sinceIso(LOOKBACK_DAYS);
  const normalized = [];
  let page = 1;

  while (true) {
    const rawItems = await recentCreditmemos(since, 100, page);
    if (!rawItems.length) break;
    normalized.push(...rawItems.map(normalizeCreditmemo));
    if (rawItems.length < 100) break;
    page++;
  }

  const duplicates = detectDuplicateCreditMemos(normalized, TOLERANCE_SECONDS, AMOUNT_EPSILON);

  for (const row of duplicates) {
    console.warn(
      `Order ${row.orderId} has duplicate credit memos ${JSON.stringify(row.duplicateGroup)}. ` +
      `Excess refunded: ${row.totalOverRefund.toFixed(2)}`
    );
  }

  if (duplicates.length) {
    console.error(`${duplicates.length} order(s) with duplicate credit memos. This script never cancels or deletes them.`);
  } else {
    console.log("Done. No duplicate credit memos found.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
