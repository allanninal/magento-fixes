/**
 * Flag Magento 2 or Adobe Commerce SKUs where MSI salable quantity is corrupted
 * by a missed reservation compensation.
 *
 * MSI never stores salable quantity. It computes it as source item quantity minus
 * the sum of every inventory_reservation row for a SKU and stock. When one order
 * event, place, invoice, ship, cancel, or credit memo, fails to write its
 * compensating reservation, that running sum drifts away from the real committed
 * quantity and the reported salable quantity is permanently offset. This script
 * cross references source items, the MSI reported salable quantity, and open
 * order items to independently derive the expected salable quantity, and flags
 * any SKU where the two disagree beyond a tolerance. It never writes a
 * reservation row: that can only be done with
 * bin/magento inventory:reservation:list-inconsistencies -r piped into
 * bin/magento inventory:reservation:create-compensations. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/magento/salable-quantity-corrupted-by-reservations/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const STOCK_ID = process.env.STOCK_ID || "1";
const SKUS = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
const RESERVATION_TOLERANCE = Number(process.env.RESERVATION_TOLERANCE || 0.0001);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const COMPENSATION_COMMAND =
  "bin/magento inventory:reservation:list-inconsistencies -r " +
  "| bin/magento inventory:reservation:create-compensations";

/**
 * Pure decision function. No I/O.
 *
 * Computes expectedSalableQty = sourceQty - openOrderItemQtySum,
 * delta = reportedSalableQty - expectedSalableQty, and
 * isConsistent = Math.abs(delta) <= tolerance.
 */
export function reconcileSalableQty(sourceQty, reportedSalableQty, openOrderItemQtySum, tolerance = RESERVATION_TOLERANCE) {
  const expectedSalableQty = sourceQty - openOrderItemQtySum;
  const delta = reportedSalableQty - expectedSalableQty;
  const isConsistent = Math.abs(delta) <= tolerance;
  return { isConsistent, expectedSalableQty, delta };
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

async function sourceQtySum(token, sku) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/inventory/source-items?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  const items = body.items || [];
  return items.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

async function reportedSalableQty(token, sku, stockId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/${encodeURIComponent(sku)}/${stockId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function openOrderItemQtySum(token, sku) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "processing",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[filterGroups][1][filters][0][field]": "status",
    "searchCriteria[filterGroups][1][filters][0][value]": "pending",
    "searchCriteria[filterGroups][1][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": "200",
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  let total = 0;
  const affectedOrderIds = [];
  for (const order of body.items || []) {
    for (const line of order.items || []) {
      if (line.sku === sku) {
        const qtyUnfulfilled = (line.qty_ordered || 0) - (line.qty_shipped || 0) - (line.qty_canceled || 0);
        if (qtyUnfulfilled > 0) {
          total += qtyUnfulfilled;
          affectedOrderIds.push(order.entity_id);
        }
      }
    }
  }
  return { total, affectedOrderIds };
}

function printCompensationCommand() {
  console.warn("No REST endpoint can write a reservation compensation row.");
  console.warn("Run this on the server to repair the flagged SKUs:");
  console.warn(`  ${COMPENSATION_COMMAND}`);
}

export async function run() {
  const token = await getToken();
  const flagged = [];
  for (const sku of SKUS) {
    const srcQty = await sourceQtySum(token, sku);
    const reportedQty = await reportedSalableQty(token, sku, STOCK_ID);
    const { total: openQty, affectedOrderIds } = await openOrderItemQtySum(token, sku);
    const verdict = reconcileSalableQty(srcQty, reportedQty, openQty);
    if (verdict.isConsistent) continue;
    const row = {
      sku,
      stock_id: STOCK_ID,
      source_qty_sum: srcQty,
      reported_salable_qty: reportedQty,
      expected_salable_qty: verdict.expectedSalableQty,
      delta: verdict.delta,
      affected_open_order_ids: affectedOrderIds.join(";"),
    };
    flagged.push(row);
    console.log(`SKU ${sku} stock ${STOCK_ID}: reported=${reportedQty} expected=${verdict.expectedSalableQty} delta=${verdict.delta}`);
  }

  if (flagged.length) {
    printCompensationCommand();
  }

  console.log(`Done. ${flagged.length} SKU(s) flagged, ${DRY_RUN ? "dry run, nothing written" : "report only, no write ever attempted"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
