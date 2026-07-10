/**
 * Flag Magento 2 or Adobe Commerce SKUs where the storefront price index is stale.
 *
 * Magento precomputes storefront prices into catalog_product_price and
 * catalog_product_index_price. Under Update by Schedule, an admin price edit or
 * catalog rule change sits as a pending changelog row until the price indexer
 * cron actually runs. If cron is stalled or an indexer is stuck, the storefront
 * keeps serving the last indexed price. This script diffs the admin price
 * against the store scoped price for recently edited SKUs and reports the
 * mismatches. It never runs a reindex or touches cron: that is CLI and operator
 * only (bin/magento indexer:reindex catalog_product_price).
 *
 * Guide: https://www.allanninal.dev/magento/stale-price-index-wrong-prices/
 *
 * Safe to run again and again. DRY_RUN defaults to true.
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const STORE_CODE = process.env.STORE_CODE || "default";
const SINCE = process.env.SINCE || "1970-01-01 00:00:00";
const LAST_REINDEX_AT = process.env.LAST_REINDEX_AT || null;
const PRICE_EPSILON = Number(process.env.PRICE_EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);

/**
 * Pure. No I/O.
 *
 * Takes an already-fetched admin price, storefront-scoped price, the
 * product's updated_at, and the last known reindex timestamp, and decides
 * whether the mismatch is explained by a pending reindex (safe to flag for
 * the normal reindex job) versus an unexplained mismatch (for example a rule
 * misconfiguration) that should only be flagged for a human, never
 * auto-written.
 */
export function decidePriceIndexAction(adminPrice, storefrontPrice, updatedAt, lastReindexAt, epsilon = PRICE_EPSILON) {
  const diff = Math.abs(adminPrice - storefrontPrice);
  if (diff <= epsilon) return { stale: false, action: "none" };
  const editedAfterReindex = lastReindexAt === null || new Date(updatedAt) > new Date(lastReindexAt);
  if (editedAfterReindex) return { stale: true, action: "flag_reindex" };
  return { stale: true, action: "flag_investigate" };
}

async function getToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  const res = await fetch(`${MAGENTO_URL}/rest/V1/integration/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function* recentProducts(token, since, pageSize = PAGE_SIZE) {
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
      "searchCriteria[filterGroups][0][filters][0][value]": since,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
      "searchCriteria[pageSize]": String(pageSize),
      "searchCriteria[currentPage]": String(page),
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/products?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Magento ${res.status}`);
    const body = await res.json();
    const items = body.items || [];
    for (const item of items) yield item;
    if (items.length < pageSize) return;
    page++;
  }
}

async function storefrontPrice(token, storeCode, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/${storeCode}/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.price;
}

/**
 * The only REST-safe corrective action: a no-op re-save of the price
 * attribute. This enqueues the SKU in the catalog_product_price changelog
 * so the next scheduled/cron reindex (or an operator-run
 * bin/magento indexer:reindex catalog_product_price) picks it up. It does
 * not force an immediate reindex.
 */
async function nudgeChangelog(token, sku, adminPrice) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ product: { sku, price: adminPrice } }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  const flagged = [];
  for await (const product of recentProducts(token, SINCE)) {
    const sku = product.sku;
    const adminPrice = product.price;
    const updatedAt = product.updated_at;
    if (sku == null || adminPrice == null || updatedAt == null) continue;

    let storePrice;
    try {
      storePrice = await storefrontPrice(token, STORE_CODE, sku);
    } catch (err) {
      console.warn(`Could not read storefront price for ${sku}: ${err.message}`);
      continue;
    }

    const verdict = decidePriceIndexAction(adminPrice, storePrice, updatedAt, LAST_REINDEX_AT);
    if (!verdict.stale) continue;

    const row = {
      sku,
      adminPrice,
      storefrontPrice: storePrice,
      diff: Math.round(Math.abs(adminPrice - storePrice) * 100) / 100,
      updated_at: updatedAt,
      action: verdict.action,
    };
    flagged.push(row);
    console.log(`SKU ${row.sku}: admin=${row.adminPrice} storefront=${row.storefrontPrice} diff=${row.diff} action=${row.action}`);

    if (!DRY_RUN && verdict.action === "flag_reindex") {
      await nudgeChangelog(token, sku, adminPrice);
      console.log(`Nudged ${sku} back into the price changelog.`);
    }
  }
  console.log(`Done. ${flagged.length} SKU(s) flagged, ${DRY_RUN ? "dry run, nothing written" : "nudge applied where safe"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
