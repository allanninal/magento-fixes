/**
 * Detect a Magento 2 or Adobe Commerce catalog price rule discounting the
 * wrong starting price.
 *
 * The catalog price rule indexer (Magento\CatalogRule\Model\Indexer\IndexBuilder)
 * computes rule_price in catalogrule_product_price by applying the rule's
 * discount action to the product's base/website price row, rather than
 * looking up the customer-group-specific tier price row in
 * catalog_product_entity_tier_price. So a rule scoped to one customer group
 * can discount the wrong starting amount, or leak its discount to a customer
 * group outside its configured customer_group_ids scope. This script has no
 * write path: catalog price rules have no public catalogRule/save REST
 * endpoint, and catalogrule_product_price rows are indexer-generated and get
 * overwritten on the next cron run, so directly editing them is unsafe. It
 * only detects and reports. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/catalog-price-rule-wrong-base-price/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_JSON = process.env.OUTPUT_JSON || "rule_price_mismatch_report.json";

const SKUS = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
const RULE_CUSTOMER_GROUP_ID = Number(process.env.RULE_CUSTOMER_GROUP_ID || 1);
const RULE_DISCOUNT_PERCENT = Number(process.env.RULE_DISCOUNT_PERCENT || 10);

const ALL_GROUPS_ID = 32000;

function applyPriceType(basePrice, tierPriceRow) {
  if (tierPriceRow.priceType === "discount") return basePrice * (1 - tierPriceRow.price / 100);
  return tierPriceRow.price;
}

function resolveTierPrice(basePrice, tierPrices, ruleCustomerGroupId) {
  const qty1Rows = tierPrices.filter((tp) => (tp.qty ?? 1) === 1);

  const groupRow = qty1Rows.find((tp) => tp.customerGroupId === ruleCustomerGroupId);
  if (groupRow) return applyPriceType(basePrice, groupRow);

  const allGroupsRow = qty1Rows.find((tp) => tp.customerGroupId === ALL_GROUPS_ID);
  if (allGroupsRow) return applyPriceType(basePrice, allGroupsRow);

  return basePrice;
}

function detectScopeLeak(basePrice, tierPrices, ruleCustomerGroupId, ruleDiscountPercent, actualPrice, tolerance) {
  const qty1Rows = tierPrices.filter((tp) => (tp.qty ?? 1) === 1);
  for (const tp of qty1Rows) {
    if (tp.customerGroupId === ruleCustomerGroupId) continue;
    const otherStartingPrice = applyPriceType(basePrice, tp);
    const otherExpected = otherStartingPrice * (1 - ruleDiscountPercent / 100);
    if (Math.abs(otherExpected - actualPrice) <= tolerance) return "scope_leak";
  }
  return "base_price_used";
}

/**
 * Pure function. No network or DB I/O.
 *
 * Resolves the qty=1 tier price row matching ruleCustomerGroupId (falling
 * back to group 32000, ALL GROUPS, if no group-specific row exists), computes
 * expectedPrice = tierOrBasePrice * (1 - ruleDiscountPercent / 100), compares
 * it to actualPrice within tolerance, and classifies the failure as
 * base_price_used when actualPrice matches basePrice * (1 - discount) instead
 * of the tier price, or scope_leak when actualPrice reflects the discount for
 * a customerGroupId outside ruleCustomerGroupId.
 */
export function evaluateRulePriceMismatch(basePrice, tierPrices, ruleCustomerGroupId, ruleDiscountPercent, actualPrice, tolerance = 0.01) {
  const startingPrice = resolveTierPrice(basePrice, tierPrices, ruleCustomerGroupId);
  const expectedPrice = startingPrice * (1 - ruleDiscountPercent / 100);
  const isMismatch = Math.abs(expectedPrice - actualPrice) > tolerance;

  let mismatchType = null;
  if (isMismatch) {
    const baseDiscounted = basePrice * (1 - ruleDiscountPercent / 100);
    if (Math.abs(actualPrice - baseDiscounted) <= tolerance && Math.abs(startingPrice - basePrice) > tolerance) {
      mismatchType = "base_price_used";
    } else {
      mismatchType = detectScopeLeak(basePrice, tierPrices, ruleCustomerGroupId, ruleDiscountPercent, actualPrice, tolerance);
    }
  }

  return { expectedPrice, isMismatch, mismatchType };
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

async function tierPricesFor(token, skus) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/tier-prices-information`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ skus }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function actualPrice(token, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  const specialPrice = (body.custom_attributes || []).find((a) => a.attribute_code === "special_price");
  if (specialPrice && specialPrice.value) return Number(specialPrice.value);
  return body.price;
}

export async function run() {
  const token = await getToken();

  if (SKUS.length === 0) {
    console.warn("No SKUS configured. Set SKUS to a comma separated list to check.");
    return;
  }

  const tierInfo = await tierPricesFor(token, SKUS);
  const tierBySku = {};
  for (const row of tierInfo) {
    const list = tierBySku[row.sku] || (tierBySku[row.sku] = []);
    list.push({
      customerGroupId: row.customer_group_id ?? ALL_GROUPS_ID,
      price: row.price,
      priceType: row.price_type || "fixed",
      qty: row.qty ?? 1,
    });
  }

  const report = [];
  for (const sku of SKUS) {
    const base = await basePrice(token, sku);
    const rows = tierBySku[sku] || [];
    const actual = await actualPrice(token, sku);

    const result = evaluateRulePriceMismatch(base, rows, RULE_CUSTOMER_GROUP_ID, RULE_DISCOUNT_PERCENT, actual);

    if (result.isMismatch) {
      const entry = {
        sku,
        customerGroupId: RULE_CUSTOMER_GROUP_ID,
        expectedPrice: Math.round(result.expectedPrice * 100) / 100,
        actualPrice: actual,
        delta: Math.round((actual - result.expectedPrice) * 100) / 100,
        mismatchType: result.mismatchType,
      };
      report.push(entry);
      console.warn(
        `MISMATCH sku=${sku} group=${RULE_CUSTOMER_GROUP_ID} expected=${result.expectedPrice.toFixed(2)} actual=${actual.toFixed(2)} type=${result.mismatchType}`,
      );
    }
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2));

  if (report.length > 0 && !DRY_RUN) {
    console.warn(
      `DRY_RUN is false, but this script never rewrites catalog price rules or catalogrule_product_price rows itself. Review ${OUTPUT_JSON} and, if confirmed, re-save the rule scoped strictly to the intended customer group(s)/websites, then run bin/magento indexer:reindex catalogrule_rule catalogrule_product catalog_product_price.`,
    );
  }

  console.log(`Done. ${report.length} mismatch(es) written to ${OUTPUT_JSON}.`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
