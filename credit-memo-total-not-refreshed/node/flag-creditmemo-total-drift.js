/**
 * Flag Magento 2 credit memos whose grand_total was never refreshed after an
 * adjustment edit.
 *
 * In the admin credit memo creation form, the grand total shown and saved is
 * only recalculated by the Update Qty's JavaScript handler, which fires on
 * item quantity changes. It is never wired to the Refund Shipping,
 * Adjustment Refund (adjustment_positive), or Adjustment Fee
 * (adjustment_negative) input fields, so editing those alone can leave
 * grand_total stale in both the UI and the persisted record unless a qty
 * update or the actual submission forces Magento's server side total
 * collectors to run. The same drift is reachable through POST
 * /V1/creditmemo, since the API does not independently re-validate the
 * total. There is no supported endpoint to fix a posted creditmemo's
 * grand_total, so this only reports the drift. Run on a schedule. Safe to
 * run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/credit-memo-total-not-refreshed/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const EPSILON = Number(process.env.EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function evaluateCreditmemoTotalDrift(creditmemo, epsilon = 0.01) {
  const expectedGrandTotal = round2(
    creditmemo.subtotal
    - creditmemo.discountAmount
    + creditmemo.shippingAmount
    + creditmemo.taxAmount
    + creditmemo.adjustmentPositive
    - creditmemo.adjustmentNegative
  );
  const delta = round2(creditmemo.grandTotal - expectedGrandTotal);
  const isDrifted = Math.abs(delta) > epsilon;
  return { expectedGrandTotal, delta, isDrifted };
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

function normalizeCreditmemo(raw) {
  return {
    entityId: raw.entity_id,
    incrementId: raw.increment_id,
    orderId: raw.order_id,
    subtotal: Number(raw.subtotal || 0),
    discountAmount: Number(raw.discount_amount || 0),
    shippingAmount: Number(raw.shipping_amount || 0),
    taxAmount: Number(raw.tax_amount || 0),
    adjustmentPositive: Number(raw.adjustment_positive || 0),
    adjustmentNegative: Number(raw.adjustment_negative || 0),
    grandTotal: Number(raw.grand_total || 0),
  };
}

export async function run() {
  const since = sinceIso(LOOKBACK_DAYS);
  const flagged = [];
  let page = 1;

  while (true) {
    const rawItems = await recentCreditmemos(since, 100, page);
    if (!rawItems.length) break;

    for (const raw of rawItems) {
      const creditmemo = normalizeCreditmemo(raw);
      const result = evaluateCreditmemoTotalDrift(creditmemo, EPSILON);
      if (result.isDrifted) flagged.push({ ...creditmemo, ...result });
    }

    if (rawItems.length < 100) break;
    page++;
  }

  for (const row of flagged) {
    console.warn(
      `Creditmemo ${row.incrementId} (order ${row.orderId}) grand_total drifted. ` +
      `stored=${row.grandTotal.toFixed(2)} expected=${row.expectedGrandTotal.toFixed(2)} delta=${row.delta.toFixed(2)}`
    );
  }

  if (flagged.length) {
    console.error(`${flagged.length} credit memo(s) drifted. This script never edits them directly.`);
  } else {
    console.log("Done. No credit memo total drift found.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
