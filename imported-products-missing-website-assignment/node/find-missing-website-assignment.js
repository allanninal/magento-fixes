/**
 * Find Magento products imported without a website assignment.
 *
 * A product is only visible on a storefront when catalog_product_website has a row
 * linking its entity id to that website's id. Neither the CSV importer, when the
 * product_websites column is blank or has a typo'd code, nor the REST product-create
 * endpoint, which has no plain website_ids field, is guaranteed to write that row.
 * The product still saves and indexes fine, it is just invisible everywhere on the
 * storefront.
 *
 * By default this script only reports affected SKUs. It repairs a SKU only when
 * TARGET_WEBSITE_ID is set, DRY_RUN is false, and the store has exactly one website,
 * since the correct assignment cannot be inferred safely when there is more than one.
 *
 * Guide: https://www.allanninal.dev/magento/imported-products-missing-website-assignment/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const UPDATED_SINCE = process.env.UPDATED_SINCE || "1970-01-01 00:00:00";
const EXPECTED_WEBSITE_IDS = (process.env.EXPECTED_WEBSITE_IDS || "1")
  .split(",")
  .map((w) => w.trim())
  .filter(Boolean)
  .map(Number);
const TARGET_WEBSITE_ID = (process.env.TARGET_WEBSITE_ID || "").trim();
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAGE_SIZE = 200;

export function isMissingWebsiteAssignment(product, expectedWebsiteIds = [1]) {
  const actual = product.extension_attributes?.website_ids ?? [];
  const missingWebsiteIds = expectedWebsiteIds.filter((id) => !actual.includes(id));
  const affected = actual.length === 0 || missingWebsiteIds.length > 0;
  return { sku: product.sku, affected, missingWebsiteIds };
}

async function get(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function recentProducts(since) {
  const products = [];
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
      "searchCriteria[filterGroups][0][filters][0][value]": since,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
      "searchCriteria[pageSize]": PAGE_SIZE,
      "searchCriteria[currentPage]": page,
    };
    const data = await get("/products", params);
    const items = data.items || [];
    products.push(...items);
    if (items.length < PAGE_SIZE) return products;
    page += 1;
  }
}

async function confirmedWebsiteIds(sku) {
  return get(`/products/${sku}/websites`);
}

async function storeWebsiteCount() {
  const websites = await get("/store/websites");
  return websites.length;
}

async function linkWebsite(sku, websiteId) {
  const body = { productWebsiteLink: { sku, website_id: websiteId } };
  await post(`/products/${sku}/websites`, body);
}

export async function run() {
  const candidates = await recentProducts(UPDATED_SINCE);
  const affectedSkus = [];
  for (const product of candidates) {
    const decision = isMissingWebsiteAssignment(product, EXPECTED_WEBSITE_IDS);
    if (!decision.affected) continue;
    const confirmed = await confirmedWebsiteIds(decision.sku);
    if (confirmed && confirmed.length) continue;
    affectedSkus.push(decision.sku);
    console.warn(`SKU ${decision.sku} has no website assignment. Missing website id(s): ${decision.missingWebsiteIds}`);
  }

  if (!affectedSkus.length) {
    console.log(`Done. No products missing a website assignment out of ${candidates.length} checked.`);
    return;
  }

  if (!TARGET_WEBSITE_ID) {
    console.log(
      `Done. ${affectedSkus.length} SKU(s) missing a website assignment. Set TARGET_WEBSITE_ID and DRY_RUN=false ` +
      `to link them, only if this store has a single website.`
    );
    return;
  }

  if ((await storeWebsiteCount()) > 1) {
    console.warn(
      `Store has more than one website. Skipping repair for all ${affectedSkus.length} SKU(s), ` +
      `the correct assignment cannot be inferred safely.`
    );
    return;
  }

  const websiteId = Number(TARGET_WEBSITE_ID);
  for (const sku of affectedSkus) {
    console.log(`SKU ${sku}. ${DRY_RUN ? `would link website ${websiteId}` : `linking website ${websiteId}`}`);
    if (!DRY_RUN) await linkWebsite(sku, websiteId);
  }
  console.log(`Done. ${affectedSkus.length} SKU(s) ${DRY_RUN ? "to link" : "linked"} to website ${websiteId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
