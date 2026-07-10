import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeSourceItemStatus } from "./repair-threshold-source-items.js";

test("in stock when quantity above positive threshold", () => {
  assert.equal(recomputeSourceItemStatus(10, 5, false), 1);
});

test("out of stock when quantity at positive threshold", () => {
  assert.equal(recomputeSourceItemStatus(5, 5, false), 0);
});

test("out of stock when quantity below positive threshold", () => {
  assert.equal(recomputeSourceItemStatus(2, 5, false), 0);
});

test("out of stock when quantity zero and threshold zero, no backorders", () => {
  assert.equal(recomputeSourceItemStatus(0, 0, false), 0);
});

test("in stock when zero threshold and backorders enabled", () => {
  assert.equal(recomputeSourceItemStatus(0, 0, true), 1);
});

test("in stock when negative threshold and backorders enabled", () => {
  assert.equal(recomputeSourceItemStatus(-3, -2, true), 1);
});

test("uses normal math when positive threshold even with backorders", () => {
  assert.equal(recomputeSourceItemStatus(10, 5, true), 1);
  assert.equal(recomputeSourceItemStatus(3, 5, true), 0);
});
