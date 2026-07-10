import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSalableQty } from "./flag-salable-qty-corruption.js";

test("exact match is consistent", () => {
  const result = reconcileSalableQty(100, 70, 30);
  assert.deepEqual(result, { isConsistent: true, expectedSalableQty: 70, delta: 0 });
});

test("within rounding tolerance is consistent", () => {
  const result = reconcileSalableQty(100, 70.00005, 30);
  assert.equal(result.isConsistent, true);
});

test("overcompensation positive delta is flagged", () => {
  const result = reconcileSalableQty(100, 85, 30);
  assert.equal(result.isConsistent, false);
  assert.equal(result.expectedSalableQty, 70);
  assert.equal(result.delta, 15);
});

test("lost reservation negative delta is flagged", () => {
  const result = reconcileSalableQty(100, 40, 30);
  assert.equal(result.isConsistent, false);
  assert.equal(result.expectedSalableQty, 70);
  assert.equal(result.delta, -30);
});

test("custom tolerance is respected", () => {
  const result = reconcileSalableQty(100, 70.01, 30, 0.02);
  assert.equal(result.isConsistent, true);
});

test("just over default tolerance is flagged", () => {
  const result = reconcileSalableQty(100, 70.001, 30);
  assert.equal(result.isConsistent, false);
});

test("zero open orders expected equals source", () => {
  const result = reconcileSalableQty(50, 50, 0);
  assert.deepEqual(result, { isConsistent: true, expectedSalableQty: 50, delta: 0 });
});
