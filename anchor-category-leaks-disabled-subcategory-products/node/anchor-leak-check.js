/**
 * Flag Magento anchor categories that show products from a disabled
 * subcategory, because the catalog_category_product indexer aggregates the
 * full category subtree by path and never checks is_active on a child.
 * Report only by default.
 *
 * Guide: https://www.allanninal.dev/magento/anchor-category-leaks-disabled-subcategory-products/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/+$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const ROOT_CATEGORY_ID = process.env.ROOT_CATEGORY_ID || "2";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function findLeakedAnchorProducts(categoryTree, productIndex, categoryProductAssignments) {
  const leaks = [];
  const seen = new Set();

  function walk(node, nearestAnchorId) {
    const anchorId = node.isAnchor ? node.id : nearestAnchorId;
    if (node.isActive === false && anchorId != null) {
      const assignments = categoryProductAssignments.get(node.id) || [];
      for (const assignment of assignments) {
        const sku = assignment.sku;
        const info = productIndex.get(sku);
        if (!info) continue;
        if (info.status !== 1 || info.visibility === 1) continue;
        const key = `${sku}::${anchorId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        leaks.push({ anchorCategoryId: anchorId, disabledCategoryId: node.id, sku });
      }
    }
    for (const child of node.children || []) walk(child, anchorId);
  }

  walk(categoryTree, categoryTree.isAnchor ? categoryTree.id : null);
  return leaks;
}

function customAttr(attrs, code, fallback = null) {
  for (const a of attrs || []) {
    if (a.attribute_code === code) return a.value;
  }
  return fallback;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function apiPut(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function fetchCategoryTree(rootCategoryId) {
  return apiGet("/categories", { rootCategoryId });
}

async function categoryProducts(categoryId) {
  return apiGet(`/categories/${categoryId}/products`);
}

async function fetchProductIndex(skus) {
  const unique = [...new Set(skus)];
  if (unique.length === 0) return {};
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": unique.sort().join(","),
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[pageSize]": unique.length,
  };
  const result = await apiGet("/products", params);
  const index = {};
  for (const item of result.items || []) {
    index[item.sku] = { status: Number(item.status || 0), visibility: Number(item.visibility || 0) };
  }
  return index;
}

function toPlainTree(rawCategory) {
  const attrs = rawCategory.custom_attributes;
  return {
    id: rawCategory.id,
    isActive: String(customAttr(attrs, "is_active", "1")) === "1",
    isAnchor: String(customAttr(attrs, "is_anchor", "0")) === "1",
    children: (rawCategory.children_data || []).map(toPlainTree),
  };
}

function collectCategoryIds(node) {
  const ids = [node.id];
  for (const child of node.children || []) ids.push(...collectCategoryIds(child));
  return ids;
}

async function unassignSkuFromCategory(categoryId, sku) {
  const links = await categoryProducts(categoryId);
  const remaining = links.filter((link) => link.sku !== sku);
  await apiPut(`/categories/${categoryId}`, { category: { id: categoryId, productLinks: remaining } });
}

export async function run() {
  const rawTree = await fetchCategoryTree(ROOT_CATEGORY_ID);
  const tree = toPlainTree(rawTree);

  const assignments = new Map();
  const allSkus = [];
  for (const categoryId of collectCategoryIds(tree)) {
    const links = await categoryProducts(categoryId);
    assignments.set(categoryId, links);
    allSkus.push(...links.map((link) => link.sku));
  }

  const rawIndex = await fetchProductIndex(allSkus);
  const productIndex = new Map(Object.entries(rawIndex));

  const leaks = findLeakedAnchorProducts(tree, productIndex, assignments);
  for (const leak of leaks) {
    console.warn(`Leak: anchor=${leak.anchorCategoryId} disabled_category=${leak.disabledCategoryId} sku=${leak.sku}`);
    if (!DRY_RUN) {
      await unassignSkuFromCategory(leak.disabledCategoryId, leak.sku);
      console.log(`Unassigned sku=${leak.sku} from disabled category=${leak.disabledCategoryId}`);
    }
  }
  console.log(`Done. ${leaks.length} leaked product(s) ${DRY_RUN ? "to review" : "unassigned"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
