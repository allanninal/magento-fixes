import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseStockMismatch } from "./diagnose-stock-mismatch.js";

test("consistent when grid in stock and salable positive", () => {
  const result = diagnoseStockMismatch("SKU1", true, 10, 5);
  assert.equal(result.mismatched, false);
  assert.equal(result.severity, "none");
});

test("consistent when grid out of stock and salable zero", () => {
  const result = diagnoseStockMismatch("SKU2", false, 0, 0);
  assert.equal(result.mismatched, false);
  assert.equal(result.severity, "none");
});

test("critical when grid in stock positive qty but salable zero", () => {
  const result = diagnoseStockMismatch("SKU3", true, 8, 0);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "critical");
});

test("stale index when grid in stock zero qty and salable zero", () => {
  const result = diagnoseStockMismatch("SKU4", true, 0, 0);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "stale_index");
});

test("stale index when grid out of stock after restock", () => {
  const result = diagnoseStockMismatch("SKU5", false, 0, 12);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "stale_index");
});

test("negative salable quantity is still a mismatch", () => {
  const result = diagnoseStockMismatch("SKU6", true, 3, -2);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "critical");
});

test("respects custom min qty threshold", () => {
  const result = diagnoseStockMismatch("SKU7", true, 5, 2, 3);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "critical");
});

test("exactly at threshold counts as out of stock side", () => {
  const result = diagnoseStockMismatch("SKU8", true, 4, 0, 0);
  assert.equal(result.mismatched, true);
  assert.equal(result.severity, "critical");
});
