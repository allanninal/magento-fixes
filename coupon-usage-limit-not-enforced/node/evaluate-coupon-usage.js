/**
 * Detect Magento 2 and Adobe Commerce coupons that are being reused past
 * their configured limit, safely.
 *
 * Since Magento 2.4.3, coupon usage bookkeeping (salesrule_coupon.times_used,
 * salesrule_customer.times_used, and salesrule_coupon_usage rows) is
 * incremented asynchronously by the sales.rule.update.coupon.usage message
 * queue consumer instead of during order placement. If that consumer is not
 * running, lags under load, or the order crashes after the coupon is
 * applied but before the message is consumed, times_used never increments
 * even though the coupon was used on a real order, so uses_per_coupon and
 * uses_per_customer silently stop being enforced.
 *
 * This reports every discrepancy by default. It never cancels, refunds, or
 * holds an order. The only gated corrective action, behind DRY_RUN=false
 * and --apply, recomputes times_used to match the real order count. Run on
 * a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/coupon-usage-limit-not-enforced/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const APPLY = process.argv.includes("--apply");

/**
 * Pure decision function. No network or DB calls.
 * @param {{ruleId:number, usesPerCoupon:number|null, usesPerCustomer:number|null}} rule
 * @param {{couponId:number, code:string, reportedTimesUsed:number}} couponRecord
 * @param {Array<{orderId:string, incrementId:string, customerId:number|null, state:string}>} realOrders
 */
export function evaluateCouponUsage(rule, couponRecord, realOrders) {
  const active = realOrders.filter((o) => o.state !== "canceled");
  const realTotalCount = active.length;

  const perCustomerCounts = {};
  for (const o of active) {
    const key = o.customerId != null ? String(o.customerId) : "guest";
    perCustomerCounts[key] = (perCustomerCounts[key] || 0) + 1;
  }

  const { usesPerCoupon, usesPerCustomer } = rule;
  const reportedTimesUsed = couponRecord.reportedTimesUsed || 0;

  let reason = null;
  if (usesPerCoupon && realTotalCount > usesPerCoupon) {
    reason = "per_coupon_exceeded";
  } else if (usesPerCustomer && Object.values(perCustomerCounts).some((c) => c > usesPerCustomer)) {
    reason = "per_customer_exceeded";
  } else if (reportedTimesUsed < realTotalCount) {
    reason = "times_used_drift";
  }

  const offendingOrderIncrementIds =
    reason === "per_coupon_exceeded"
      ? active.slice(usesPerCoupon).map((o) => o.incrementId)
      : reason
      ? active.map((o) => o.incrementId)
      : [];

  return {
    isViolation: reason !== null,
    reason,
    realTotalCount,
    perCustomerCounts,
    offendingOrderIncrementIds,
  };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPutCouponTimesUsed(couponId, timesUsed) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/coupons`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entity: { coupon_id: couponId, times_used: timesUsed } }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function activeCouponRules(pageSize = 100) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "coupon_type",
    "searchCriteria[filterGroups][0][filters][0][value]": "2,3",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[filterGroups][1][filters][0][field]": "is_active",
    "searchCriteria[filterGroups][1][filters][0][value]": 1,
    "searchCriteria[pageSize]": pageSize,
  };
  const data = await magentoGet("/salesRules", params);
  return data.items;
}

async function couponsForRule(ruleId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "rule_id",
    "searchCriteria[filterGroups][0][filters][0][value]": ruleId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/coupons", params);
  return data.items;
}

async function* ordersForCoupon(code, pageSize = 100) {
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "coupon_code",
      "searchCriteria[filterGroups][0][filters][0][value]": code,
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": page,
    };
    const data = await magentoGet("/orders", params);
    const items = data.items || [];
    if (items.length === 0) return;
    for (const item of items) yield item;
    if (items.length < pageSize) return;
    page++;
  }
}

function toPlainRule(raw) {
  return {
    ruleId: raw.rule_id,
    usesPerCoupon: raw.uses_per_coupon || null,
    usesPerCustomer: raw.uses_per_customer || null,
  };
}

function toPlainCoupon(raw) {
  return {
    couponId: raw.coupon_id,
    code: raw.code,
    reportedTimesUsed: raw.times_used || 0,
  };
}

function toPlainOrder(item) {
  return {
    orderId: String(item.entity_id),
    incrementId: item.increment_id || "",
    customerId: item.customer_id ?? null,
    state: item.state || "",
  };
}

export async function run() {
  let flagged = 0;
  const rawRules = await activeCouponRules();

  for (const rawRule of rawRules) {
    const rule = toPlainRule(rawRule);
    const rawCoupons = await couponsForRule(rule.ruleId);

    for (const rawCoupon of rawCoupons) {
      const couponRecord = toPlainCoupon(rawCoupon);
      const realOrders = [];
      for await (const item of ordersForCoupon(couponRecord.code)) {
        realOrders.push(toPlainOrder(item));
      }

      const result = evaluateCouponUsage(rule, couponRecord, realOrders);
      if (!result.isViolation) continue;

      flagged++;
      console.warn(
        `Rule ${rule.ruleId} coupon ${couponRecord.couponId} (${couponRecord.code}): ` +
          `reason=${result.reason} real_count=${result.realTotalCount} reported_times_used=${couponRecord.reportedTimesUsed} ` +
          `uses_per_coupon=${rule.usesPerCoupon} uses_per_customer=${rule.usesPerCustomer} ` +
          `offending_orders=${JSON.stringify(result.offendingOrderIncrementIds)}`
      );

      if (!DRY_RUN && APPLY) {
        console.warn(
          `DRY_RUN is false and --apply is set: recomputing times_used for coupon ${couponRecord.code} ` +
            `from ${couponRecord.reportedTimesUsed} to ${result.realTotalCount}. Confirm ` +
            `sales.rule.update.coupon.usage is running so this does not drift again.`
        );
        await magentoPutCouponTimesUsed(couponRecord.couponId, result.realTotalCount);
      }
    }
  }

  console.log(`Done. ${flagged} coupon(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
