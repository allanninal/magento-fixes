/**
 * Detect Magento 2 orders stuck on pending payment after their invoice is paid, safely.
 *
 * Order state and invoice state are two separate write paths. When a payment
 * gateway webhook, a custom payment module, or an out of process API call
 * creates or updates an invoice and marks it paid without also calling
 * order.setState(processing).setStatus(...) and saving the order, the
 * invoice and total_paid reflect the successful payment while order.state
 * and status stay on new or pending_payment. This reports every mismatch by
 * default and only gates a real state change behind DRY_RUN=false plus a
 * human confirming the gateway capture. Run on a schedule. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-stuck-pending-payment-after-invoice/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PENDING_STATES = new Set(["new", "pending_payment"]);
const STATE_PAID = 2;

/**
 * Pure decision function. Takes plain data, returns plain data.
 * order: {entityId, incrementId, state, status, grandTotal, totalPaid, totalInvoiced}
 * invoices: array of {entityId, orderId, state, grandTotal}
 */
export function detectPendingPaymentMismatch(order, invoices) {
  const matched = invoices.filter((inv) => inv.orderId === order.entityId);
  const paidInvoice = matched.find((inv) => inv.state === STATE_PAID) || null;

  const paidByAmount =
    order.totalPaid >= order.grandTotal || order.totalInvoiced >= order.grandTotal;

  if (PENDING_STATES.has(order.state) && (paidInvoice || paidByAmount)) {
    const reason = paidInvoice
      ? `matched invoice ${paidInvoice.entityId} is state 2 (paid)`
      : "total_paid or total_invoiced already meets grand_total";
    return {
      isMismatched: true,
      reason,
      matchedInvoiceId: paidInvoice ? paidInvoice.entityId : null,
    };
  }

  return { isMismatched: false, reason: null, matchedInvoiceId: null };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPutOrderState(entityId, state, status) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entity: { entity_id: entityId, state, status } }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function candidateOrders(pageSize = 100) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "pending,pending_payment",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[pageSize]": pageSize,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function invoicesForOrder(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/invoices", params);
  return data.items;
}

function toPlainOrder(raw) {
  return {
    entityId: String(raw.entity_id),
    incrementId: raw.increment_id || "",
    state: raw.state || "",
    status: raw.status || "",
    grandTotal: Number(raw.grand_total || 0),
    totalPaid: Number(raw.total_paid || 0),
    totalInvoiced: Number(raw.total_invoiced || 0),
  };
}

function toPlainInvoices(rawItems, orderEntityId) {
  return rawItems.map((item) => ({
    entityId: String(item.entity_id),
    orderId: orderEntityId,
    state: item.state,
    grandTotal: Number(item.grand_total || 0),
  }));
}

export async function run() {
  let flagged = 0;
  const rawOrders = await candidateOrders();

  for (const rawOrder of rawOrders) {
    const order = toPlainOrder(rawOrder);
    const rawInvoices = await invoicesForOrder(order.entityId);
    const invoices = toPlainInvoices(rawInvoices, order.entityId);

    const result = detectPendingPaymentMismatch(order, invoices);
    if (!result.isMismatched) continue;

    flagged++;
    console.warn(
      `Order ${order.incrementId} (id=${order.entityId}) state=${order.state} status=${order.status} ` +
      `total_paid=${order.totalPaid} grand_total=${order.grandTotal} matched_invoice=${result.matchedInvoiceId}. ${result.reason}`
    );

    if (!DRY_RUN) {
      console.warn(
        `DRY_RUN is false: writing order ${order.incrementId} to state=processing, status=processing ` +
        `(confirm the gateway capture before enabling this).`
      );
      await magentoPutOrderState(order.entityId, "processing", "processing");
    }
  }

  console.log(`Done. ${flagged} order(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
