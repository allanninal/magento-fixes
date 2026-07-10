/**
 * Detect the Magento product URL failure that happens when
 * catalog/seo/product_url_suffix and catalog/seo/category_url_suffix are
 * both empty, catalog/seo/product_use_categories is Yes, and
 * catalog/seo/generate_category_product_rewrites is No.
 *
 * In that combination Magento\CatalogUrlRewrite\Model\Storage\DynamicStorage
 * resolves the product's request path on the fly with a plain str_replace
 * instead of a suffix anchored substr, which can strip the wrong part of the
 * path and 404 or 500 an otherwise normal product page.
 *
 * store/storeConfigs does not expose product_use_categories or
 * generate_category_product_rewrites, so this script treats "no product url
 * rewrite rows contain a category path segment" as the observable proxy for
 * rewrite generation being off, then confirms the real failure with a live
 * HTTP GET against the storefront. Report only by default.
 *
 * Guide: https://www.allanninal.dev/magento/disabled-rewrite-empty-suffix-error/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/+$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SAMPLE_PAGE_SIZE = Number(process.env.SAMPLE_PAGE_SIZE || 100);
const SAMPLE_MAX_PAGES = Number(process.env.SAMPLE_MAX_PAGES || 5);

/**
 * Pure decision function, no I/O.
 *
 * config: {productUrlSuffix, categoryUrlSuffix,
 *          useCategoriesPathForProductUrls, generateCategoryProductRewrites}
 * urlRequestPath: the resolved storefront request path, e.g.
 *   "test-category/test-sub-category/test"
 * httpStatus: the observed HTTP status code for that live URL
 *
 * Returns {affected, reason}. affected=true only when both suffixes are
 * empty, categories are used in the product path, rewrite generation is
 * disabled, the path has a category segment, and the live status is 404 or
 * 500.
 */
export function classifyUrlSuffixRisk(config, urlRequestPath, httpStatus) {
  const {
    productUrlSuffix,
    categoryUrlSuffix,
    useCategoriesPathForProductUrls,
    generateCategoryProductRewrites,
  } = config;

  if (productUrlSuffix) return { affected: false, reason: "suffix-present" };
  if (categoryUrlSuffix) return { affected: false, reason: "suffix-present" };
  if (!useCategoriesPathForProductUrls) return { affected: false, reason: "no-category-path" };
  if (generateCategoryProductRewrites) return { affected: false, reason: "rewrites-enabled" };
  if (!urlRequestPath.includes("/")) return { affected: false, reason: "no-category-path" };
  if (httpStatus !== 404 && httpStatus !== 500) return { affected: false, reason: "ok" };

  return { affected: true, reason: "empty-suffix-category-path-collision" };
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

async function fetchStoreConfigs() {
  return apiGet("/store/storeConfigs");
}

async function fetchSampleProducts(pageSize = SAMPLE_PAGE_SIZE, maxPages = SAMPLE_MAX_PAGES) {
  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "status",
      "searchCriteria[filterGroups][0][filters][0][value]": 1,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": page,
    };
    const result = await apiGet("/products", params);
    const items = result.items || [];
    products.push(...items);
    if (items.length < pageSize) break;
  }
  return products;
}

async function resolveStorefrontStatus(baseUrl, requestPath) {
  const url = `${baseUrl.replace(/\/+$/, "")}/${requestPath.replace(/^\/+/, "")}`;
  const res = await fetch(url, { redirect: "follow" });
  return res.status;
}

function buildRequestPath(categoryPath, urlKey) {
  if (!categoryPath) return urlKey;
  return `${categoryPath.replace(/^\/+|\/+$/g, "")}/${urlKey}`;
}

async function repairProductUrlKey(sku, urlKey) {
  // Narrow REST-only mitigation for a specific SKU. Never called
  // automatically; only run when DRY_RUN=false and a human has confirmed
  // the SKU list. Does not fix the underlying suffix configuration.
  const payload = {
    product: { sku, custom_attributes: [{ attribute_code: "url_key", value: urlKey }] },
  };
  return apiPut(`/products/${sku}`, payload);
}

function printCliFix(storeCode) {
  console.log(
    `CLI fix for store ${storeCode}: bin/magento config:set catalog/seo/product_url_suffix html --scope=stores --scope-code=${storeCode} `
      + `&& bin/magento indexer:reindex catalog_url_rewrite `
      + `(or bin/magento config:set catalog/seo/generate_category_product_rewrites 1)`
  );
}

export async function run(categoryPathBySku = {}) {
  const storeConfigs = await fetchStoreConfigs();
  const products = await fetchSampleProducts();

  const affected = [];
  for (const store of storeConfigs) {
    const config = {
      productUrlSuffix: store.product_url_suffix,
      categoryUrlSuffix: store.category_url_suffix,
      // Not exposed by storeConfigs; treated as the risky default so the
      // live GET is the real arbiter of whether a page actually fails.
      useCategoriesPathForProductUrls: true,
      generateCategoryProductRewrites: false,
    };
    const storeId = store.id;
    const baseUrl = store.secure_base_url || store.base_url || MAGENTO_URL;

    for (const product of products) {
      const sku = product.sku;
      const urlKey = customAttr(product.custom_attributes, "url_key", sku);
      const categoryPath = categoryPathBySku[sku] || "";
      const requestPath = buildRequestPath(categoryPath, urlKey);
      if (!requestPath.includes("/")) continue;

      const status = await resolveStorefrontStatus(baseUrl, requestPath);
      const result = classifyUrlSuffixRisk(config, requestPath, status);
      if (result.affected) {
        affected.push({ sku, store_id: storeId, request_path: requestPath, http_status: status, reason: result.reason });
        console.warn(`AFFECTED sku=${sku} store_id=${storeId} request_path=${requestPath} status=${status}`);
        printCliFix(store.code || storeId);
      }
    }
  }

  console.log(`Done. ${affected.length} affected record(s) found.`);
  if (affected.length && !DRY_RUN) {
    console.log("DRY_RUN is false. Confirm the SKU list above before running any url_key PUT.");
  }
  return affected;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
