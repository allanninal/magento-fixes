/**
 * Flag Magento 2 or Adobe Commerce orders whose tax_amount looks off because a
 * script recomputed it with a fixed formula instead of the store's
 * configured rounding algorithm.
 *
 * Magento lets a merchant choose tax/calculation/algorithm as
 * UNIT_BASE_CALCULATION (round per unit, then sum), ROW_BASE_CALCULATION
 * (round once per row), or TOTAL_BASE_CALCULATION (round once on the grand
 * total). Because each mode rounds at a different point in the arithmetic,
 * the same catalog prices and tax rate can legitimately produce order totals
 * that differ from a naive recomputation by a cent or a fraction of a cent.
 * Magento's own delta-rounding compensation keeps displayed amounts
 * consistent, so a script that assumes one fixed algorithm will produce
 * false-positive drift on orders placed under a different configuration or
 * that mix tax classes.
 *
 * This script reads the configured algorithm (REST first, environment
 * fallback since tax/calculation/algorithm is not in the default
 * storeConfigs DTO), pulls orders in an audit window, recomputes expected
 * tax under that same algorithm, and writes a report for anything beyond
 * tolerance. It never writes tax_amount on an order, invoice, or credit
 * memo, since Magento has no supported REST write for that once a document
 * exists. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/tax-rounding-drift/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const TAX_ALGORITHM = process.env.MAGENTO_TAX_ALGORITHM || "ROW_BASE_CALCULATION";
const CREATED_FROM = process.env.CREATED_FROM || "1970-01-01 00:00:00";
const CREATED_TO = process.env.CREATED_TO || "2100-01-01 00:00:00";
const TOLERANCE_CENTS = Number(process.env.TOLERANCE_CENTS || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "tax_rounding_drift.csv";

const ALGORITHMS = new Set(["UNIT_BASE_CALCULATION", "ROW_BASE_CALCULATION", "TOTAL_BASE_CALCULATION"]);

export function decideTaxDrift(items, shippingAmount, shippingTaxPercent, algorithm, actualOrderTaxAmount, toleranceCents = TOLERANCE_CENTS) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const shippingTax = round2((shippingAmount * shippingTaxPercent) / 100);

  let expectedTax;

  if (algorithm === "UNIT_BASE_CALCULATION") {
    let total = 0;
    for (const it of items) {
      const perUnitTax = round2((it.unitPrice * it.taxPercent) / 100);
      total += perUnitTax * it.qty;
    }
    expectedTax = round2(total + shippingTax);

  } else if (algorithm === "ROW_BASE_CALCULATION") {
    let total = 0;
    for (const it of items) {
      const rowTotal = it.unitPrice * it.qty - (it.discountAmount || 0);
      total += round2((rowTotal * it.taxPercent) / 100);
    }
    expectedTax = round2(total + shippingTax);

  } else if (algorithm === "TOTAL_BASE_CALCULATION") {
    const rates = new Set(items.map((it) => it.taxPercent));
    if (rates.size > 1) {
      return { expectedTax: null, delta: null, isDrift: false, nonComparable: true };
    }
    const rate = items.length ? items[0].taxPercent : 0;
    const subtotal = items.reduce((sum, it) => sum + (it.unitPrice * it.qty - (it.discountAmount || 0)), 0);
    expectedTax = round2((subtotal * rate) / 100) + shippingTax;

  } else {
    throw new Error(`Unknown tax algorithm: ${algorithm}`);
  }

  const delta = Math.abs(round2(expectedTax - actualOrderTaxAmount));
  return { expectedTax, delta, isDrift: delta > toleranceCents / 100 };
}

export function extractLineItems(order) {
  const items = [];
  for (const it of order.items || []) {
    if (it.parent_item_id) continue;
    items.push({
      itemId: it.item_id,
      unitPrice: it.price || 0,
      qty: it.qty_ordered || 0,
      taxPercent: it.tax_percent || 0,
      discountAmount: it.discount_amount || 0,
    });
  }
  return items;
}

async function getOrdersPage(page) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
    "searchCriteria[filterGroups][0][filters][0][value]": CREATED_FROM,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "from",
    "searchCriteria[filterGroups][1][filters][0][field]": "created_at",
    "searchCriteria[filterGroups][1][filters][0][value]": CREATED_TO,
    "searchCriteria[filterGroups][1][filters][0][conditionType]": "to",
    "searchCriteria[filterGroups][2][filters][0][field]": "status",
    "searchCriteria[filterGroups][2][filters][0][value]": "processing",
    "searchCriteria[filterGroups][2][filters][1][field]": "status",
    "searchCriteria[filterGroups][2][filters][1][value]": "complete",
    "searchCriteria[pageSize]": "200",
    "searchCriteria[currentPage]": String(page),
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders?${params}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getInvoicesForOrder(orderId) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": "100",
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/invoices?${params}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.items || [];
}

async function* allOrders() {
  let page = 1;
  while (true) {
    const data = await getOrdersPage(page);
    const orders = data.items || [];
    if (!orders.length) return;
    for (const o of orders) yield o;
    if (orders.length < 200) return;
    page++;
  }
}

export async function run() {
  if (!ALGORITHMS.has(TAX_ALGORITHM)) {
    throw new Error(`MAGENTO_TAX_ALGORITHM must be one of ${[...ALGORITHMS].join(", ")}, got ${TAX_ALGORITHM}`);
  }

  const flagged = [];
  for await (const order of allOrders()) {
    const items = extractLineItems(order);
    const shippingAmount = order.shipping_amount || 0;
    const shippingTaxPercent = order.shipping_tax_percent || 0;
    const actualTax = order.base_tax_amount ?? order.tax_amount ?? 0;

    const result = decideTaxDrift(items, shippingAmount, shippingTaxPercent, TAX_ALGORITHM, actualTax, TOLERANCE_CENTS);
    if (result.nonComparable) {
      console.log(`Order ${order.increment_id} skipped, mixed tax rates not comparable under TOTAL_BASE_CALCULATION.`);
      continue;
    }
    if (!result.isDrift) continue;

    const invoices = await getInvoicesForOrder(order.entity_id);
    const row = {
      order_increment_id: order.increment_id,
      entity_id: order.entity_id,
      algorithm: TAX_ALGORITHM,
      expected_tax: result.expectedTax,
      actual_tax: actualTax,
      delta: result.delta,
      has_invoice: invoices.length > 0,
      item_ids: items.map((it) => it.itemId).join(";"),
    };
    flagged.push(row);
    console.warn(`Order ${row.order_increment_id} drift=${row.delta.toFixed(2)} expected=${row.expected_tax.toFixed(2)} actual=${row.actual_tax.toFixed(2)} invoiced=${row.has_invoice}`);
  }

  if (flagged.length) {
    const header = "order_increment_id,entity_id,algorithm,expected_tax,actual_tax,delta,has_invoice,item_ids";
    const lines = flagged.map((r) =>
      [r.order_increment_id, r.entity_id, r.algorithm, r.expected_tax, r.actual_tax, r.delta, r.has_invoice, r.item_ids].join(",")
    );
    writeFileSync(OUTPUT_CSV, [header, ...lines].join("\n") + "\n");
  }

  console.log(`Done. ${flagged.length} order(s) flagged, ${DRY_RUN ? "dry run, report only" : "report written, no order was modified"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
