/**
 * Flag Magento categories whose reported product_count disagrees with the
 * real product to category assignments, especially anchor categories after a
 * partial catalog_category_product reindex. Report only by default.
 *
 * The catalog_category_product indexer rebuilds catalog_category_product_index
 * (and the per store index) with a temp table swap rather than updating rows
 * in place. If that swap is interrupted the index table can go stale or zero
 * out while the live assignment table is untouched. This script cannot
 * trigger a real reindex over REST, so it detects and reports the gap, and
 * only if you opt in with MAGENTO_ALLOW_INDEXER_INVALIDATE=true does it
 * resave the category to nudge Magento's own indexer invalidation for the
 * next scheduled cron run.
 *
 * Guide: https://www.allanninal.dev/magento/category-product-count-wrong/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/+$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const TOLERANCE = Number(process.env.COUNT_TOLERANCE || 0);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ALLOW_INVALIDATE = (process.env.MAGENTO_ALLOW_INDEXER_INVALIDATE || "false").toLowerCase() === "true";

export function decideCategoryCountDiscrepancy(reportedCount, actualCount, isAnchor, tolerance = 0) {
  const delta = actualCount - reportedCount;
  if (actualCount > 0 && reportedCount === 0) {
    return { flagged: true, severity: "zeroed", delta };
  }
  if (Math.abs(delta) > tolerance) {
    return { flagged: true, severity: "drift", delta };
  }
  return { flagged: false, severity: "none", delta };
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

async function listCategoryIds() {
  const result = await apiGet("/categories/list", { "searchCriteria[pageSize]": 200 });
  return (result.items || []).map((item) => item.id);
}

async function reportedCategoryCount(categoryId) {
  const cat = await apiGet(`/categories/${categoryId}`);
  const attrs = cat.custom_attributes;
  const reported = Number(customAttr(attrs, "product_count", 0) || 0);
  const isAnchor = String(customAttr(attrs, "is_anchor", "0")) === "1";
  return { reported, isAnchor, category: cat };
}

async function actualCategoryCount(categoryId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "category_id",
    "searchCriteria[filterGroups][0][filters][0][value]": categoryId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": 1,
  };
  const result = await apiGet("/products", params);
  return Number(result.total_count || 0);
}

async function nudgeIndexerInvalidate(categoryId, category) {
  await apiPut(`/categories/${categoryId}`, { category: { id: categoryId, name: category.name } });
}

export async function run() {
  let flagged = 0;
  for (const categoryId of await listCategoryIds()) {
    const { reported, isAnchor, category } = await reportedCategoryCount(categoryId);
    const actual = await actualCategoryCount(categoryId);
    const decision = decideCategoryCountDiscrepancy(reported, actual, isAnchor, TOLERANCE);
    if (!decision.flagged) continue;
    flagged++;
    console.warn(
      `Category ${categoryId} ${decision.severity}: reported=${reported} actual=${actual} delta=${decision.delta >= 0 ? "+" : ""}${decision.delta} anchor=${isAnchor}`
    );
    if (ALLOW_INVALIDATE && !DRY_RUN) {
      await nudgeIndexerInvalidate(categoryId, category);
      console.log(`Category ${categoryId}: resaved to invalidate catalog_category_product indexer`);
    }
  }
  console.log(`Done. ${flagged} categor${flagged === 1 ? "y" : "ies"} flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
