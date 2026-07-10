/**
 * Detect Magento 2 or Adobe Commerce websites whose shared stock has drifted
 * out of sync.
 *
 * MSI computes salable quantity per stock_id, source item quantity assigned to
 * that stock minus every outstanding reservation keyed by SKU and stock_id. Two
 * websites only share one pool of stock when their sales channels both resolve
 * to the same stock_id. "Not synced" oversell almost always means that mapping
 * drifted, a website's sales channel was reassigned to a different stock, or
 * some legacy or third party code wrote quantity directly into the deprecated
 * cataloginventory_stock_item table instead of creating a reservation, bypassing
 * the reservation ledger entirely. This script resolves each website's actual
 * stock_id, reads its salable quantity for a SKU, and flags any drift or
 * mismatch. It never reassigns a stock or writes product data: that stays a
 * deliberate admin decision made in Stores, Configuration, Sales Channels, plus
 * a CLI reindex and manual reservation reconciliation for legacy write paths.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/shared-stock-not-synced-across-websites/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const SKU = process.env.SKU || "";
const EXPECTED_SHARED_STOCK_ID = Number(process.env.EXPECTED_SHARED_STOCK_ID || 1);
const WEBSITE_CODES = (process.env.WEBSITE_CODES || "").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function detectStockDesync(websiteStockReports, expectedSharedStockId) {
  const driftedWebsites = [];
  const qtyMismatches = [];

  for (const report of websiteStockReports) {
    if (report.stock_id !== expectedSharedStockId) {
      driftedWebsites.push(report.website_code);
    }
  }

  const inSyncGroup = websiteStockReports.filter((r) => r.stock_id === expectedSharedStockId);
  if (inSyncGroup.length) {
    const baseQty = inSyncGroup[0].salable_qty;
    for (const report of inSyncGroup) {
      if (report.salable_qty !== baseQty) {
        qtyMismatches.push({ website_code: report.website_code, salable_qty: report.salable_qty });
      }
    }
  }

  const inSync = driftedWebsites.length === 0 && qtyMismatches.length === 0;
  return { inSync, driftedWebsites, qtyMismatches };
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

async function productWebsiteIds(token, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}/websites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function resolveStockIdForWebsite(token, websiteCode) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/inventory/stock-resolver/website/${encodeURIComponent(websiteCode)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function salableQty(token, sku, stockId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/inventory/get-product-salable-quantity/${encodeURIComponent(sku)}/${stockId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function sourceItemsForSku(token, sku) {
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
  return body.items || [];
}

export async function run() {
  if (!SKU || !WEBSITE_CODES.length) {
    console.error("SKU and WEBSITE_CODES must both be set.");
    return 2;
  }

  const token = await getToken();
  const assignedWebsiteIds = await productWebsiteIds(token, SKU);
  console.log(`SKU ${SKU} is assigned to website ids: ${JSON.stringify(assignedWebsiteIds)}`);

  const reports = [];
  for (const websiteCode of WEBSITE_CODES) {
    const stockId = await resolveStockIdForWebsite(token, websiteCode);
    const qty = await salableQty(token, SKU, stockId);
    reports.push({ website_code: websiteCode, stock_id: stockId, salable_qty: qty });
  }

  const sourceItems = await sourceItemsForSku(token, SKU);
  const sourceQtySum = sourceItems.reduce((sum, item) => sum + (item.quantity || 0), 0);

  const verdict = detectStockDesync(reports, EXPECTED_SHARED_STOCK_ID);

  const report = {
    sku: SKU,
    expected_shared_stock_id: EXPECTED_SHARED_STOCK_ID,
    websites: reports,
    source_items_qty_sum: sourceQtySum,
    in_sync: verdict.inSync,
    drifted_websites: verdict.driftedWebsites,
    qty_mismatches: verdict.qtyMismatches,
  };
  console.log(JSON.stringify(report, null, 2));

  if (verdict.inSync) {
    console.log(`Done. Websites are in sync for SKU ${SKU}.`);
    return 0;
  }

  console.warn(
    `Done. SKU ${SKU} is NOT in sync. Drifted websites: ${JSON.stringify(verdict.driftedWebsites)}. ` +
    `Qty mismatches: ${JSON.stringify(verdict.qtyMismatches)}. ` +
    `${DRY_RUN ? "dry run, nothing written" : "report only, no write ever attempted"}.`
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(err); process.exit(1); });
}
