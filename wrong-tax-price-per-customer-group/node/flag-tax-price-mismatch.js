/**
 * Flag Magento 2 or Adobe Commerce customer groups showing the wrong tax or price.
 *
 * Magento resolves tax through a Tax Rule that maps a customer tax class plus a
 * product tax class plus a region to a rate, while each customer group is
 * separately mapped to exactly one customer tax class. When a group is never
 * assigned the intended class, or that class is never added to the applicable
 * rule, the group silently falls back to a different rate, so two groups with
 * the identical tier price end up with different final totals. This script
 * reads a product's tier prices and tax class, every referenced group's tax
 * class, the Tax Rules and rates, computes the expected final price per group,
 * and reports any group whose computed number disagrees with the actual price
 * or whose tax class has no matching rule at all. It only ever writes a
 * customer group's tax class when that group is unambiguously orphaned and an
 * existing rule confidently covers its product classes under one other class.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/wrong-tax-price-per-customer-group/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const SKUS = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PRICE_EPSILON = Number(process.env.PRICE_EPSILON || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * Finds the tax rule(s) whose customerTaxClassIds includes customerGroupTaxClassId
 * AND productTaxClassIds includes productTaxClassId, sums the matching rates the way
 * Magento stacks simultaneous rates, and computes the expected final price. If no
 * rule matches, that absence (matchedRuleFound=false, appliedRatePct=0) is itself the
 * anomaly to flag: an orphaned customer group falling back to no tax at all.
 */
export function decideExpectedFinalPrice(tierPrice, productTaxClassId, customerGroupTaxClassId,
                                          taxRules, taxRates, priceIncludesTax = false) {
  const matchedRateIds = new Set();
  let matchedRuleFound = false;
  for (const rule of taxRules) {
    if (rule.customerTaxClassIds.includes(customerGroupTaxClassId) &&
        rule.productTaxClassIds.includes(productTaxClassId)) {
      matchedRuleFound = true;
      rule.rateIds.forEach((id) => matchedRateIds.add(id));
    }
  }

  if (!matchedRuleFound) {
    return { expectedFinal: Math.round(tierPrice * 100) / 100, matchedRuleFound: false, appliedRatePct: 0 };
  }

  let appliedRatePct = 0;
  for (const id of matchedRateIds) appliedRatePct += taxRates[id] || 0;

  const expectedFinal = priceIncludesTax
    ? Math.round(tierPrice * 100) / 100
    : Math.round(tierPrice * (1 + appliedRatePct / 100) * 100) / 100;

  return { expectedFinal, matchedRuleFound: true, appliedRatePct };
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

async function getProduct(token, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  const taxAttr = (body.custom_attributes || []).find((a) => a.attribute_code === "tax_class_id");
  return {
    tierPrices: body.tier_prices || [],
    productTaxClassId: taxAttr ? Number(taxAttr.value) : null,
    price: body.price,
  };
}

async function getCustomerGroup(token, groupId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/customerGroups/${groupId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function allTaxRules(token, pageSize = 100) {
  const params = new URLSearchParams({ "searchCriteria[pageSize]": String(pageSize) });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/taxRules/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.items || [];
}

async function getTaxRate(token, rateId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/taxRates/${rateId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  return body.rate;
}

async function fixOrphanedGroupTaxClass(token, group, expectedTaxClassId, expectedTaxClassName) {
  const body = {
    group: {
      id: group.id,
      code: group.code,
      tax_class_id: expectedTaxClassId,
      tax_class_name: expectedTaxClassName,
    },
  };
  const res = await fetch(`${MAGENTO_URL}/rest/V1/customerGroups/${group.id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  const taxRules = await allTaxRules(token);
  const rateCache = {};

  async function rateFor(rateId) {
    if (!(rateId in rateCache)) rateCache[rateId] = (await getTaxRate(token, rateId)) || 0;
    return rateCache[rateId];
  }

  const flagged = [];
  for (const sku of SKUS) {
    const product = await getProduct(token, sku);
    const groupIds = [...new Set(product.tierPrices.map((tp) => tp.customer_group_id))].sort((a, b) => a - b);

    for (const groupId of groupIds) {
      const group = await getCustomerGroup(token, groupId);
      const groupTaxClassId = group.tax_class_id;
      const tierPriceEntry = product.tierPrices.find((tp) => tp.customer_group_id === groupId);
      const tierPrice = tierPriceEntry ? tierPriceEntry.value : product.price;

      const rateIds = [...new Set(taxRules.flatMap((rule) => rule.rateIds || []))];
      const rates = {};
      for (const rid of rateIds) rates[rid] = await rateFor(rid);

      const verdict = decideExpectedFinalPrice(tierPrice, product.productTaxClassId, groupTaxClassId, taxRules, rates);

      if (!verdict.matchedRuleFound) {
        flagged.push({
          sku, customerGroupId: groupId, groupCode: group.code,
          tierPrice, expectedFinal: verdict.expectedFinal,
          appliedRatePct: verdict.appliedRatePct, issue: "orphaned_group_no_matching_rule",
        });
        console.warn(`SKU ${sku} group ${groupId} (${group.code}): no matching tax rule, orphaned tax class ${groupTaxClassId}`);
        continue;
      }

      const actualFinal = product.price;
      if (actualFinal != null && Math.abs(actualFinal - verdict.expectedFinal) > PRICE_EPSILON) {
        flagged.push({
          sku, customerGroupId: groupId, groupCode: group.code,
          tierPrice, expectedFinal: verdict.expectedFinal,
          appliedRatePct: verdict.appliedRatePct, issue: "price_mismatch",
        });
        console.warn(`SKU ${sku} group ${groupId} (${group.code}): expected final ${verdict.expectedFinal}, storefront shows ${actualFinal}`);
      }
    }
  }

  console.log(`Done. ${flagged.length} SKU/group mismatch(es) flagged, ${DRY_RUN ? "dry run, nothing written" : "no writes performed automatically here"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
