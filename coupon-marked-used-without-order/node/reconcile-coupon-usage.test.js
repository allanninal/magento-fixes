import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOrphanedCouponUsages } from "./reconcile-coupon-usage.js";

const coupon = (over = {}) => ({ couponId: 1, ruleId: 10, code: "SAVE10", timesUsed: 1, ...over });

test("no orphan when counts match", () => {
  const orders = new Map([["SAVE10", [{ entityId: 1, incrementId: "000000001", state: "complete" }]]]);
  assert.deepEqual(computeOrphanedCouponUsages([coupon()], orders), []);
});

test("orphan when times_used exceeds real orders", () => {
  const orders = new Map([["SAVE10", []]]);
  const result = computeOrphanedCouponUsages([coupon()], orders);
  assert.deepEqual(result, [{ couponId: 1, code: "SAVE10", timesUsed: 1, actualOrderCount: 0, orphanedCount: 1 }]);
});

test("cancelled orders are excluded from the actual count", () => {
  const orders = new Map([["SAVE10", [{ entityId: 1, incrementId: "000000001", state: "canceled" }]]]);
  const result = computeOrphanedCouponUsages([coupon()], orders);
  assert.equal(result[0].actualOrderCount, 0);
  assert.equal(result[0].orphanedCount, 1);
});

test("no orphan when multiple orders cover usage", () => {
  const orders = new Map([["SAVE10", [
    { entityId: 1, incrementId: "000000001", state: "complete" },
    { entityId: 2, incrementId: "000000002", state: "processing" },
  ]]]);
  const result = computeOrphanedCouponUsages([coupon({ timesUsed: 2 })], orders);
  assert.deepEqual(result, []);
});

test("missing coupon code in orders map counts as zero orders", () => {
  const result = computeOrphanedCouponUsages([coupon()], new Map());
  assert.equal(result[0].actualOrderCount, 0);
});

test("multiple coupons only flags the orphaned one", () => {
  const coupons = [coupon({ couponId: 1, code: "SAVE10", timesUsed: 1 }), coupon({ couponId: 2, code: "WELCOME20", timesUsed: 1 })];
  const orders = new Map([
    ["SAVE10", []],
    ["WELCOME20", [{ entityId: 5, incrementId: "000000005", state: "complete" }]],
  ]);
  const result = computeOrphanedCouponUsages(coupons, orders);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, "SAVE10");
});

test("custom excluded states are respected", () => {
  const orders = new Map([["SAVE10", [{ entityId: 1, incrementId: "000000001", state: "closed" }]]]);
  const result = computeOrphanedCouponUsages([coupon()], orders, ["closed"]);
  assert.equal(result[0].actualOrderCount, 0);
  assert.equal(result[0].orphanedCount, 1);
});
