import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReservedOrderGap } from "./reconcile-reserved-order-ids.js";

const quote = (over = {}) => ({
  reservedOrderId: "000000512",
  isActive: false,
  updatedAt: "2026-07-01T10:00:00Z",
  ...over,
});

test("consumed when matching order exists", () => {
  const result = classifyReservedOrderGap(quote(), [{ incrementId: "000000512" }]);
  assert.equal(result.status, "consumed");
});

test("orphaned gap when inactive and no match", () => {
  const result = classifyReservedOrderGap(quote(), []);
  assert.equal(result.status, "orphaned_gap");
});

test("pending checkout when still active and no match", () => {
  const result = classifyReservedOrderGap(quote({ isActive: true }), []);
  assert.equal(result.status, "pending_checkout");
});

test("consumed takes priority over active flag", () => {
  const result = classifyReservedOrderGap(quote({ isActive: true }), [{ incrementId: "000000512" }]);
  assert.equal(result.status, "consumed");
});

test("unrelated order match does not count as consumed", () => {
  const result = classifyReservedOrderGap(quote(), [{ incrementId: "000000999" }]);
  assert.equal(result.status, "orphaned_gap");
});

test("result carries the reserved order id", () => {
  const result = classifyReservedOrderGap(quote({ reservedOrderId: "000000777" }), []);
  assert.equal(result.reservedOrderId, "000000777");
});

test("empty matching orders list is handled", () => {
  const result = classifyReservedOrderGap(quote({ isActive: false }), []);
  assert.equal(result.status, "orphaned_gap");
});

test("multiple matching orders with one correct is consumed", () => {
  const result = classifyReservedOrderGap(quote(), [
    { incrementId: "000000001" },
    { incrementId: "000000512" },
  ]);
  assert.equal(result.status, "consumed");
});
