/**
 * Flag Magento 2 orders closed prematurely while an invoice is still Pending.
 *
 * Magento's Sales/Model/ResourceModel/Order/Handler/State::check() runs on
 * every order save, including the save triggered by creating a shipment. It
 * closes an order once it is not canceled, cannot be put on hold, canInvoice()
 * is false, and canShip() is false, meaning every item is fully shipped. It
 * never checks whether an existing invoice is still open (state = 1,
 * "Pending"). An invoice created Not Capture, followed by a full shipment,
 * closes the order even though total_due is still greater than zero.
 *
 * There is no safe REST write for order.state or order.status, so this
 * reports by default. The only allowed write is on the invoice itself,
 * capture or void, and only when DRY_RUN is false and a human has confirmed
 * real payment status. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-closed-with-pending-invoice/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const INVOICE_STATE_OPEN = 1; // Magento's STATE_OPEN, shown as "Pending" in the admin

/**
 * Pure decision function. No I/O.
 * order: {status, total_paid, total_due, grand_total}
 * invoices: Array<{state, order_id}>
 * hasShipment: boolean
 */
export function classifyPrematureClosure(order, invoices, hasShipment) {
  if (order.status !== "closed") {
    return { isPrematureClosure: false, reason: "order not closed" };
  }

  if (!hasShipment) {
    return { isPrematureClosure: false, reason: "no shipment on record" };
  }

  const hasOpenInvoice = invoices.some((inv) => inv.state === INVOICE_STATE_OPEN);

  const totalDue = order.total_due || 0;
  const totalPaid = order.total_paid || 0;
  const grandTotal = order.grand_total || 0;
  const stillOwes = totalDue > 0.0001 || totalPaid < grandTotal - 0.0001;

  if (hasOpenInvoice && stillOwes) {
    return {
      isPrematureClosure: true,
      reason: "order closed with an unpaid (state=1/Pending) invoice and outstanding total_due",
    };
  }

  return { isPrematureClosure: false, reason: "invoice fully paid or no outstanding balance" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function closedOrders(pageSize = 200) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "closed",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": 1,
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

async function shipmentsForOrder(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/shipment", params);
  return data.items;
}

async function captureInvoice(invoiceId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/invoices/${invoiceId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function voidInvoice(invoiceId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/invoices/${invoiceId}/void`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  const orders = await closedOrders();
  for (const order of orders) {
    const orderId = order.entity_id;
    const invoices = await invoicesForOrder(orderId);
    const shipments = await shipmentsForOrder(orderId);
    const result = classifyPrematureClosure(order, invoices, shipments.length > 0);

    if (!result.isPrematureClosure) continue;

    const openInvoice = invoices.find((inv) => inv.state === INVOICE_STATE_OPEN);
    console.warn(
      `Order ${order.increment_id} (id=${orderId}) closed prematurely: invoice_id=${openInvoice?.entity_id} invoice_state=${openInvoice?.state} total_due=${order.total_due}. ${
        DRY_RUN ? "reporting only, human must confirm payment before capture/void" : "reporting only (no auto write to the order)"
      }`
    );
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) flagged as closed with a pending invoice.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
