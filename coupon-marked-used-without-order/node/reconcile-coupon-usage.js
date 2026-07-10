/**
 * Reconcile Magento 2 or Adobe Commerce coupon usage against real orders.
 *
 * CouponUsagesIncrement hooks beforeSubmit on QuoteManagement and commits
 * usage counters to salesrule_coupon, salesrule_coupon_usage, and
 * salesrule_customer before the nested submitQuote call actually validates
 * the cart and creates the order. If that validation throws, for example a
 * minimum order amount check fails, the order is never created but the
 * usage increment already committed. There is no REST endpoint that
 * decrements these counters, so this script only ever reads coupons and
 * orders and writes a JSON report of orphaned usage for a human to review.
 *
 * Guide: https://www.allanninal.dev/magento/coupon-marked-used-without-order/
 *
 * Safe to run again and again.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const COUPON_CODES = (process.env.COUPON_CODES || "").split(",").map((c) => c.trim()).filter(Boolean);
const EXCLUDED_STATES = (process.env.EXCLUDED_STATES || "canceled").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OUTPUT_JSON = process.env.OUTPUT_JSON || "orphaned_coupon_usage.json";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);

// Pure decision logic (no I/O): for each coupon, count real, non-excluded-state
// orders that reference its code, subtract from the recorded times_used counter,
// and flag any positive remainder as orphaned (usage recorded but no corresponding
// valid order).
export function computeOrphanedCouponUsages(coupons, ordersByCouponCode, excludedStates = ["canceled"]) {
  return coupons
    .map((c) => {
      const orders = ordersByCouponCode.get(c.code) || [];
      const actualOrderCount = orders.filter((o) => !excludedStates.includes(o.state)).length;
      const orphanedCount = Math.max(0, c.timesUsed - actualOrderCount);
      return { couponId: c.couponId, code: c.code, timesUsed: c.timesUsed, actualOrderCount, orphanedCount };
    })
    .filter((r) => r.orphanedCount > 0);
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

async function fetchCoupon(token, code) {
  const params = new URLSearchParams({
    "searchCriteria[filterGroups][0][filters][0][field]": "code",
    "searchCriteria[filterGroups][0][filters][0][value]": code,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/salesRules/coupons/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  const items = body.items || [];
  return items[0] || null;
}

async function* ordersForCoupon(token, code, pageSize = PAGE_SIZE) {
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
      "searchCriteria[filterGroups][0][filters][0][value]": code,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": String(pageSize),
      "searchCriteria[currentPage]": String(page),
    });
    const res = await fetch(`${MAGENTO_URL}/rest/V1/orders?${params}`, {
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

function writeReport(rows, path) {
  writeFileSync(path, JSON.stringify(rows, null, 2));
}

export async function run() {
  const token = await getToken();
  const coupons = [];
  const ordersByCode = new Map();

  for (const code of COUPON_CODES) {
    const coupon = await fetchCoupon(token, code);
    if (!coupon) {
      console.warn(`Coupon code ${code} not found, skipping.`);
      continue;
    }
    coupons.push({
      couponId: coupon.coupon_id,
      ruleId: coupon.rule_id,
      code: coupon.code,
      timesUsed: coupon.times_used,
    });
    const orders = [];
    for await (const o of ordersForCoupon(token, code)) {
      orders.push({ entityId: o.entity_id, incrementId: o.increment_id, state: o.state });
    }
    ordersByCode.set(code, orders);
  }

  const orphaned = computeOrphanedCouponUsages(coupons, ordersByCode, EXCLUDED_STATES);

  for (const row of orphaned) {
    console.log(`Coupon ${row.code}: times_used=${row.timesUsed} actual_orders=${row.actualOrderCount} orphaned=${row.orphanedCount}`);
  }

  if (orphaned.length) {
    writeReport(orphaned, OUTPUT_JSON);
  }

  console.log(`Done. ${orphaned.length} coupon(s) with orphaned usage. DRY_RUN=${DRY_RUN}. This script only reads and reports; no database write happens either way.`);
  return orphaned;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
