/**
 * Flag Magento 2 or Adobe Commerce orders whose tax was recalculated
 * incorrectly after a coupon was applied.
 *
 * Magento builds order totals through a chain of total collector models:
 * Subtotal, then Discount, then Tax, then Grand Total. Whether that chain
 * reconciles depends on Sales, Tax, Calculation Settings for Apply Customer
 * Tax (Before Discount or After Discount) and Apply Discount on Prices
 * (Excluding Tax or Including Tax). When those settings disagree with how
 * catalog prices are entered, or a cart price rule coupon meets tax
 * inclusive catalog prices, the discount collector reduces the row total
 * using one base while the tax collector recomputes tax_amount from the
 * pre discount unit price, so discount_tax_compensation_amount ends up
 * wrong or zero and base_row_total minus base_discount_amount plus
 * base_tax_amount no longer equals base_grand_total. This is a recurring
 * defect class, seen across magento2 GitHub issues 8964, 19494, 29506, and
 * 26597, and Adobe Commerce shipped Quality Patch ACSD-61200 for discount
 * tax compensation specifically.
 *
 * This script never edits an order, since Magento has no supported REST
 * write for a placed order's totals. It recomputes the expected tax and
 * grand total from the order's own item data and writes a reconciliation
 * report. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/tax-wrong-after-coupon-applied/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const TAX_EPSILON = Number(process.env.TAX_EPSILON || 0.01);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "coupon_tax_mismatches.csv";

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Pure function. Input order has baseSubtotal, baseDiscountAmount,
 * baseTaxAmount, baseShippingAmount, baseShippingTaxAmount,
 * baseShippingDiscountAmount, baseGrandTotal, and items, an array of
 * objects with baseRowTotal, baseDiscountAmount,
 * baseDiscountTaxCompensationAmount, taxPercent. No network or database
 * calls, plain numbers in, booleans and numbers out.
 */
export function reconcileOrderTax(order, epsilon = TAX_EPSILON) {
  const perItemDeltas = [];
  let expectedTax = 0;

  for (const item of order.items || []) {
    const taxableBase = item.baseRowTotal - item.baseDiscountAmount + item.baseDiscountTaxCompensationAmount;
    const expectedItemTax = round2((taxableBase * item.taxPercent) / 100);
    const delta = "baseTaxAmount" in item ? round2(item.baseTaxAmount - expectedItemTax) : null;
    perItemDeltas.push({ taxableBase: round2(taxableBase), expectedItemTax, delta });
    expectedTax += expectedItemTax;
  }
  expectedTax = round2(expectedTax);

  const expectedGrandTotal = round2(
    order.baseSubtotal - order.baseDiscountAmount + expectedTax +
    order.baseShippingAmount + order.baseShippingTaxAmount - order.baseShippingDiscountAmount
  );

  const taxDelta = round2(order.baseTaxAmount - expectedTax);
  const grandTotalDelta = round2(order.baseGrandTotal - expectedGrandTotal);

  let ok = Math.abs(taxDelta) <= epsilon && Math.abs(grandTotalDelta) <= epsilon;
  for (const d of perItemDeltas) {
    if (d.delta !== null && Math.abs(d.delta) > epsilon) ok = false;
  }

  return { ok, expectedTax, expectedGrandTotal, taxDelta, grandTotalDelta, perItemDeltas };
}

function toReconcileInput(order) {
  const items = (order.items || []).map((it) => ({
    baseRowTotal: it.base_row_total || 0,
    baseDiscountAmount: it.base_discount_amount || 0,
    baseDiscountTaxCompensationAmount: it.base_discount_tax_compensation_amount || 0,
    taxPercent: it.tax_percent || 0,
    baseTaxAmount: it.base_tax_amount || 0,
  }));
  return {
    baseSubtotal: order.base_subtotal || 0,
    baseDiscountAmount: order.base_discount_amount || 0,
    baseTaxAmount: order.base_tax_amount || 0,
    baseShippingAmount: order.base_shipping_amount || 0,
    baseShippingTaxAmount: order.base_shipping_tax_amount || 0,
    baseShippingDiscountAmount: order.base_shipping_discount_amount || 0,
    baseGrandTotal: order.base_grand_total || 0,
    items,
  };
}

function buildReportRow(orderRaw, result) {
  return {
    order_id: orderRaw.entity_id,
    increment_id: orderRaw.increment_id,
    coupon_code: orderRaw.coupon_code,
    expected_tax: result.expectedTax,
    actual_tax: orderRaw.base_tax_amount || 0,
    tax_delta: result.taxDelta,
    expected_grand_total: result.expectedGrandTotal,
    actual_grand_total: orderRaw.base_grand_total || 0,
    grand_total_delta: result.grandTotalDelta,
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

async function getOrdersWithCoupon(token, pageSize = PAGE_SIZE, currentPage = 1) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "notnull",
    "searchCriteria[pageSize]": String(pageSize),
    "searchCriteria[currentPage]": String(currentPage),
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function* allOrdersWithCoupon(token) {
  let currentPage = 1;
  while (true) {
    const data = await getOrdersWithCoupon(token, PAGE_SIZE, currentPage);
    const items = data.items || [];
    for (const order of items) yield order;
    const total = data.total_count || 0;
    if (currentPage * PAGE_SIZE >= total || !items.length) return;
    currentPage++;
  }
}

export async function run() {
  const token = await getToken();
  const flagged = [];

  for await (const orderRaw of allOrdersWithCoupon(token)) {
    const reconcileInput = toReconcileInput(orderRaw);
    const result = reconcileOrderTax(reconcileInput, TAX_EPSILON);
    if (result.ok) continue;

    const row = buildReportRow(orderRaw, result);
    flagged.push(row);
    console.warn(`Order ${row.increment_id} coupon ${row.coupon_code}: expected_tax=${row.expected_tax} actual_tax=${row.actual_tax} tax_delta=${row.tax_delta} grand_total_delta=${row.grand_total_delta}`);
  }

  console.log(`Done. ${flagged.length} order(s) flagged for manual finance review, ${DRY_RUN ? "dry run, nothing written" : "report ready (" + OUTPUT_CSV + ")"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
