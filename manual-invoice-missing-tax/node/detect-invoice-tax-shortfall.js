/**
 * Detect Magento 2 or Adobe Commerce orders where a manually created partial
 * invoice dropped its share of tax, leaving a false amount due.
 *
 * When an admin manually invoices an order in more than one pass, for example
 * invoicing simple products separately from a virtual product via Sales,
 * Orders, Invoice, Magento's Sales\Model\Order\Invoice\Total collectors for
 * Tax, Subtotal, and Grand Total prorate tax across invoices by each item's
 * invoiced quantity ratio. A documented core bug, magento2 issue 38978,
 * reproduced on 2.4.3-p3, causes the tax portion belonging to items on a
 * later invoice to be dropped instead of allocated. That invoice's
 * base_tax_amount and base_grand_total come out short by exactly the
 * missing item's tax. Because Magento only derives total_paid by summing
 * each invoice's own already wrong grand_total, the order ends up with a
 * total_due that should not exist.
 *
 * This script never edits, voids, or cancels an invoice, since Magento has
 * no supported REST write for that. It compares the order's own
 * base_grand_total and base_tax_amount against what its invoices actually
 * total, writes a report row for every order it flags, and exits non-zero
 * so CI or alerting notices. A human reconciles the order in the Admin, for
 * example with a credit memo without invoice or by cancelling and
 * reissuing the affected invoice. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/manual-invoice-missing-tax/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const ORDER_IDS = (process.env.ORDER_IDS || "").split(",").map((o) => o.trim()).filter(Boolean);
const AMOUNT_EPSILON = Number(process.env.AMOUNT_EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);

/**
 * Pure decision function. order and invoices are plain numeric structs (see
 * orderToStruct / invoiceToStruct), so this needs no network and is easy to
 * unit test with fixtures mirroring the #38978 scenario.
 */
export function detectInvoiceTaxShortfall(order, invoices, epsilon = AMOUNT_EPSILON) {
  const invoicedGrandTotal = invoices.reduce((sum, inv) => sum + (inv.baseGrandTotal || 0), 0);
  const invoicedTax = invoices.reduce((sum, inv) => sum + (inv.baseTaxAmount || 0), 0);
  const grandTotalDelta = order.baseGrandTotal - invoicedGrandTotal;
  const taxDelta = order.baseTaxAmount - invoicedTax;
  const isShortfall = order.totalDue > epsilon && taxDelta > epsilon && grandTotalDelta > epsilon;
  return { isShortfall, invoicedGrandTotal, invoicedTax, taxDelta, grandTotalDelta };
}

export function orderToStruct(order) {
  return {
    baseGrandTotal: order.base_grand_total || 0,
    baseTaxAmount: order.base_tax_amount || 0,
    totalDue: order.total_due || 0,
  };
}

export function invoiceToStruct(invoice) {
  return {
    baseGrandTotal: invoice.base_grand_total || 0,
    baseTaxAmount: invoice.base_tax_amount || 0,
  };
}

export function buildReportRow(order, invoices, result) {
  return {
    order_id: order.entity_id,
    increment_id: order.increment_id,
    expected_tax: Math.round((order.base_tax_amount || 0) * 10000) / 10000,
    invoiced_tax: Math.round(result.invoicedTax * 10000) / 10000,
    delta: Math.round(result.taxDelta * 10000) / 10000,
    invoice_ids: invoices.map((inv) => inv.entity_id).join(";"),
  };
}

async function getToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  const res = await fetch(`${MAGENTO_URL}/rest/V1/integration/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getOrder(token, orderId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getInvoicesForOrder(token, orderId, pageSize = PAGE_SIZE) {
  const invoices = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
      "searchCriteria[filterGroups][0][filters][0][value]": orderId,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": String(pageSize),
      "searchCriteria[currentPage]": String(page),
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/invoices?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Magento ${res.status}`);
    const body = await res.json();
    const items = body.items || [];
    invoices.push(...items);
    if (items.length < pageSize) return invoices;
    page += 1;
  }
}

export async function run() {
  const token = await getToken();
  const flagged = [];

  for (const orderId of ORDER_IDS) {
    const order = await getOrder(token, orderId);
    const invoices = await getInvoicesForOrder(token, orderId);

    const result = detectInvoiceTaxShortfall(
      orderToStruct(order),
      invoices.map(invoiceToStruct),
    );

    if (!result.isShortfall) continue;

    const row = buildReportRow(order, invoices, result);
    flagged.push(row);
    console.warn(`Order ${row.increment_id} missing invoice tax: expected_tax=${row.expected_tax} invoiced_tax=${row.invoiced_tax} delta=${row.delta} invoice_ids=${row.invoice_ids}`);
  }

  console.log(`Done. ${flagged.length} order(s) flagged with a missing invoice tax shortfall.${DRY_RUN ? " (dry run, report only)" : ""}`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((flagged) => { if (flagged.length) process.exit(1); })
    .catch((err) => { console.error(err); process.exit(1); });
}
