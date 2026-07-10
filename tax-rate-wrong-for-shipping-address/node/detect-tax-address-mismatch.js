/**
 * Detect Magento 2 or Adobe Commerce orders where the applied tax rate does
 * not match the address the store's own Tax Calculation Based On setting
 * says should have been used.
 *
 * Magento resolves the applicable tax zone using the address selected by the
 * store-wide Tax Calculation Based On setting (Stores, Configuration, Sales,
 * Tax, Calculation Settings), which can be Billing Address, Shipping
 * Address, or Shipping Origin. For a logged-in customer with more than one
 * saved address, quote and order totals collection can resolve the tax
 * class against the customer's default address record instead of
 * re-resolving it against the shipping address actually selected at
 * checkout, especially across multi-address customers or multi-country
 * carts. This is confirmed in magento2 issue 38232, where a French address
 * was taxed at 0% because the customer's default Belgium address was used
 * instead. The tax rule engine itself is deterministic; the defect is an
 * address resolution problem upstream of rule matching, not a rule
 * configuration error.
 *
 * This script never rewrites tax_amount on a placed order, since there is
 * no supported REST endpoint for that. It independently computes the
 * expected rate for the address the store's based_on setting points at,
 * compares it to what the order actually applied, and separately flags any
 * order whose shipping address customer_address_id differs from the
 * customer's own default_shipping or default_billing id, the highest risk
 * signature of this leak. It writes a report row for every order it flags
 * and exits non-zero so CI or alerting notices. A human reconciles a
 * confirmed mismatch with a credit memo to refund the wrong tax line,
 * followed by a corrected invoice. Only with DRY_RUN=false and
 * REPAIR_CONFIRM=true does it post a documentation comment via
 * /rest/V1/orders/{id}/comments; it never mutates tax or money on its own.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/tax-rate-wrong-for-shipping-address/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const ORDER_IDS = (process.env.ORDER_IDS || "").split(",").map((o) => o.trim()).filter(Boolean);
const RATE_EPSILON = Number(process.env.RATE_EPSILON || 0.05);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPAIR_CONFIRM = (process.env.REPAIR_CONFIRM || "false").toLowerCase() === "true";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);

function rateMatchesAddress(rate, address) {
  if (String(rate.tax_country_id) !== String(address.country_id)) return false;
  const regionId = rate.tax_region_id;
  if (regionId !== null && regionId !== undefined && regionId !== 0 && regionId !== "0" && String(regionId) !== String(address.region_id)) {
    return false;
  }
  const postcode = rate.tax_postcode || "*";
  if (postcode === "*" || postcode === "") return true;
  if (postcode.includes("-")) {
    const [lo, hi] = postcode.split("-");
    const pc = address.postcode || "";
    return lo <= pc && pc <= hi;
  }
  return postcode === address.postcode;
}

/**
 * Pure function. Resolves the expected tax rate for a given address,
 * customer tax class, and product tax class against fixture rule/rate
 * tables. No I/O, fully unit-testable.
 *
 * resolvedAddress: {country_id, region_id, postcode}
 * Returns: {expectedRate, matchedRuleId}
 */
export function expectedTaxRate(resolvedAddress, customerTaxClassId, productTaxClassId, taxRules, taxRates) {
  const ratesById = new Map(taxRates.map((r) => [r.id, r]));

  const candidateRules = taxRules
    .filter((rule) =>
      (rule.customer_tax_class_ids || []).includes(customerTaxClassId) &&
      (rule.product_tax_class_ids || []).includes(productTaxClassId)
    )
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  for (const rule of candidateRules) {
    let matchedRateTotal = 0;
    let matchedAny = false;
    for (const rateId of rule.tax_rate_ids || []) {
      const rate = ratesById.get(rateId);
      if (!rate) continue;
      if (rateMatchesAddress(rate, resolvedAddress)) {
        matchedRateTotal += Number(rate.rate || 0);
        matchedAny = true;
      }
    }
    if (matchedAny) return { expectedRate: matchedRateTotal, matchedRuleId: rule.id };
  }

  return { expectedRate: 0, matchedRuleId: null };
}

export function detectTaxMismatch(orderActualRate, expectedResult, epsilon = RATE_EPSILON) {
  const delta = Math.abs(orderActualRate - expectedResult.expectedRate);
  return {
    isMismatch: delta > epsilon,
    expectedRate: expectedResult.expectedRate,
    actualRate: orderActualRate,
    delta: Math.round(delta * 10000) / 10000,
    matchedRuleId: expectedResult.matchedRuleId,
  };
}

