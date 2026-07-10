/**
 * Find and report Magento 2 reserved order ids that created a permanent numbering gap.
 *
 * Magento reserves an order increment_id on the quote, through reserved_order_id
 * backed by the sales_sequence tables, the moment checkout begins, before payment
 * succeeds or the order actually saves. If checkout is abandoned, the gateway
 * declines, or the order-place transaction rolls back, that reserved id is never
 * attached to a real order and the sequence never reuses it. This never rewrites
 * the sequence or reissues a number. It pages inactive quotes carrying a reserved
 * order id, confirms against the Orders API that no order ever claimed it,
 * classifies each with a pure function, always reports orphaned gaps, and only
 * when DRY_RUN is explicitly false marks the originating quote inactive so it is
 * excluded from future scans. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/magento/reserved-order-id-numbering-gaps/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 * quote: {reservedOrderId, isActive, updatedAt}
 * matchingOrders: Array<{incrementId}>
 * returns: {status: "consumed" | "orphaned_gap" | "pending_checkout", reservedOrderId}
 */
export function classifyReservedOrderGap(quote, matchingOrders) {
  let status;
  if (matchingOrders.some((o) => o.incrementId === quote.reservedOrderId)) {
    status = "consumed";
  } else if (quote.isActive) {
    status = "pending_checkout";
  } else {
    status = "orphaned_gap";
  }
  return { status, reservedOrderId: quote.reservedOrderId };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPut(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function* candidateQuotes(pageSize = 200) {
  let currentPage = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "reserved_order_id",
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "notnull",
      "searchCriteria[filterGroups][1][filters][0][field]": "is_active",
      "searchCriteria[filterGroups][1][filters][0][value]": 0,
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": currentPage,
    };
    const data = await magentoGet("/carts/search", params);
    for (const item of data.items) yield item;
    if (currentPage * pageSize >= data.total_count) return;
    currentPage += 1;
  }
}

function normalizeQuote(item) {
  return {
    cartId: item.id,
    reservedOrderId: item.reserved_order_id,
    isActive: Boolean(item.is_active),
    updatedAt: item.updated_at,
    customerEmail: item.customer && item.customer.email,
  };
}

async function ordersMatchingIncrementId(incrementId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "increment_id",
    "searchCriteria[filterGroups][0][filters][0][value]": incrementId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/orders", params);
  return data.items.map((item) => ({ incrementId: item.increment_id }));
}

async function markQuoteReviewed(cartId) {
  const payload = { quote: { id: cartId, is_active: false } };
  return magentoPut(`/carts/${cartId}`, payload);
}

export async function run() {
  const gaps = [];
  let scanned = 0;
  for await (const raw of candidateQuotes(PAGE_SIZE)) {
    const quote = normalizeQuote(raw);
    if (!quote.reservedOrderId) continue;
    scanned++;
    const matchingOrders = await ordersMatchingIncrementId(quote.reservedOrderId);
    const result = classifyReservedOrderGap(quote, matchingOrders);
    if (result.status === "orphaned_gap") gaps.push(quote);
  }

  if (gaps.length === 0) {
    console.log(`Done. Scanned ${scanned} quote(s). 0 orphaned reserved id gap(s) found.`);
    return;
  }

  for (const quote of gaps) {
    console.warn(
      `reserved_order_id ${quote.reservedOrderId} orphaned. cart_id=${quote.cartId} customer=${quote.customerEmail} updated_at=${quote.updatedAt}`
    );
    if (!DRY_RUN) await markQuoteReviewed(quote.cartId);
  }

  console.log(
    `Done. Scanned ${scanned} quote(s). ${gaps.length} orphaned reserved id gap(s) ${DRY_RUN ? "to mark reviewed" : "marked reviewed"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
