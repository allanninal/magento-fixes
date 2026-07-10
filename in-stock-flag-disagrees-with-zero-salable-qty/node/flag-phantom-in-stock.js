/**
 * Flag Magento 2 products where is_in_stock disagrees with zero salable quantity.
 *
 * MSI keeps is_in_stock as a slow-changing flag refreshed by the cataloginventory
 * and legacy stock indexers, while salable quantity is computed on demand from
 * source_items minus active reservations. A checkout reservation lands
 * synchronously, so salable quantity can hit zero immediately while is_in_stock
 * keeps reporting true until a cron run or reindex catches up. This is a data
 * consistency symptom, not something safe to silently rewrite, so it reports
 * by default and only gates a real correction behind DRY_RUN=false. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/in-stock-flag-disagrees-with-zero-salable-qty/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STOCK_ID = process.env.STOCK_ID || "1";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision: true only when the flag says buyable but nothing is left to sell.
 *
 * Returns false whenever manage_stock is false (unmanaged stock is intentionally
 * always in stock), whenever backorders are allowed (a zero or negative salable
 * qty is expected there), or whenever is_in_stock is already false.
 */
export function isPhantomInStock(stockItem, salableQty, backordersAllowed) {
  if (!stockItem.is_in_stock) return false;
  if (!stockItem.manage_stock) return false;
  if (backordersAllowed) return false;
  return salableQty <= 0;
}

function stockItemOf(product) {
  return product.extension_attributes?.stock_item || {};
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

async function enabledProducts(pageSize, currentPage) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "1",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/products", params);
  return data.items;
}

async function* allEnabledProducts(pageSize) {
  let page = 1;
  while (true) {
    const items = await enabledProducts(pageSize, page);
    if (!items.length) return;
    for (const item of items) yield item;
    if (items.length < pageSize) return;
    page++;
  }
}

async function salableQuantity(sku, stockId) {
  return magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
}

async function sourceItemsTotal(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/inventory/source-items", params);
  return data.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

async function correctFlag(sku) {
  const body = { product: { sku, extension_attributes: { stock_item: { is_in_stock: false } } } };
  return magentoPut(`/products/${sku}`, body);
}

export async function run() {
  let flagged = 0;
  for await (const product of allEnabledProducts(PAGE_SIZE)) {
    const sku = product.sku;
    const stockItem = stockItemOf(product);
    const stockId = stockItem.stock_id || STOCK_ID;
    const backordersAllowed = Boolean(stockItem.backorders);

    const qtyResponse = await salableQuantity(sku, stockId);
    const salableQty = Array.isArray(qtyResponse) ? qtyResponse[0] : qtyResponse;

    if (!isPhantomInStock(stockItem, salableQty, backordersAllowed)) continue;

    const totalQty = await sourceItemsTotal(sku);
    console.warn(
      `Mismatch: sku=${sku} stock_id=${stockId} is_in_stock=${stockItem.is_in_stock} salable_qty=${salableQty} source_items_total=${totalQty}. ${
        DRY_RUN ? "would correct" : "correcting"
      }`
    );
    if (!DRY_RUN) {
      await correctFlag(sku);
      console.log(`Corrected ${sku}. Run bin/magento indexer:reindex cataloginventory_stock inventory or bin/magento cron:run to reconcile.`);
    }
    flagged++;
  }
  console.log(`Done. ${flagged} mismatched SKU(s) ${DRY_RUN ? "to review" : "corrected"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
