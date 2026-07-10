/**
 * Diagnose a Magento 2 product that shows Enabled but is missing from the storefront.
 *
 * Status Enabled is only one of several conditions Magento checks. Visibility
 * has to include catalog or search, the product has to carry the storefront's
 * website_id in its website assignment (a REST create/update that omits
 * extension_attributes.website_ids can silently drop or fail to set this, per
 * magento2 GitHub issues #8173, #10495, #11324), and it has to link to at
 * least one active category. Even when all three agree, a stale or invalid
 * indexer (catalog_category_product, catalog_product_index,
 * catalogsearch_fulltext) or a missed cron run can still hide the product,
 * and that can only be fixed with bin/magento indexer:reindex, not over REST.
 * This reports by default. Run on a schedule or on demand. Safe to run again
 * and again.
 *
 * Guide: https://www.allanninal.dev/magento/enabled-product-missing-from-storefront/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const TARGET_WEBSITE_ID = Number(process.env.TARGET_WEBSITE_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const NOT_VISIBLE_INDIVIDUALLY = 1;
const SUSPECT_INDEXERS = ["catalog_category_product", "catalog_product_index", "catalogsearch_fulltext"];

/**
 * Pure decision logic, no I/O.
 *
 * product: {status: 1|2, visibility: 1|2|3|4, websiteIds: number[], categoryIds: number[]}
 * categories: {id: number, isActive: boolean}[]
 * targetWebsiteId: number
 * Returns {eligible: boolean, reasons: string[]}.
 *
 * eligible is true only if status === 1 AND visibility !== 1 (Not Visible
 * Individually) AND websiteIds includes targetWebsiteId AND at least one
 * linked category is active. Otherwise reasons lists every failing
 * condition, so the caller can tell "should be eligible per data but still
 * missing from storefront" (stale index/cron) apart from "genuinely
 * ineligible per data".
 */
export function decideStorefrontEligibility(product, categories, targetWebsiteId) {
  const reasons = [];

  if (product.status !== 1) reasons.push("disabled");
  if (product.visibility === NOT_VISIBLE_INDIVIDUALLY) reasons.push("not_visible_individually");
  if (!product.websiteIds.includes(targetWebsiteId)) reasons.push("website_not_assigned");

  const activeIds = new Set(categories.filter((c) => c.isActive).map((c) => c.id));
  const hasActiveCategory = product.categoryIds.some((id) => activeIds.has(id));
  if (!hasActiveCategory) reasons.push("no_active_category");

  return { eligible: reasons.length === 0, reasons };
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

async function findProductBySku(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/products", params);
  return data.items[0] || null;
}

function visibilityOf(product) {
  const attr = (product.custom_attributes || []).find((a) => a.attribute_code === "visibility");
  return attr ? Number(attr.value) : null;
}

function categoryIdsOf(product) {
  const attr = (product.custom_attributes || []).find((a) => a.attribute_code === "category_ids");
  return attr ? attr.value.map(Number) : [];
}

async function productWebsiteIds(sku) {
  return magentoGet(`/products/${sku}/websites`);
}

async function fetchCategories(categoryIds) {
  const result = [];
  for (const id of categoryIds) {
    const data = await magentoGet(`/categories/${id}`);
    result.push({ id, isActive: Boolean(data.is_active) });
  }
  return result;
}

async function storefrontHasProduct(storefrontUrl) {
  const res = await fetch(storefrontUrl, { redirect: "follow" });
  return res.status === 200;
}

async function buildProductSnapshot(sku) {
  const product = await findProductBySku(sku);
  if (!product) return null;
  const categoryIds = categoryIdsOf(product);
  const snapshot = {
    status: product.status,
    visibility: visibilityOf(product),
    websiteIds: await productWebsiteIds(sku),
    categoryIds,
  };
  const categories = await fetchCategories(categoryIds);
  return { snapshot, categories };
}

export async function diagnose(sku, storefrontUrl) {
  const built = await buildProductSnapshot(sku);
  if (!built) return { sku, status: "not_found" };

  const { snapshot, categories } = built;
  const verdict = decideStorefrontEligibility(snapshot, categories, TARGET_WEBSITE_ID);

  if (!verdict.eligible) {
    return { sku, status: "ineligible", reasons: verdict.reasons };
  }

  if (storefrontUrl && !(await storefrontHasProduct(storefrontUrl))) {
    return { sku, status: "indexer_or_cron_suspected", suspects: SUSPECT_INDEXERS };
  }

  return { sku, status: "ok" };
}

export async function repairProduct(sku, fixes) {
  // fixes may include status, visibility, and/or websiteIds (a FULL list).
  // Never send a partial websiteIds list; that is the documented bug (#11324)
  // that reassigns or drops websites. Always prints a diff before writing.
  const body = { product: { sku } };
  if ("status" in fixes) body.product.status = fixes.status;
  if ("visibility" in fixes) body.product.visibility = fixes.visibility;
  if ("websiteIds" in fixes) body.product.extension_attributes = { website_ids: fixes.websiteIds };

  console.log(`DRY_RUN diff for ${sku}:`, JSON.stringify(body));
  if (DRY_RUN) return { sku, applied: false, dryRun: true, body };

  await magentoPut(`/products/${sku}`, body);
  return { sku, applied: true, dryRun: false, body };
}

export async function run(skus, storefrontUrls = {}) {
  const reports = [];
  for (const sku of skus) {
    const report = await diagnose(sku, storefrontUrls[sku]);
    console.log(`SKU ${sku}: ${report.status}`);
    reports.push(report);
  }
  console.log(`Done. ${reports.length} SKU(s) checked.`);
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetSkus = (process.env.TARGET_SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
  run(targetSkus).catch((err) => { console.error(err); process.exit(1); });
}
