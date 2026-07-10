/**
 * Detect Magento 2 products that flap out of category or search results during
 * a scheduled reindex, and tell flapping (transient, self healing) apart from
 * stuck (worth escalating). Never writes to the index. Run on a schedule during
 * a known reindex window. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/products-flap-during-scheduled-indexing/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CATEGORY_IDS = (process.env.WATCH_CATEGORY_IDS || "").split(",").filter(Boolean);
const SEARCH_TERMS = (process.env.WATCH_SEARCH_TERMS || "").split(",").filter(Boolean);
const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC || 8);
const POLL_COUNT = Number(process.env.POLL_COUNT || 6);
const CRON_INTERVAL_SEC = Number(process.env.CRON_INTERVAL_SEC || 60);

/**
 * Pure decision function. No I/O.
 *
 * baselineSkus: Set of SKUs expected to be enabled and visible.
 * currentCategorySkus: Set of SKUs currently returned by category listing(s).
 * currentSearchSkus: Set of SKUs currently returned by the search-equivalent query.
 * previousMissing: Map of sku -> timestamp it was first seen missing.
 * nowTs: current unix timestamp (seconds).
 * cronIntervalSec: how often the scheduled indexer cron runs, default 60s.
 *
 * Returns { flapping, stuck, missingFromCategory, missingFromSearch } (all Sets).
 */
export function isProductFlapping(baselineSkus, currentCategorySkus, currentSearchSkus,
                                   previousMissing, nowTs, cronIntervalSec = 60) {
  const missingFromCategory = new Set([...baselineSkus].filter((s) => !currentCategorySkus.has(s)));
  const missingFromSearch = new Set([...baselineSkus].filter((s) => !currentSearchSkus.has(s)));
  const missingNow = new Set([...missingFromCategory, ...missingFromSearch]);

  const flapping = new Set();
  const stuck = new Set();
  for (const sku of missingNow) {
    const firstSeenTs = previousMissing.has(sku) ? previousMissing.get(sku) : nowTs;
    const missingFor = nowTs - firstSeenTs;
    if (missingFor > cronIntervalSec * 3) stuck.add(sku);
    else flapping.add(sku);
  }

  return { flapping, stuck, missingFromCategory, missingFromSearch };
}

/**
 * Pure helper. Carries forward first-missing timestamps for SKUs still
 * missing, and drops entries for SKUs that recovered.
 */
export function advanceMissingTracker(previousMissing, missingNow, nowTs) {
  const updated = new Map();
  for (const sku of missingNow) {
    updated.set(sku, previousMissing.has(sku) ? previousMissing.get(sku) : nowTs);
  }
  return updated;
}

async function get(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function put(path, body) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function baselineSkus() {
  const data = await get("products", {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "1",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[pageSize]": "200",
  });
  return new Set((data.items || []).map((item) => item.sku));
}

async function categorySkus(categoryId) {
  const data = await get(`categories/${categoryId}/products`);
  return new Set((data || []).map((row) => row.sku));
}

async function searchSkus(nameLike) {
  const data = await get("products", {
    "searchCriteria[filterGroups][0][filters][0][field]": "name",
    "searchCriteria[filterGroups][0][filters][0][value]": `%${nameLike}%`,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "like",
    "searchCriteria[pageSize]": "200",
  });
  return new Set((data.items || []).map((item) => item.sku));
}

async function reaffirmProduct(sku, status) {
  // No-op safe write: re-affirms the product's existing status so it is
  // written back into the next changelog batch. Only called when DRY_RUN
  // is explicitly turned off.
  return put(`products/${sku}`, { product: { sku, status } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run() {
  const baseline = await baselineSkus();
  console.log(`Baseline has ${baseline.size} enabled, visible product(s).`);

  let previousMissing = new Map();
  const stuckReported = new Set();

  for (let pollN = 0; pollN < POLL_COUNT; pollN++) {
    const nowTs = Date.now() / 1000;

    let currentCategory = new Set();
    for (const categoryId of CATEGORY_IDS) {
      const skus = await categorySkus(categoryId);
      currentCategory = new Set([...currentCategory, ...skus]);
    }
    let currentSearch = new Set();
    for (const term of SEARCH_TERMS) {
      const skus = await searchSkus(term);
      currentSearch = new Set([...currentSearch, ...skus]);
    }

    // If no categories or terms were configured, treat that side as fully present
    // so the check does not falsely flag everything as missing.
    const currentCategoryEffective = CATEGORY_IDS.length ? currentCategory : new Set(baseline);
    const currentSearchEffective = SEARCH_TERMS.length ? currentSearch : new Set(baseline);

    const result = isProductFlapping(
      baseline, currentCategoryEffective, currentSearchEffective,
      previousMissing, nowTs, CRON_INTERVAL_SEC,
    );

    for (const sku of result.flapping) {
      console.log(`Poll ${pollN}: ${sku} is flapping (transient, expected to self heal).`);
    }

    for (const sku of result.stuck) {
      if (stuckReported.has(sku)) continue;
      console.warn(`Poll ${pollN}: ${sku} is stuck missing for over ${CRON_INTERVAL_SEC * 3}s. ` +
        `Check indexer:show-mode and reindex catalogsearch_fulltext catalog_category_product.`);
      stuckReported.add(sku);
      if (!DRY_RUN) {
        console.log(`DRY_RUN is off: re-affirming ${sku} status=1 as a no-op workaround.`);
        await reaffirmProduct(sku, 1);
      }
    }

    const missingNow = new Set([...result.missingFromCategory, ...result.missingFromSearch]);
    previousMissing = advanceMissingTracker(previousMissing, missingNow, nowTs);

    if (pollN < POLL_COUNT - 1) await sleep(POLL_INTERVAL_SEC * 1000);
  }

  console.log(`Done. ${stuckReported.size} SKU(s) stuck across the polling window.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
