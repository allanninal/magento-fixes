/**
 * Repair Magento 2 or Adobe Commerce inventory_source_item rows left stale
 * after an Out-of-Stock Threshold change.
 *
 * Saving a new cataloginventory/options/stock_threshold_qty value fires
 * admin_system_config_changed_section_cataloginventory, which correctly
 * recalculates the legacy cataloginventory_stock_item.is_in_stock flag. MSI
 * has no matching observer for inventory_source_item, so existing source
 * items keep whichever status value the old threshold produced until
 * quantity changes on its own or a full reindex and cron pass happen to
 * touch them. This script pages through the catalog, reads every source
 * item's quantity and stored status, recomputes the status each should have
 * under the current threshold and backorders setting, and by default only
 * reports the mismatches. Only under an explicit DRY_RUN=false operator
 * override does it PUT the corrected status. It never touches quantity. Run
 * on a schedule after any threshold change. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/threshold-change-not-applied-existing-items/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STOCK_THRESHOLD_QTY = Number(process.env.STOCK_THRESHOLD_QTY || 0);
const BACKORDERS_ENABLED = (process.env.BACKORDERS_ENABLED || "false").toLowerCase() === "true";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function recomputeSourceItemStatus(quantity, threshold, backordersEnabled) {
  if (backordersEnabled && threshold <= 0) return 1;
  const salable = quantity - threshold;
  return salable > 0 ? 1 : 0;
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPut(path, body) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function productsPage(pageSize, currentPage) {
  const params = {
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/products", params);
  return data.items;
}

async function* allProducts(pageSize) {
  let page = 1;
  while (true) {
    const items = await productsPage(pageSize, page);
    if (!items.length) return;
    for (const item of items) yield item;
    if (items.length < pageSize) return;
    page++;
  }
}

async function sourceItemsForSku(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/inventory/source-items", params);
  return data.items;
}

async function repairSourceItem(sku, sourceCode, quantity, newStatus) {
  const body = { sourceItems: [{ sku, source_code: sourceCode, quantity, status: newStatus }] };
  return magentoPut("/inventory/source-items", body);
}

export async function run() {
  let fixed = 0;
  for await (const product of allProducts(PAGE_SIZE)) {
    const sku = product.sku;
    for (const item of await sourceItemsForSku(sku)) {
      const sourceCode = item.source_code;
      const quantity = item.quantity || 0;
      const oldStatus = item.status;
      const newStatus = recomputeSourceItemStatus(quantity, STOCK_THRESHOLD_QTY, BACKORDERS_ENABLED);

      if (oldStatus === newStatus) continue;

      console.warn(
        `Stale status: sku=${sku} source_code=${sourceCode} quantity=${quantity} threshold=${STOCK_THRESHOLD_QTY} old_status=${oldStatus} new_status=${newStatus}. ${
          DRY_RUN ? "would repair" : "repairing"
        }`
      );
      if (!DRY_RUN) await repairSourceItem(sku, sourceCode, quantity, newStatus);
      fixed++;
    }
  }

  if (!DRY_RUN && fixed) {
    console.log("Run bin/magento indexer:reindex cataloginventory_stock and bin/magento cron:run to reconcile the legacy stock item and salable quantity index.");
  }
  console.log(`Done. ${fixed} source item(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
