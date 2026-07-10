/**
 * Detect Magento products that still get a category/product url_rewrite
 * duplicate even though catalog/seo/generate_category_product_rewrites is off.
 *
 * This is a confirmed core bug (magento/magento2 issues 38317 and 39070), not
 * a misconfiguration: ProductProcessUrlRewriteSavingObserver writes a plain
 * product rewrite on every product save regardless of the setting, while
 * CategoryProcessUrlRewriteSavingObserver and CanonicalUrlRewriteGenerator can
 * still write a category-prefixed rewrite for the same product on a category
 * save. This script resolves each product id to a SKU over REST, reads that
 * product's url_rewrite rows from a read-only export, flags duplicate pairs
 * with a pure function, and only performs a guarded delete of the redundant
 * row when --apply is explicitly passed. Report only by default.
 *
 * Guide: https://www.allanninal.dev/magento/disabled-rewrite-setting-still-duplicates/
 */
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/+$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const GENERATE_CATEGORY_PRODUCT_REWRITES =
  (process.env.GENERATE_CATEGORY_PRODUCT_REWRITES || "false").toLowerCase() === "true";
const PRODUCT_IDS = (process.env.PRODUCT_IDS || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map(Number);
const URL_REWRITE_EXPORT_CSV = process.env.URL_REWRITE_EXPORT_CSV || "url_rewrite_export.csv";

/**
 * Pure decision function.
 *
 * Filters rows to entity_type === 'product' && entity_id === productId,
 * groups by store_id, and within each group finds pairs sharing the same
 * target_path (the same underlying product) where one request_path has
 * more path segments than the other (category-prefixed). If
 * generateCategoryRewritesEnabled is false and more than one such row
 * exists per store_id, returns pairs marking the shorter/non-category
 * request_path as keep and the longer/category-containing one as remove,
 * with reason 'duplicate-despite-disabled-setting'. Returns an empty array
 * when only one row exists per store_id, or when the setting is enabled
 * (duplicates may then be legitimate multi-category assignments).
 */
export function findDuplicateProductRewrites(rows, productId, generateCategoryRewritesEnabled) {
  if (generateCategoryRewritesEnabled) return [];

  const productRows = rows.filter(
    (r) => r.entity_type === "product" && r.entity_id === productId
  );

  const byStore = new Map();
  for (const row of productRows) {
    if (!byStore.has(row.store_id)) byStore.set(row.store_id, []);
    byStore.get(row.store_id).push(row);
  }

  const pairs = [];
  for (const [, storeRows] of byStore) {
    const byTarget = new Map();
    for (const row of storeRows) {
      if (!byTarget.has(row.target_path)) byTarget.set(row.target_path, []);
      byTarget.get(row.target_path).push(row);
    }
    for (const [, targetRows] of byTarget) {
      if (targetRows.length <= 1) continue;
      const segments = (path) => (path.match(/\//g) || []).length;
      const ordered = [...targetRows].sort((a, b) => segments(a.request_path) - segments(b.request_path));
      const keepRow = ordered[0];
      for (const removeRow of ordered.slice(1)) {
        if (segments(removeRow.request_path) > segments(keepRow.request_path)) {
          pairs.push({
            keep: keepRow.url_rewrite_id,
            remove: removeRow.url_rewrite_id,
            reason: "duplicate-despite-disabled-setting",
          });
        }
      }
    }
  }
  return pairs;
}

/**
 * Never remove the plain row matching the product's current url_key, since
 * that is Magento's own default canonical preference and the row serving
 * live traffic. Compares the whole request_path, not just its last segment,
 * so a category-prefixed path such as mens/shirts/green-shirt.html is never
 * mistaken for the plain green-shirt.html row just because they share a
 * final segment.
 */
export function isLiveTrafficRow(row, currentUrlKey) {
  if (!currentUrlKey) return false;
  return row.request_path.replace(/\/+$/, "") === `${currentUrlKey}.html`;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function resolveSkuByEntityId(productId) {
  // GET /rest/V1/products filtered by entity_id, since url_rewrite itself
  // has no direct REST search endpoint.
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "entity_id",
    "searchCriteria[filterGroups][0][filters][0][value]": productId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const result = await apiGet("/products", params);
  const items = result.items || [];
  return items.length ? items[0] : null;
}

function customAttr(attrs, code, fallback = null) {
  for (const a of attrs || []) {
    if (a.attribute_code === code) return a.value;
  }
  return fallback;
}

async function readUrlRewriteRowsForProduct(productId, path = URL_REWRITE_EXPORT_CSV) {
  // Read this product's url_rewrite rows from a read-only export (CSV
  // columns: url_rewrite_id, entity_type, entity_id, request_path,
  // target_path, store_id, is_autogenerated). url_rewrite has no public
  // REST search endpoint.
  const text = await readFile(path, "utf-8");
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",");
  return lines
    .filter(Boolean)
    .map((line) => {
      const cells = line.split(",");
      const row = {};
      headers.forEach((h, i) => (row[h] = cells[i]));
      return row;
    })
    .filter((row) => row.entity_type === "product" && Number(row.entity_id) === productId)
    .map((row) => ({
      url_rewrite_id: Number(row.url_rewrite_id),
      entity_type: row.entity_type,
      entity_id: Number(row.entity_id),
      request_path: row.request_path,
      target_path: row.target_path,
      store_id: Number(row.store_id),
      is_autogenerated: Number(row.is_autogenerated || 0),
    }));
}

export async function run() {
  const applyDeletes = process.argv.includes("--apply");
  let totalPairs = 0;

  for (const productId of PRODUCT_IDS) {
    const product = await resolveSkuByEntityId(productId);
    if (!product) {
      console.log(`Product id=${productId} not found, skipping`);
      continue;
    }
    const sku = product.sku;
    const currentUrlKey = customAttr(product.custom_attributes, "url_key", "");

    const rows = await readUrlRewriteRowsForProduct(productId);
    const pairs = findDuplicateProductRewrites(rows, productId, GENERATE_CATEGORY_PRODUCT_REWRITES);

    for (const pair of pairs) {
      totalPairs++;
      console.warn(
        `Product id=${productId} sku=${sku}: url_rewrite_id=${pair.remove} is redundant next to keep=${pair.keep} (${pair.reason})`
      );
      const removeRow = rows.find((r) => r.url_rewrite_id === pair.remove);
      if (isLiveTrafficRow(removeRow, currentUrlKey)) {
        console.log("Skipping delete: row matches the product's current url_key, serving live traffic");
        continue;
      }
      if (!applyDeletes || DRY_RUN) {
        console.log(
          `Recommend: apply the core patch for issue 38317/39070, or add an after-plugin on ` +
          `CanonicalUrlRewriteGenerator::generate to drop this row. Would delete url_rewrite_id=${pair.remove} ` +
          `(pass --apply and DRY_RUN=false to delete)`
        );
        continue;
      }
      await apiDelete(`/url-rewrites/${pair.remove}`);
      console.log(`Deleted redundant url_rewrite_id=${pair.remove}`);
    }
  }

  console.log(`Done. ${totalPairs} duplicate pair(s) found across ${PRODUCT_IDS.length} product(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
