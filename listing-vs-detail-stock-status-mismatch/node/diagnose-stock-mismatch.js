/**
 * Flag Magento 2 SKUs where the category grid and the product page disagree
 * on stock status, safely.
 *
 * The grid renders from the cataloginventory_stock_status index, rebuilt by
 * the Category Products or Product indexers, typically on schedule or cron.
 * The product page and add to cart flow instead call the live
 * InventorySalesApi (GetProductSalableQtyInterface, IsProductSalableInterface),
 * which nets source item quantities against active reservations in real
 * time. A sale or a pending order zeroes the live salable quantity
 * instantly, but the index only catches up on the next reindex. This
 * reports the mismatch by default and only gates a narrow, reversible
 * is_in_stock correction behind DRY_RUN=false. Run on a schedule. Safe to
 * run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/listing-vs-detail-stock-status-mismatch/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STOCK_ID = process.env.STOCK_ID || "1";
const MIN_QTY_THRESHOLD = Number(process.env.MIN_QTY_THRESHOLD || 0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * Compares the indexed grid-side stock signal (is_in_stock, quantity) against
 * the live, real-time salable quantity from InventorySalesApi, and classifies
 * whether the two sides agree, and if not, how severe the disagreement is.
 */
export function diagnoseStockMismatch(sku, gridInStock, gridQty, salableQty, minQtyThreshold = 0) {
  if (salableQty > minQtyThreshold && gridInStock) {
    return { mismatched: false, severity: "none", reason: "consistent, both in stock" };
  }

  if (salableQty <= minQtyThreshold && gridInStock) {
    const severity = gridQty > 0 ? "critical" : "stale_index";
    return {
      mismatched: true,
      severity,
      reason:
        "grid reports in-stock while live salable quantity is zero or negative, " +
        "stale stock_status index vs real-time reservation",
    };
  }

  if (salableQty <= minQtyThreshold && !gridInStock) {
    return { mismatched: false, severity: "none", reason: "both correctly out of stock" };
  }

  return {
    mismatched: true,
    severity: "stale_index",
    reason: "grid still reports out-of-stock after restock, index lag in the other direction",
  };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPut(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function productsBySku(skus) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": skus.join(","),
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[pageSize]": 200,
  };
  const data = await magentoGet("/products", params);
  return data.items;
}

async function salableQuantity(sku, stockId) {
  const data = await magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
  return typeof data === "number" ? data : data.quantity || 0;
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

async function forceOutOfStock(sku, priorIsInStock) {
  const payload = {
    product: {
      sku,
      extension_attributes: { stock_item: { is_in_stock: false } },
    },
  };
  console.log(`Correcting ${sku}: is_in_stock ${priorIsInStock} -> false`);
  return magentoPut(`/products/${sku}`, payload);
}

export async function run(skus = []) {
  if (!skus.length) {
    console.warn("No SKUs supplied. Nothing to check, exiting.");
    return;
  }

  const now = new Date().toISOString();
  let flagged = 0;

  const products = await productsBySku(skus);
  for (const product of products) {
    const sku = product.sku;
    const stockItem = product.extension_attributes?.stock_item || {};
    const gridInStock = Boolean(stockItem.is_in_stock);
    const gridQty = Number(stockItem.qty ?? stockItem.quantity ?? 0);

    const salable = await salableQuantity(sku, STOCK_ID);
    const result = diagnoseStockMismatch(sku, gridInStock, gridQty, salable, MIN_QTY_THRESHOLD);

    if (!result.mismatched) continue;

    flagged++;
    console.warn(
      `sku=${sku} is_in_stock=${gridInStock} grid_qty=${gridQty} salable_qty=${salable} stock_id=${STOCK_ID} severity=${result.severity} timestamp=${now} reason=${result.reason}`
    );

    if (result.severity === "critical" && !DRY_RUN) {
      await forceOutOfStock(sku, gridInStock);
    }
  }

  console.log(`Done. ${flagged} SKU(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skus = (process.env.CHECK_SKUS || "").split(",").filter(Boolean);
  run(skus).catch((err) => { console.error(err); process.exit(1); });
}
