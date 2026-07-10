/**
 * Detect Magento products whose url_rewrite row was not generated on
 * save or duplicate, and report the safe repair.
 *
 * ProductProcessUrlRewriteSavingObserver regenerates url_rewrite rows on
 * catalog_product_save_after using Product::getStoreIds() to resolve which
 * stores to write for. In single-store mode, and reliably when a product is
 * saved through PUT /V1/products/{sku} instead of the admin form,
 * getStoreIds() mishandles website_ids and resolves the wrong or an empty
 * scope, so no rewrite row is written, with no exception and a 200 OK. There
 * is no public API to insert a url_rewrite row directly, so this script only
 * reports affected SKUs and, when DRY_RUN is explicitly disabled, applies the
 * documented re-save workaround.
 *
 * Guide: https://www.allanninal.dev/magento/url-rewrite-not-generated-on-edit/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/+$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SKUS = (process.env.CHECK_SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
const STORE_BASE_URLS = process.env.STORE_BASE_URLS || "";

/**
 * Pure decision function. No I/O.
 *
 * For each storeId in product.storeIds, computes expectedPath =
 * `${product.urlKey}${expectedSuffix}`, looks up existingRewritePaths.get(storeId),
 * and if that set does not contain expectedPath, pushes {sku, storeId, expectedPath}
 * onto the result array. Returns the array (empty if all stores have a matching rewrite).
 */
export function isUrlRewriteMissing(product, expectedSuffix, existingRewritePaths) {
  const missing = [];
  for (const storeId of product.storeIds) {
    const expectedPath = `${product.urlKey}${expectedSuffix}`;
    const knownPaths = existingRewritePaths.get(storeId) || new Set();
    if (!knownPaths.has(expectedPath)) {
      missing.push({ sku: product.sku, storeId, expectedPath });
    }
  }
  return missing;
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

async function fetchProduct(sku) {
  const item = await apiGet(`/products/${sku}`);
  return {
    sku: item.sku,
    urlKey: customAttr(item.custom_attributes, "url_key"),
    storeIds: item.extension_attributes?.website_ids || [],
  };
}

async function fetchUrlSuffix(storeCode) {
  const configs = await apiGet("/store/storeConfigs", { "storeCodes[]": storeCode });
  if (!configs.length) return ".html";
  return configs[0].product_url_suffix || ".html";
}

function parseStoreBaseUrls(raw) {
  const mapping = new Map();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    const idx = trimmed.indexOf(":");
    const storeId = Number(trimmed.slice(0, idx));
    const url = trimmed.slice(idx + 1);
    mapping.set(storeId, url);
  }
  return mapping;
}

async function pathResolves(storeBaseUrl, expectedPath) {
  const url = `${storeBaseUrl.replace(/\/+$/, "")}/${expectedPath}`;
  let res = await fetch(url, { method: "HEAD", redirect: "manual" });
  if (res.status === 405) res = await fetch(url, { method: "GET", redirect: "manual" });
  return [200, 301, 302].includes(res.status);
}

async function repairWithDuplicatedWebsiteIds(sku, websiteIds) {
  const doubled = [...websiteIds, ...websiteIds];
  const payload = { product: { sku, extension_attributes: { website_ids: doubled } } };
  return apiPut(`/products/${sku}`, payload);
}

export async function run() {
  const storeBaseUrls = parseStoreBaseUrls(STORE_BASE_URLS);
  let flagged = 0;

  for (const sku of SKUS) {
    const product = await fetchProduct(sku);
    if (!product.urlKey) {
      console.warn(`SKU ${sku} has no url_key, skipping`);
      continue;
    }

    const existingRewritePaths = new Map();
    for (const storeId of product.storeIds) {
      const baseUrl = storeBaseUrls.get(storeId);
      if (!baseUrl) {
        console.warn(`No STORE_BASE_URLS entry for store_id=${storeId}, skipping check`);
        continue;
      }
      const suffix = await fetchUrlSuffix(String(storeId));
      const expectedPath = `${product.urlKey}${suffix}`;
      const resolved = await pathResolves(baseUrl, expectedPath);
      existingRewritePaths.set(storeId, resolved ? new Set([expectedPath]) : new Set());
    }

    const defaultSuffix = ".html";
    const missing = isUrlRewriteMissing(product, defaultSuffix, existingRewritePaths);

    for (const gap of missing) {
      console.warn(`Missing url_rewrite: sku=${gap.sku} store_id=${gap.storeId} expected_path=${gap.expectedPath}`);
      flagged++;
    }

    if (missing.length) {
      console.log(`${DRY_RUN ? "Would PUT" : "PUTting"} sku=${sku} website_ids=${JSON.stringify(product.storeIds)} (duplicated workaround)`);
      if (!DRY_RUN) await repairWithDuplicatedWebsiteIds(sku, product.storeIds);
    }
  }

  console.log(`Done. ${flagged} missing rewrite(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
