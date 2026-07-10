/**
 * Flag Magento 2 SKUs where salable quantity has gone negative or oversold, safely.
 *
 * MSI computes salable quantity as sum(in-stock source_items quantities) minus
 * sum of outstanding reservations, an append-only ledger. If a compensating
 * reservation for a cancelled or failed order is lost, the ledger keeps an
 * orphaned entry and salable quantity drifts below zero forever, even though
 * physical stock is fine. Backorders set to allow qty below zero can make a
 * negative number expected instead of broken. Reservations are never rewritten
 * here; the only write this script performs is pausing further sales
 * (is_in_stock=false) on a confirmed critical oversell. The actual ledger
 * repair stays a CLI-only operation for an admin to run. Safe to run again
 * and again.
 *
 * Guide: https://www.allanninal.dev/magento/salable-quantity-negative-oversell/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STOCK_ID = process.env.STOCK_ID || "1";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function decideSalableQtyAction(sku, salableQty, physicalQty, openOrderQtyTotal, stockItemConfig, toleranceUnits = 0) {
  if (!stockItemConfig.manageStock) {
    return {
      flag: true,
      severity: "warning",
      reason: "manage_stock disabled: product always shows in-stock, oversell not tracked",
    };
  }

  const backorders = stockItemConfig.backorders || 0;

  if (salableQty < 0 && backorders === 0) {
    return {
      flag: true,
      severity: "critical",
      reason: "negative salable qty with backorders disabled: true oversell, invariant broken",
    };
  }

  if (salableQty < 0 && backorders !== 0) {
    if (Math.abs(salableQty) > openOrderQtyTotal + physicalQty) {
      return {
        flag: true,
        severity: "critical",
        reason: "reservation total exceeds open order demand: phantom/duplicate reservations",
      };
    }
    return { flag: false, severity: "ok", reason: "negative salable qty is expected backorder behavior" };
  }

  const expectedSalable = physicalQty - openOrderQtyTotal;
  if (Math.abs(salableQty - expectedSalable) > toleranceUnits) {
    return {
      flag: true,
      severity: "warning",
      reason: "salable qty does not reconcile with source_items minus open reservations: stale index or lost/duplicated reservation",
    };
  }

  return { flag: false, severity: "ok", reason: "consistent" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getSalableQty(sku, stockId) {
  const data = await magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
  return Number(data);
}

async function getPhysicalQty(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/inventory/source-items", params);
  return data.items.filter((i) => i.status === 1).reduce((sum, i) => sum + i.quantity, 0);
}

async function getStockItemConfig(sku) {
  const product = await magentoGet(`/products/${sku}`);
  const stockItem = product.extension_attributes.stock_item;
  return {
    manageStock: Boolean(stockItem.manage_stock),
    backorders: Number(stockItem.backorders || 0),
  };
}

async function getOpenOrderQtyTotal(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "complete,closed,canceled",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "nin",
  };
  const data = await magentoGet("/orders", params);
  let total = 0;
  for (const order of data.items) {
    for (const item of order.items || []) {
      if (item.sku === sku) total += Number(item.qty_ordered || 0);
    }
  }
  return total;
}

async function pauseSales(sku) {
  const payload = { product: { sku, extension_attributes: { stock_item: { is_in_stock: false } } } };
  if (DRY_RUN) {
    console.log(`DRY_RUN: would PUT /products/${sku} with`, JSON.stringify(payload));
    return;
  }
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${sku}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
}

export async function run(skus = []) {
  let flagged = 0;
  for (const sku of skus) {
    const salableQty = await getSalableQty(sku, STOCK_ID);
    const physicalQty = await getPhysicalQty(sku);
    const openOrderQtyTotal = await getOpenOrderQtyTotal(sku);
    const stockItemConfig = await getStockItemConfig(sku);

    const result = decideSalableQtyAction(sku, salableQty, physicalQty, openOrderQtyTotal, stockItemConfig);

    if (!result.flag) continue;

    console.warn(
      `SKU ${sku}: ${result.severity} (salable=${salableQty}, physical=${physicalQty}, openOrders=${openOrderQtyTotal}). ${result.reason}`
    );

    if (result.severity === "critical" && result.reason.includes("oversell")) {
      await pauseSales(sku);
    }

    flagged++;
  }
  console.log(`Done. ${flagged} SKU(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skus = (process.env.CHECK_SKUS || "").split(",").filter(Boolean);
  run(skus).catch((err) => { console.error(err); process.exit(1); });
}