export function isDefaultAddressLeak(shippingCustomerAddressId, defaultShippingId, defaultBillingId) {
  if (shippingCustomerAddressId === null || shippingCustomerAddressId === undefined) return false;
  return (
    String(shippingCustomerAddressId) !== String(defaultShippingId) &&
    String(shippingCustomerAddressId) !== String(defaultBillingId)
  );
}

export function resolvedAddressForOrder(order, basedOn) {
  const ext = order.extension_attributes || {};
  const assignments = ext.shipping_assignments || [];
  let shippingAddress = {};
  if (assignments.length) {
    shippingAddress = (assignments[0].shipping || {}).address || {};
  }
  const billingAddress = order.billing_address || {};
  return basedOn === "billing" ? billingAddress : shippingAddress;
}

export function orderActualRate(order) {
  const applied = order.applied_taxes || [];
  if (applied.length) return Number(applied[0].percent ?? applied[0].rate ?? 0);
  const items = order.items || [];
  for (const item of items) {
    if (item.tax_percent !== undefined && item.tax_percent !== null) return Number(item.tax_percent);
  }
  return 0;
}

export function buildReportRow(order, mismatch, leak) {
  return {
    order_id: order.entity_id,
    increment_id: order.increment_id,
    expected_rate: mismatch.expectedRate,
    actual_rate: mismatch.actualRate,
    delta: mismatch.delta,
    matched_rule_id: mismatch.matchedRuleId,
    default_address_leak: leak,
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

async function getStoreTaxBasedOn(token) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/store/storeConfigs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const configs = await res.json();
  const first = configs[0] || {};
  return (first.extension_attributes || {}).tax_calculation_based_on || "shipping";
}

async function getOrder(token, orderId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getCustomer(token, customerId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function searchAll(token, path, pageSize = PAGE_SIZE) {
  const items = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[pageSize]": String(pageSize),
      "searchCriteria[currentPage]": String(page),
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Magento ${res.status}`);
    const body = await res.json();
    const batch = body.items || [];
    items.push(...batch);
    if (batch.length < pageSize) return items;
    page += 1;
  }
}

async function getTaxRules(token) {
  return searchAll(token, "taxRules/search");
}

async function getTaxRates(token) {
  return searchAll(token, "taxRates/search");
}

async function postOrderComment(token, orderId, message) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders/${orderId}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ statusHistory: { comment: message, isVisibleOnFront: 0 } }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  const basedOn = await getStoreTaxBasedOn(token);
  const taxRules = await getTaxRules(token);
  const taxRates = await getTaxRates(token);
  const flagged = [];

  for (const orderId of ORDER_IDS) {
    const order = await getOrder(token, orderId);
    const address = resolvedAddressForOrder(order, basedOn);
    if (!address || Object.keys(address).length === 0) continue;

    const customerTaxClassId = order.customer_tax_class_id;
    const items = order.items || [];
    const productTaxClassId = items.length ? items[0].tax_class_id : null;

    const expected = expectedTaxRate(address, customerTaxClassId, productTaxClassId, taxRules, taxRates);
    const actualRate = orderActualRate(order);
    const mismatch = detectTaxMismatch(actualRate, expected);

    let leak = false;
    if (order.customer_id) {
      const customer = await getCustomer(token, order.customer_id);
      const ext = order.extension_attributes || {};
      const assignments = ext.shipping_assignments || [];
      let shippingCustomerAddressId = null;
      if (assignments.length) {
        shippingCustomerAddressId = ((assignments[0].shipping || {}).address || {}).customer_address_id;
      }
      leak = isDefaultAddressLeak(shippingCustomerAddressId, customer.default_shipping, customer.default_billing);
    }

    if (!mismatch.isMismatch && !leak) continue;

    const row = buildReportRow(order, mismatch, leak);
    flagged.push(row);
    console.warn(`Order ${row.increment_id} tax mismatch: expected_rate=${row.expected_rate} actual_rate=${row.actual_rate} delta=${row.delta} default_address_leak=${row.default_address_leak}`);

    if (!DRY_RUN && REPAIR_CONFIRM) {
      await postOrderComment(
        token, orderId,
        `Tax review: expected rate ${row.expected_rate}%, applied rate ${row.actual_rate}%, delta ${row.delta}. ` +
        `Possible default-address leak: ${row.default_address_leak}. Flagged for finance review; no tax or money was changed automatically.`,
      );
    }
  }

  console.log(`Done. ${flagged.length} order(s) flagged with a tax or address mismatch.${DRY_RUN ? " (dry run, report only)" : ""}`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((flagged) => { if (flagged.length) process.exit(1); })
    .catch((err) => { console.error(err); process.exit(1); });
}
