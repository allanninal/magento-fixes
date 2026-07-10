/**
 * Detect the transient product-vanishing gap in Magento's catalog_product_price reindex.
 *
 * Reindex/cron and direct index-table access are CLI/DB-only, so this detects the
 * symptom over REST: it records the enabled and visible SKU set before, during, and
 * after a known reindex window, cross references indexer status, and reports whether
 * a drop is the expected self-healing batching race or a genuine, still-missing product.
 * It never calls a mutating endpoint for a transient gap. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/products-vanish-during-price-reindex/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 5);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic. No I/O; all inputs are pre-fetched arrays/status strings.
 *
 * Returns:
 *   isTransientDropDetected: boolean
 *   missingDuringWindow: sorted array of SKUs missing between before and during
 *   falsePositive: boolean
 *   recommendation: "flag_transient_index_gap" | "flag_permanent_loss" | "ok"
 */
export function decideReindexAnomaly(beforeSkus, duringSkus, afterSkus, indexerStatus) {
  const beforeSet = new Set(beforeSkus);
  const duringSet = new Set(duringSkus);
  const afterSet = new Set(afterSkus);
  const missing = [...beforeSet].filter((sku) => !duringSet.has(sku));
  const stillMissingAfter = missing.filter((sku) => !afterSet.has(sku));

  if (missing.length === 0) {
    return {
      isTransientDropDetected: false,
      missingDuringWindow: [],
      falsePositive: beforeSkus.length !== afterSkus.length,
      recommendation: "ok",
    };
  }

  const reindexing =
    indexerStatus.code === "catalog_product_price" &&
    (indexerStatus.status === "processing" || indexerStatus.status === "invalid");

  if (stillMissingAfter.length === 0 && reindexing) {
    return {
      isTransientDropDetected: true,
      missingDuringWindow: missing.sort(),
      falsePositive: false,
      recommendation: "flag_transient_index_gap",
    };
  }

  if (stillMissingAfter.length > 0) {
    return {
      isTransientDropDetected: false,
      missingDuringWindow: missing.sort(),
      falsePositive: false,
      recommendation: "flag_permanent_loss",
    };
  }

  return {
    isTransientDropDetected: false,
    missingDuringWindow: missing.sort(),
    falsePositive: true,
    recommendation: "ok",
  };
}

async function enabledVisibleSkus() {
  const skus = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[filterGroups][0][filters][0][field]": "status",
      "searchCriteria[filterGroups][0][filters][0][value]": "1",
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[filterGroups][1][filters][0][field]": "visibility",
      "searchCriteria[filterGroups][1][filters][0][value]": "2,3,4",
      "searchCriteria[filterGroups][1][filters][0][conditionType]": "in",
      "searchCriteria[pageSize]": String(PAGE_SIZE),
      "searchCriteria[currentPage]": String(page),
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/products?${params}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`Magento ${res.status}`);
    const body = await res.json();
    const items = body.items || [];
    for (const item of items) skus.push(item.sku);
    if (items.length < PAGE_SIZE) return skus;
    page++;
  }
}

async function priceIndexerStatus() {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/indexer`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const rows = await res.json();
  const row = rows.find((r) => r.indexer_id === "catalog_product_price");
  return { code: "catalog_product_price", status: row ? row.status || "" : "unknown" };
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function run() {
  console.log("Recording before snapshot.");
  const beforeSkus = await enabledVisibleSkus();

  console.log(`Waiting ${POLL_INTERVAL_SECONDS}s to bracket the reindex window.`);
  await sleep(POLL_INTERVAL_SECONDS);

  console.log("Recording during snapshot and indexer status.");
  const duringSkus = await enabledVisibleSkus();
  const indexerStatus = await priceIndexerStatus();

  console.log(`Waiting ${POLL_INTERVAL_SECONDS}s for the reindex to finish before the after snapshot.`);
  await sleep(POLL_INTERVAL_SECONDS);

  console.log("Recording after snapshot.");
  const afterSkus = await enabledVisibleSkus();

  const result = decideReindexAnomaly(beforeSkus, duringSkus, afterSkus, indexerStatus);

  if (result.recommendation === "ok") {
    console.log(`No anomaly detected. ${beforeSkus.length} before, ${afterSkus.length} after.`);
  } else if (result.recommendation === "flag_transient_index_gap") {
    console.warn(
      `Transient index gap detected during catalog_product_price reindex. ${result.missingDuringWindow.length} SKU(s) dipped and returned: ${result.missingDuringWindow.join(", ")}`
    );
    console.warn(`This is expected, self healing batching behavior. No write performed. DRY_RUN=${DRY_RUN}`);
  } else if (result.recommendation === "flag_permanent_loss") {
    console.error(
      `${result.missingDuringWindow.length} SKU(s) missing during the window and still missing after it finished: ${result.missingDuringWindow.join(", ")}`
    );
    console.error("This looks like a real removal, not a reindex race. A human should confirm before any product is re-enabled. No write performed.");
  }

  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
