import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCouponUsage } from "./evaluate-coupon-usage.js";

const rule = (over = {}) => ({ ruleId: 12, usesPerCoupon: 1, usesPerCustomer: 1, ...over });
const coupon = (over = {}) => ({ couponId: 55, code: "SAVE10", reportedTimesUsed: 1, ...over });
const order = (over = {}) => ({
  orderId: "1",
  incrementId: "000000001",
  customerId: 7,
  state: "complete",
  ...over,
});

test("no violation when within limits and counter matches", () => {
  const result = evaluateCouponUsage(rule(), coupon(), [order()]);
  assert.equal(result.isViolation, false);
  assert.equal(result.realTotalCount, 1);
});

test("per_coupon_exceeded when real count over limit", () => {
  const orders = [
    order({ orderId: "1", incrementId: "000000001" }),
    order({ orderId: "2", incrementId: "000000002", customerId: 9 }),
  ];
  const result = evaluateCouponUsage(
    rule({ usesPerCoupon: 1, usesPerCustomer: null }),
    coupon({ reportedTimesUsed: 2 }),
    orders
  );
  assert.equal(result.isViolation, true);
  assert.equal(result.reason, "per_coupon_exceeded");
  assert.deepEqual(result.offendingOrderIncrementIds, ["000000002"]);
});

test("per_customer_exceeded when same customer reuses coupon", () => {
  const orders = [
    order({ orderId: "1", incrementId: "000000001" }),
    order({ orderId: "2", incrementId: "000000002" }),
  ];
  const result = evaluateCouponUsage(
    rule({ usesPerCoupon: null, usesPerCustomer: 1 }),
    coupon({ reportedTimesUsed: 2 }),
    orders
  );
  assert.equal(result.isViolation, true);
  assert.equal(result.reason, "per_customer_exceeded");
  assert.equal(result.perCustomerCounts["7"], 2);
});

test("times_used_drift when counter lags real orders", () => {
  const result = evaluateCouponUsage(
    rule({ usesPerCoupon: null, usesPerCustomer: null }),
    coupon({ reportedTimesUsed: 0 }),
    [order()]
  );
  assert.equal(result.isViolation, true);
  assert.equal(result.reason, "times_used_drift");
});

test("cancelled orders are excluded from the real count", () => {
  const orders = [order(), order({ orderId: "2", incrementId: "000000002", state: "canceled" })];
  const result = evaluateCouponUsage(rule({ usesPerCoupon: 1 }), coupon({ reportedTimesUsed: 1 }), orders);
  assert.equal(result.isViolation, false);
  assert.equal(result.realTotalCount, 1);
});

test("guest orders are grouped under guest key", () => {
  const orders = [order({ customerId: null })];
  const result = evaluateCouponUsage(
    rule({ usesPerCoupon: null, usesPerCustomer: null }),
    coupon({ reportedTimesUsed: 1 }),
    orders
  );
  assert.equal(result.perCustomerCounts.guest, 1);
});

test("no violation when counter reports higher than real", () => {
  const orders = [order()];
  const result = evaluateCouponUsage(
    rule({ usesPerCoupon: 5, usesPerCustomer: 5 }),
    coupon({ reportedTimesUsed: 3 }),
    orders
  );
  assert.equal(result.isViolation, false);
});
