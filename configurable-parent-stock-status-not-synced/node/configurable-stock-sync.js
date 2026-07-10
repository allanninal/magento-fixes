/**
 * Flag Magento 2 configurable products whose cached is_in_stock flag disagrees
 * with the true OR-of-salable-children aggregate, safely.
 *
 * A configurable's own is_in_stock flag lives in cataloginventory_stock_item
 * and is only refreshed by the Magento\ConfigurableProduct stock-status
 * plugin and indexer path when specific save events fire and the inventory
 * indexers are caught up. A child quantity edited through an import, the
 * API, or a source-level change without triggering that path leaves the
 * parent's cached flag stale. This reports the mismatch by default and only
 * gates a narrow corrective PUT behind DRY_RUN=false. That write only fixes
 * the cached flag, not the MSI index itself, so a full
 * bin/magento indexer:reindex is still recommended afterward. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/configurable-parent-stock-status-not-synced/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STOCK_ID = process.env.STOCK_ID || "1";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function: OR of salable children.
 * Returns true only if children is non-empty AND at least one child has
 * isInStock true AND salableQty > 0. Returns false if children is empty or
 * every child fails that test.
 */
export function computeExpectedParentStockStatus(children) {
  if (!children || children.length === 0) return false;
  return children.some(
    (child) => Boolean(child.isInStock) && Number(child.salableQty || 0) > 0
  );
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

async function* configurableProducts(pageSize = 50) {
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "type_id",
      "searchCriteria[filterGroups][0][filters][0][value]": "configurable",
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": page,
    };
    const data = await magentoGet("/products", params);
    const items = data.items || [];
    if (!items.length) return;
    for (const item of items) yield item;
    if (page * pageSize >= (data.total_count || 0)) return;
    page++;
  }
}

async function childrenFor(sku) {
  return magentoGet(`/configurable-products/${sku}/children`);
}

async function salableQuantity(sku, stockId) {
  const data = await magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
  return typeof data === "number" ? data : data.quantity || 0;
}

function childStockItem(product) {
  const stockItem = product.extension_attributes?.stock_item || {};
  return Boolean(stockItem.is_in_stock);
}

async function buildChildSnapshot(childSku, stockId) {
  const childProduct = await magentoGet(`/products/${childSku}`);
  return {
    sku: childSku,
    isInStock: childStockItem(childProduct),
    salableQty: await salableQuantity(childSku, stockId),
  };
}

async function correctParentStatus(sku, expectedStatus) {
  const payload = {
    product: {
      sku,
      extension_attributes: {
        stock_item: { is_in_stock: expectedStatus, manage_stock: true },
      },
    },
  };
  console.log(`Correcting ${sku}: is_in_stock -> ${expectedStatus} (reindex still recommended)`);
  return magentoPut(`/products/${sku}`, payload);
}

export async function run() {
  const now = new Date().toISOString();
  let flagged = 0;

  for await (const parent of configurableProducts()) {
    const sku = parent.sku;
    const childrenRaw = await childrenFor(sku);
    if (!childrenRaw || !childrenRaw.length) continue;

    const children = [];
    for (const child of childrenRaw) {
      children.push(await buildChildSnapshot(child.sku, STOCK_ID));
    }

    const expected = computeExpectedParentStockStatus(children);
    const actual = childStockItem(parent);

    if (expected === actual) continue;

    flagged++;
    console.warn(
      `sku=${sku} expected_in_stock=${expected} actual_in_stock=${actual} child_count=${children.length} stock_id=${STOCK_ID} timestamp=${now}`
    );

    if (!DRY_RUN) {
      await correctParentStatus(sku, expected);
    }
  }

  console.log(`Done. ${flagged} configurable(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
