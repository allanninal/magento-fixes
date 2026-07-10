/**
 * Flag Magento 2 credit memos whose total or tax is wrong on a multi invoice order.
 *
 * Magento's credit memo total collectors (Magento\Sales\Model\Order\Creditmemo\Total\Tax
 * and the related shipping and discount collectors) compute refundable tax and totals
 * mainly from the parent order's aggregate tax_amount rather than proportionally from
 * the specific invoice being refunded. When an order was split into two or more
 * invoices, each invoice and credit memo pair needs to prorate tax and shipping by the
 * items actually invoiced and refunded, and the collectors do not consistently subtract
 * tax already refunded by prior credit memos tied to earlier invoices on the same order.
 * A credit memo has no supported REST endpoint to mutate its totals after creation, so
 * this only reports the discrepancy. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/credit-memo-total-wrong-multi-invoice/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const TOLERANCE_CENTS = Number(process.env.TOLERANCE_CENTS || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REFUND_ALLOWLIST = new Set(
  (process.env.REFUND_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean)
);

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function decideCreditMemoDiscrepancy(creditMemo, parentInvoice, priorCreditMemosForInvoice,
                                             toleranceCents = 0.01) {
  const invoiceItemsById = new Map(parentInvoice.items.map((item) => [item.itemId, item]));

  let expectedTaxAmount = 0;
  let expectedItemsTotal = 0;
  for (const item of creditMemo.items) {
    const invoiceItem = invoiceItemsById.get(item.itemId);
    let perUnitTax = 0;
    let perUnitRow = 0;
    if (invoiceItem && invoiceItem.qtyInvoiced) {
      perUnitTax = invoiceItem.baseTaxAmount / invoiceItem.qtyInvoiced;
      perUnitRow = invoiceItem.baseRowTotal / invoiceItem.qtyInvoiced;
    } else if (item.qtyRefunded) {
      perUnitRow = item.baseRowTotal / item.qtyRefunded;
    }
    expectedTaxAmount += perUnitTax * item.qtyRefunded;
    expectedItemsTotal += perUnitRow * item.qtyRefunded;
  }

  const expectedGrandTotal =
    expectedItemsTotal + creditMemo.baseShippingAmount + expectedTaxAmount
    - creditMemo.adjustmentNegative + creditMemo.adjustmentPositive;

  const deltaGrandTotal = round2(creditMemo.baseGrandTotal - expectedGrandTotal);
  const deltaTaxAmount = round2(creditMemo.baseTaxAmount - expectedTaxAmount);

  const priorTotal = priorCreditMemosForInvoice.reduce((sum, cm) => sum + cm.baseGrandTotal, 0);
  const overRefund = (priorTotal + creditMemo.baseGrandTotal) > (parentInvoice.baseGrandTotal + toleranceCents);

  let reason;
  if (overRefund) reason = "over_refund";
  else if (Math.abs(deltaTaxAmount) > toleranceCents) reason = "tax_mismatch";
  else if (Math.abs(deltaGrandTotal) > toleranceCents) reason = "grand_total_mismatch";
  else reason = "ok";

  return {
    isDiscrepant: reason !== "ok",
    expectedGrandTotal: round2(expectedGrandTotal),
    expectedTaxAmount: round2(expectedTaxAmount),
    deltaGrandTotal,
    deltaTaxAmount,
    reason,
  };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPost(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function ordersCompleteOrClosed(pageSize = 200, currentPage = 1) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[filterGroups][0][filters][0][value]": "complete,closed",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function invoicesForOrder(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
  };
  const data = await magentoGet("/invoices", params);
  return data.items;
}

async function creditmemosForInvoice(invoiceId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "invoice_id",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[filterGroups][0][filters][0][value]": invoiceId,
  };
  const data = await magentoGet("/creditmemo", params);
  return data.items;
}

function normalizeInvoice(raw) {
  return {
    entityId: raw.entity_id,
    baseGrandTotal: raw.base_grand_total || 0,
    baseTaxAmount: raw.base_tax_amount || 0,
    items: (raw.items || []).map((item) => ({
      itemId: item.item_id || item.order_item_id,
      qtyInvoiced: item.qty || 0,
      baseTaxAmount: item.base_tax_amount || 0,
      baseRowTotal: item.base_row_total || 0,
    })),
  };
}

function normalizeCreditmemo(raw) {
  return {
    entityId: raw.entity_id,
    incrementId: raw.increment_id,
    invoiceId: raw.invoice_id,
    baseGrandTotal: raw.base_grand_total || 0,
    baseTaxAmount: raw.base_tax_amount || 0,
    baseShippingAmount: raw.base_shipping_amount || 0,
    adjustmentPositive: raw.adjustment_positive || 0,
    adjustmentNegative: raw.adjustment_negative || 0,
    items: (raw.items || []).map((item) => ({
      itemId: item.order_item_id,
      qtyRefunded: item.qty || 0,
      baseRowTotal: item.base_row_total || 0,
      baseTaxAmount: item.base_tax_amount || 0,
    })),
  };
}

async function compensatingRefund(orderId, positiveAdjustment) {
  const payload = {
    arguments: {
      adjustment_positive: positiveAdjustment,
      adjustment_negative: 0,
    },
  };
  return magentoPost(`/order/${orderId}/refund`, payload);
}

export async function run() {
  const flagged = [];
  const rawOrders = await ordersCompleteOrClosed();

  for (const rawOrder of rawOrders) {
    const orderId = rawOrder.entity_id;
    const rawInvoices = await invoicesForOrder(orderId);
    if (rawInvoices.length < 2) continue;

    for (const rawInvoice of rawInvoices) {
      const invoice = normalizeInvoice(rawInvoice);
      const rawCreditMemos = await creditmemosForInvoice(invoice.entityId);
      const creditMemos = rawCreditMemos.map(normalizeCreditmemo);

      creditMemos.forEach((creditMemo, i) => {
        const prior = creditMemos.slice(0, i);
        const result = decideCreditMemoDiscrepancy(creditMemo, invoice, prior, TOLERANCE_CENTS);
        if (result.isDiscrepant) {
          flagged.push({
            orderIncrementId: rawOrder.increment_id,
            creditmemoIncrementId: creditMemo.incrementId,
            invoiceId: invoice.entityId,
            expectedGrandTotal: result.expectedGrandTotal,
            actualGrandTotal: creditMemo.baseGrandTotal,
            expectedTaxAmount: result.expectedTaxAmount,
            actualTaxAmount: creditMemo.baseTaxAmount,
            delta: result.deltaGrandTotal,
            reason: result.reason,
          });
        }
      });
    }
  }

  for (const row of flagged) {
    console.warn(
      `Order ${row.orderIncrementId} creditmemo ${row.creditmemoIncrementId} (invoice ${row.invoiceId}) is ` +
      `${row.reason}. expected grand total ${row.expectedGrandTotal.toFixed(2)}, actual ${row.actualGrandTotal.toFixed(2)} ` +
      `(delta ${row.delta.toFixed(2)}).`
    );
  }

  if (flagged.length) {
    console.error(`${flagged.length} credit memo(s) discrepant. This script never edits them directly.`);
  } else {
    console.log("Done. No credit memo discrepancies found.");
  }

  if (!DRY_RUN && REFUND_ALLOWLIST.size) {
    for (const row of flagged) {
      if (REFUND_ALLOWLIST.has(row.orderIncrementId) && row.delta < 0) {
        console.warn(`Creating compensating refund for order ${row.orderIncrementId} (short by ${(-row.delta).toFixed(2)}).`);
        await compensatingRefund(row.orderIncrementId, -row.delta);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
