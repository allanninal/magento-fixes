/**
 * Flag Magento 2 credit memos where an online refund silently fell back to
 * offline.
 *
 * The admin credit memo form only offers an online refund when the payment
 * method's gateway adapter reports canRefund or canRefundPartialPerInvoice
 * as true for that invoice's capture transaction. If the capture cannot be
 * found, or the gateway call fails, Magento quietly narrows the form to
 * offline only, with no visible error. If a human submits that form,
 * Magento creates a normal looking credit memo and marks the order
 * refunded, but the payment gateway was never called and the customer's
 * money never moved. There is no supported endpoint that converts an
 * existing offline credit memo into a real gateway refund, so this only
 * reports the mismatch. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/online-refund-falls-back-offline/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const GATEWAY_METHODS = (
  process.env.GATEWAY_METHODS || "stripe_payments,braintree,authorizenet_acceptjs,adyen_cc"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Decide whether a credit memo's online refund silently fell back to offline.
 *
 * Returns whether the payment method is a known gateway backed method, whether
 * a refund transaction exists on the order, and whether that combination looks
 * like a silent fallback (gateway method with no refund transaction recorded).
 */
export function evaluateRefundFallback(creditmemo, transactions, gatewayMethods) {
  const method = creditmemo.paymentMethod;
  if (!gatewayMethods.includes(method)) {
    return { isGatewayMethod: false, hasRefundTxn: null, fellBackOffline: false };
  }

  const hasRefundTxn = transactions.some((t) => t.txnType === "refund");
  return {
    isGatewayMethod: true,
    hasRefundTxn,
    fellBackOffline: !hasRefundTxn,
  };
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

async function orderTransactions(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[pageSize]": 50,
  };
  const data = await magentoGet("/transactions", params);
  return data.items;
}

function normalizeCreditmemo(raw) {
  return {
    entityId: raw.entity_id,
    incrementId: raw.increment_id,
    orderId: raw.order_id,
    paymentMethod: raw.extension_attributes?.payment_method || raw.payment_method,
    grandTotal: Number(raw.grand_total || 0),
  };
}

function normalizeTransaction(raw) {
  return { txnType: raw.txn_type, parentId: raw.parent_id };
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
      if (!creditmemo.orderId) continue;
      const rawTxns = await orderTransactions(creditmemo.orderId);
      const transactions = rawTxns.map(normalizeTransaction);
      const result = evaluateRefundFallback(creditmemo, transactions, GATEWAY_METHODS);
      if (result.fellBackOffline) flagged.push({ ...creditmemo, ...result });
    }

    if (rawItems.length < 100) break;
    page++;
  }

  for (const row of flagged) {
    console.warn(
      `Creditmemo ${row.incrementId} (order ${row.orderId}, method ${row.paymentMethod}) has no refund transaction. ` +
      `Customer may still be owed ${row.grandTotal.toFixed(2)}.`
    );
  }

  if (flagged.length) {
    console.error(`${flagged.length} credit memo(s) look like a silent offline fallback. This script never issues a refund itself.`);
  } else {
    console.log("Done. No offline refund fallback found.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
