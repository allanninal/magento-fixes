/**
 * Flag Magento 2 or Adobe Commerce credit memos whose tax was computed from
 * the full order instead of the refunded items.
 *
 * Magento's credit memo tax totals collector is supposed to prorate tax per
 * line item using qty being refunded versus qty invoiced. Long standing bugs,
 * seen across magento2 GitHub issues 8797, 9929, 10982, 14713, 23938, 32222,
 * and 34586, instead cause it to copy the order's full tax_amount and
 * base_tax_amount onto the credit memo, notably when the credit memo is
 * created from the admin order view, when multiple partial credit memos are
 * issued against the same invoice, or when the display currency differs from
 * the base currency. CreditmemoItemInterface.tax_amount is a snapshot stored
 * at creation time, never re-derived later, so a wrong number stays wrong
 * forever.
 *
 * This script never edits an existing credit memo, since Magento has no
 * supported REST write for that. It recomputes the expected proportional tax
 * from the order's own item data, compares it to each credit memo's reported
 * base_tax_amount, and writes a reconciliation report. Only under an
 * explicit DRY_RUN=false does it optionally POST a new corrective refund
 * call carrying an adjustment_positive or adjustment_negative argument. In
 * dry run it only prints the proposed payload. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/partial-refund-tax-miscalculated/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const ORDER_IDS = (process.env.ORDER_IDS || "").split(",").map((o) => o.trim()).filter(Boolean);
const TAX_EPSILON = Number(process.env.TAX_EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. Takes only primitive numeric inputs already
 * extracted from the order/creditmemo JSON and returns a plain object for
 * the caller to log or act on. No I/O.
 */
export function isCreditMemoTaxMismatched(orderItemTaxAmount, orderItemQtyOrdered, creditMemoItemQty, creditMemoBaseTaxAmount, epsilon = TAX_EPSILON) {
  const expectedTax = orderItemQtyOrdered
    ? orderItemTaxAmount * (creditMemoItemQty / orderItemQtyOrdered)
    : 0;
  const delta = creditMemoBaseTaxAmount - expectedTax;
  return { expectedTax, delta, mismatched: Math.abs(delta) > epsilon };
}

/**
 * Sum the pure per-line expected tax across every refunded line on a credit
 * memo, using each order item's own tax_amount and qty_ordered.
 */
export function expectedTaxForCreditMemo(orderItemsById, creditMemo) {
  let expectedTotal = 0;
  for (const cmItem of creditMemo.items || []) {
    const orderItem = orderItemsById[cmItem.order_item_id];
    if (!orderItem) continue;
    expectedTotal += isCreditMemoTaxMismatched(
      orderItem.tax_amount || 0,
      orderItem.qty_ordered || 0,
      cmItem.qty || 0,
      0,
    ).expectedTax;
  }
  return expectedTotal;
}

export function buildAdjustmentPayload(delta) {
  if (delta > 0) return { arguments: { adjustment_negative: Math.round(delta * 100) / 100 } };
  return { arguments: { adjustment_positive: Math.round(Math.abs(delta) * 100) / 100 } };
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

async function getCreditmemosForOrder(token, orderId) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": "100",
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/creditmemo?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.items || [];
}

async function applyAdjustment(token, orderId, delta) {
  const payload = buildAdjustmentPayload(delta);
  const res = await fetch(`${MAGENTO_URL}/rest/V1/order/${orderId}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  const flagged = [];

  for (const orderId of ORDER_IDS) {
    const order = await getOrder(token, orderId);
    const orderItemsById = {};
    for (const item of order.items || []) orderItemsById[item.item_id] = item;
    const creditmemos = await getCreditmemosForOrder(token, orderId);

    for (const cm of creditmemos) {
      const expectedTax = expectedTaxForCreditMemo(orderItemsById, cm);
      const actualTax = cm.base_tax_amount || 0;
      const delta = actualTax - expectedTax;
      const mismatched = Math.abs(delta) > TAX_EPSILON;
      if (!mismatched) continue;

      const row = {
        order_increment_id: order.increment_id,
        creditmemo_increment_id: cm.increment_id,
        expected_tax: Math.round(expectedTax * 10000) / 10000,
        actual_tax: Math.round(actualTax * 10000) / 10000,
        delta: Math.round(delta * 10000) / 10000,
      };
      flagged.push(row);
      console.warn(`Order ${row.order_increment_id} creditmemo ${row.creditmemo_increment_id}: expected_tax=${row.expected_tax} actual_tax=${row.actual_tax} delta=${row.delta}`);

      const payload = buildAdjustmentPayload(delta);
      console.log("Proposed adjustment payload:", JSON.stringify(payload));
      if (!DRY_RUN) await applyAdjustment(token, orderId, delta);
    }
  }

  console.log(`Done. ${flagged.length} creditmemo(s) flagged, ${DRY_RUN ? "dry run, nothing written" : "corrective refund attempted where flagged"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
