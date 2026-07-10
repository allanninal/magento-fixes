/**
 * Flag Magento 2 or Adobe Commerce order lines whose reservation placement
 * was skipped because the order was created directly through POST /V1/orders.
 *
 * MSI reduces salable quantity only by writing an append only, negative row to
 * inventory_reservation. That row is written by a plugin hooked to the
 * sales_order_place_after event, which fires from the normal quote to order
 * checkout pipeline, OrderManagementInterface::place. An order built and
 * persisted directly through POST /V1/orders, the way ERPs and marketplaces
 * inject historical or external orders, never runs that pipeline, so the
 * reservation plugin never executes for those items. This script lists recent
 * open orders, sums qty_ordered per SKU, and cross checks that against source
 * item quantity minus reported salable quantity for the same SKU. Any
 * shortfall means a reservation was never written, and it is attributed back
 * to the earliest under reserved order lines. There is no REST endpoint to
 * create a reservation, so this script only reports, unless DRY_RUN=false and
 * an operator has confirmed the guarded legacy stock_item stopgap. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/magento/rest-orders-skip-reservation-placement/
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const STOCK_ID = process.env.STOCK_ID || "1";
const ORDER_STATUSES = (process.env.ORDER_STATUSES || "processing,pending").split(",").map((s) => s.trim()).filter(Boolean);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "unreserved_order_items.csv";
const APPLIED_LEDGER = process.env.APPLIED_LEDGER || "unreserved_stopgap_applied.json";

/**
 * Pure, no I/O. For each SKU, sums qtyOrdered across all openOrders to get
 * expectedReserved; computes actualReserved = sourceQtyBySku[sku] -
 * salableQtyBySku[sku]; if actualReserved < expectedReserved, walks
 * openOrders again in order and attributes the shortfall to the earliest
 * order items for that SKU until the shortfall is exhausted. Returns one
 * finding per under-reserved order/SKU pair with missingReservationQty equal
 * to the un-reflected quantity for that line.
 */
export function findUnreservedOrderItems(openOrders, sourceQtyBySku, salableQtyBySku) {
  const expectedBySku = {};
  for (const order of openOrders) {
    for (const item of order.items) {
      expectedBySku[item.sku] = (expectedBySku[item.sku] || 0) + item.qtyOrdered;
    }
  }

  const findings = [];
  for (const [sku, expectedReserved] of Object.entries(expectedBySku)) {
    const sourceQty = sourceQtyBySku[sku] || 0;
    const salableQty = salableQtyBySku[sku] || 0;
    const actualReserved = sourceQty - salableQty;
    let remaining = expectedReserved - actualReserved;
    if (remaining <= 0) continue;

    for (const order of openOrders) {
      if (remaining <= 0) break;
      for (const item of order.items) {
        if (item.sku !== sku) continue;
        const take = Math.min(remaining, item.qtyOrdered);
        if (take <= 0) continue;
        findings.push({
          incrementId: order.incrementId,
          sku,
          qtyOrdered: item.qtyOrdered,
          missingReservationQty: take,
        });
        remaining -= take;
      }
    }
  }
  return findings;
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

async function listOpenOrders(token, sinceIso, statuses, pageSize = 100) {
  const orders = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
      "searchCriteria[filterGroups][0][filters][0][value]": sinceIso,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
      "searchCriteria[pageSize]": String(pageSize),
      "searchCriteria[currentPage]": String(page),
    });
    statuses.forEach((status, i) => {
      params.set(`searchCriteria[filterGroups][1][filters][${i}][field]`, "status");
      params.set(`searchCriteria[filterGroups][1][filters][${i}][value]`, status);
      params.set(`searchCriteria[filterGroups][1][filters][${i}][conditionType]`, "eq");
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/orders?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Magento ${res.status}`);
    const body = await res.json();
    const items = body.items || [];
    orders.push(...items);
    if (items.length < pageSize) return orders;
    page += 1;
  }
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

async function salableQty(token, sku, stockId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/${encodeURIComponent(sku)}/${stockId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function applyStopgapStockCorrection(token, sku, currentQty, missingQty) {
  const newQty = currentQty - missingQty;
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ product: { sku, extension_attributes: { stock_item: { qty: newQty } } } }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return newQty;
}

function loadAppliedLedger() {
  if (fs.existsSync(APPLIED_LEDGER)) {
    return new Set(JSON.parse(fs.readFileSync(APPLIED_LEDGER, "utf8")));
  }
  return new Set();
}

function saveAppliedLedger(applied) {
  fs.writeFileSync(APPLIED_LEDGER, JSON.stringify([...applied].sort()));
}

export async function run() {
  const token = await getToken();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000);
  const sinceIso = since.toISOString().slice(0, 19).replace("T", " ");
  const rawOrders = await listOpenOrders(token, sinceIso, ORDER_STATUSES);

  const openOrders = [];
  for (const order of rawOrders) {
    const items = (order.items || [])
      .filter((line) => (line.qty_ordered || 0) > 0)
      .map((line) => ({ sku: line.sku, qtyOrdered: line.qty_ordered || 0 }));
    if (items.length) openOrders.push({ incrementId: order.increment_id, items });
  }

  const skus = [...new Set(openOrders.flatMap((order) => order.items.map((item) => item.sku)))];
  const sourceQtyBySku = {};
  const salableQtyBySku = {};
  for (const sku of skus) {
    sourceQtyBySku[sku] = await sourceQtySum(token, sku);
    salableQtyBySku[sku] = await salableQty(token, sku, STOCK_ID);
  }

  const findings = findUnreservedOrderItems(openOrders, sourceQtyBySku, salableQtyBySku);

  const applied = loadAppliedLedger();
  for (const finding of findings) {
    console.log(`Order ${finding.incrementId} SKU ${finding.sku}: qty_ordered=${finding.qtyOrdered} missing_reservation_qty=${finding.missingReservationQty}`);
    const ledgerKey = `${finding.incrementId}:${finding.sku}`;
    if (DRY_RUN || applied.has(ledgerKey)) continue;
    await applyStopgapStockCorrection(token, finding.sku, sourceQtyBySku[finding.sku], finding.missingReservationQty);
    applied.add(ledgerKey);
  }
  if (!DRY_RUN && findings.length) saveAppliedLedger(applied);

  console.log(
    `Done. ${findings.length} order/SKU pair(s) flagged, ${DRY_RUN ? "dry run, nothing written" : "stopgap applied where confirmed"}. ` +
    `No REST endpoint writes inventory_reservation; switch order ingestion to the checkout flow or run the CLI reservation tooling.`
  );
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
