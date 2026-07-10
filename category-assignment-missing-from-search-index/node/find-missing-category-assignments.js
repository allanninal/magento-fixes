/**
 * Find Magento category product assignments that never reached the search index.
 *
 * catalog_category_product edits are only visible to a scheduled catalogsearch_fulltext
 * reindex if they wrote a row into the Mview changelog. When the mview.xml subscription
 * for that table is missing or overwritten by another indexer, admin and API category
 * assignments never produce a changelog row, so the product silently never appears in
 * category or fulltext search until a full reindex is forced.
 *
 * This script is diagnostic only. It compares the admin-truth assignment list from
 * /V1/categories/{id}/products against the search-index-backed /V1/products listing,
 * rules out products that are legitimately absent (disabled or Not Visible Individually),
 * and reports the rest. DRY_RUN stays true, there is no write or reindex call in here.
 *
 * Guide: https://www.allanninal.dev/magento/category-assignment-missing-from-search-index/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const CATEGORY_IDS = (process.env.CATEGORY_IDS || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAGE_SIZE = 100;
const DISABLED_STATUS = 2;
const NOT_VISIBLE_INDIVIDUALLY = 1;

/**
 * Pure function: returns the subset of assignedSkus not present in searchIndexSkus,
 * excluding any SKU whose productStatusBySku entry shows status=2 (disabled) or
 * visibility=1 (Not Visible Individually), since those are legitimately absent
 * rather than indexer-stale. Pure set-difference plus status filter over
 * already-fetched data, no I/O.
 */
export function findMissingCategoryAssignments(assignedSkus, searchIndexSkus, productStatusBySku) {
  const searchIndexSet = new Set(searchIndexSkus);
  const missing = [];
  for (const sku of assignedSkus) {
    if (searchIndexSet.has(sku)) continue;
    const info = productStatusBySku[sku];
    if (info && (info.status === DISABLED_STATUS || info.visibility === NOT_VISIBLE_INDIVIDUALLY)) continue;
    missing.push(sku);
  }
  return missing;
}

async function get(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function assignedSkus(categoryId) {
  const links = await get(`/categories/${categoryId}/products`);
  return links.map((link) => link.sku);
}

async function searchIndexSkus(categoryId) {
  const skus = [];
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "category_id",
      "searchCriteria[filterGroups][0][filters][0][value]": categoryId,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": PAGE_SIZE,
      "searchCriteria[currentPage]": page,
    };
    const data = await get("/products", params);
    const items = data.items || [];
    skus.push(...items.map((item) => item.sku));
    if (items.length < PAGE_SIZE) return skus;
    page += 1;
  }
}

async function productStatus(sku) {
  const product = await get(`/products/${sku}`);
  return { status: product.status, visibility: product.visibility };
}

export async function run() {
  let totalGaps = 0;
  for (const categoryId of CATEGORY_IDS) {
    const assigned = await assignedSkus(categoryId);
    const indexed = await searchIndexSkus(categoryId);
    const indexedSet = new Set(indexed);
    const candidates = assigned.filter((sku) => !indexedSet.has(sku));
    const productStatusBySku = {};
    for (const sku of candidates) productStatusBySku[sku] = await productStatus(sku);
    const gaps = findMissingCategoryAssignments(assigned, indexed, productStatusBySku);
    for (const sku of gaps) {
      console.warn(`Category ${categoryId}: SKU ${sku} is assigned but missing from the search index.`);
    }
    totalGaps += gaps.length;
  }
  if (totalGaps) {
    console.log(
      `Done. ${totalGaps} category/SKU pair(s) look stuck in the changelog gap. ` +
      `Recommend: php bin/magento indexer:reindex catalogsearch_fulltext ` +
      `(or reset the mview_state for that view). ` +
      (DRY_RUN ? "Dry run, no write performed." : "This script never writes regardless of DRY_RUN.")
    );
  } else {
    console.log(`Done. No category/SKU gaps found across ${CATEGORY_IDS.length} category/categories.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
