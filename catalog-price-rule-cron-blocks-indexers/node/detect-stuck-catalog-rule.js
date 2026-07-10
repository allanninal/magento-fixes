/**
 * Detect a stuck Magento 2 or Adobe Commerce catalogrule_apply_all lock.
 *
 * catalogrule_apply_all recalculates catalog price rule prices and invalidates
 * catalog_product_price and catalogsearch_fulltext for every store view. A new
 * store view with an incomplete locale or timezone setup, or a rule whose
 * catalogrule_product relationship has not been built yet, can make the job
 * throw and exit non zero. Magento's scheduler then treats the lock as still
 * held, so indexer_reindex_all_invalid and indexer_update_all_views cannot
 * acquire it and stop running for every store. This script compares the
 * expected rule discounted price to the live storefront price, and separately
 * checks cron_schedule for error or stale running rows on the relevant job
 * codes. It never forces catalogrule_apply_all, a reindex, or a cron_schedule
 * write itself: that is CLI and database operator territory. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/magento/catalog-price-rule-cron-blocks-indexers/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const STORE_CODES = (process.env.STORE_CODES || "default").split(",").map((s) => s.trim()).filter(Boolean);
const LOCK_TIMEOUT_MINUTES = Number(process.env.LOCK_TIMEOUT_MINUTES || 15);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_JSON = process.env.OUTPUT_JSON || "stuck_catalog_rule_report.json";

// Rules and cron rows are supplied by the operator: there is no public
// /V1/catalogRule REST endpoint, and cron_schedule is a database table with
// no REST route. Populate these from your own Admin/DB access, or wire in
// your own fetchers inside run() below.
const RULES = JSON.parse(process.env.RULES_JSON || "[]");
const CRON_ROWS = JSON.parse(process.env.CRON_ROWS_JSON || "[]");
const SKUS = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);

const STUCK_JOB_CODES = new Set(["catalogrule_apply_all", "indexer_reindex_all_invalid", "indexer_update_all_views"]);

function expectedPrice(base, rule) {
  if (rule.simpleAction === "by_percent") return base * (1 - rule.discountAmount / 100);
  return base - rule.discountAmount;
}

function ruleActive(rule, nowIso) {
  if (rule.fromDate && nowIso < rule.fromDate) return false;
  if (rule.toDate && nowIso > rule.toDate) return false;
  return true;
}

/**
 * Pure decision function. No network, no I/O.
 *
 * rules: [{ruleId, websiteIds, discountAmount, simpleAction, fromDate, toDate}]
 * productPrices: [{sku, storeId, basePrice, livePrice}]
 * cronRows: [{jobCode, status, scheduledAt}]
 * nowIso: ISO 8601 timestamp string
 */
export function detectStuckCatalogRulePricing(rules, productPrices, cronRows, nowIso, lockTimeoutMinutes = LOCK_TIMEOUT_MINUTES) {
  const now = new Date(nowIso);

  const affectedSkus = new Set();
  const affectedRuleIds = new Set();
  for (const pp of productPrices) {
    for (const rule of rules) {
      if (!rule.websiteIds.includes(pp.storeId)) continue;
      if (!ruleActive(rule, nowIso)) continue;
      const expected = expectedPrice(pp.basePrice, rule);
      if (Math.abs(expected - pp.livePrice) > 0.01) {
        affectedSkus.add(pp.sku);
        affectedRuleIds.add(rule.ruleId);
      }
    }
  }

  const staleCronJobs = new Set();
  for (const row of cronRows) {
    if (!STUCK_JOB_CODES.has(row.jobCode)) continue;
    if (row.status === "error") {
      staleCronJobs.add(row.jobCode);
    } else if (row.status === "running") {
      const ageMinutes = (now - new Date(row.scheduledAt)) / 60000;
      if (ageMinutes > lockTimeoutMinutes) staleCronJobs.add(row.jobCode);
    }
  }

  const stuck = affectedSkus.size > 0 && staleCronJobs.size > 0;
  return {
    stuck,
    affectedSkus: [...affectedSkus].sort(),
    affectedRuleIds: [...affectedRuleIds].sort((a, b) => a - b),
    staleCronJobs: [...staleCronJobs].sort(),
  };
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

async function basePrice(token, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.price;
}

async function livePrice(token, storeCode, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/${storeCode}/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.price;
}

function storeIds(storeCodes) {
  // Maps configured store codes to numeric store ids for comparison against
  // rule websiteIds. Wire this to your own store code -> store id lookup,
  // for example GET /rest/V1/store/storeViews, if the codes are not the ids.
  const map = {};
  storeCodes.forEach((code, idx) => { map[code] = idx + 1; });
  return map;
}

export async function run() {
  const token = await getToken();
  const nowIso = new Date().toISOString();

  const productPrices = [];
  const codeToId = storeIds(STORE_CODES);
  for (const sku of SKUS) {
    const base = await basePrice(token, sku);
    for (const [storeCode, storeId] of Object.entries(codeToId)) {
      let live;
      try {
        live = await livePrice(token, storeCode, sku);
      } catch (err) {
        console.warn(`Could not read live price for ${sku} in ${storeCode}: ${err.message}`);
        continue;
      }
      productPrices.push({ sku, storeId, basePrice: base, livePrice: live });
    }
  }

  const result = detectStuckCatalogRulePricing(RULES, productPrices, CRON_ROWS, nowIso);

  console.log(
    `stuck=${result.stuck} affectedSkus=${JSON.stringify(result.affectedSkus)} affectedRuleIds=${JSON.stringify(result.affectedRuleIds)} staleCronJobs=${JSON.stringify(result.staleCronJobs)}`,
  );

  writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2));

  if (result.stuck && !DRY_RUN) {
    console.warn(
      `DRY_RUN is false, but this script never resets cron_schedule or forces catalogrule_apply_all itself. Review ${OUTPUT_JSON} and, if confirmed, run the reset SQL manually with DB access.`,
    );
  }

  console.log(`Done. Report written to ${OUTPUT_JSON}.`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
