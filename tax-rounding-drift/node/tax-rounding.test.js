import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTaxDrift } from "./flag-tax-rounding-drift.js";

const line = (over = {}) => ({ unitPrice: 100.0, qty: 1, taxPercent: 10.0, discountAmount: 0.0, ...over });

test("unit base rounds per unit then sums", () => {
  const items = [line({ unitPrice: 333.33, qty: 3, taxPercent: 10.0 })];
  const result = decideTaxDrift(items, 0, 0, "UNIT_BASE_CALCULATION", 99.99);
  assert.equal(result.expectedTax, 99.99);
  assert.equal(result.isDrift, false);
});

test("row base rounds once per row can differ by a cent", () => {
  const items = [line({ unitPrice: 333.33, qty: 3, taxPercent: 10.0 })];
  const result = decideTaxDrift(items, 0, 0, "ROW_BASE_CALCULATION", 100.00);
  assert.equal(result.expectedTax, 100.00);
  assert.equal(result.isDrift, false);
});

test("row base flags real drift beyond tolerance", () => {
  const items = [line({ unitPrice: 333.33, qty: 3, taxPercent: 10.0 })];
  const result = decideTaxDrift(items, 0, 0, "ROW_BASE_CALCULATION", 95.00);
  assert.equal(result.isDrift, true);
  assert.equal(result.delta, 5.00);
});

test("total base single rate sums all rows first", () => {
  const items = [line({ unitPrice: 50.0, qty: 2, taxPercent: 8.0 }), line({ unitPrice: 25.0, qty: 1, taxPercent: 8.0 })];
  const result = decideTaxDrift(items, 0, 0, "TOTAL_BASE_CALCULATION", 10.00);
  assert.equal(result.expectedTax, 10.00);
  assert.equal(result.isDrift, false);
});

test("total base mixed rates is non comparable", () => {
  const items = [line({ unitPrice: 50.0, qty: 1, taxPercent: 8.0 }), line({ unitPrice: 50.0, qty: 1, taxPercent: 20.0 })];
  const result = decideTaxDrift(items, 0, 0, "TOTAL_BASE_CALCULATION", 999.0);
  assert.equal(result.nonComparable, true);
  assert.equal(result.isDrift, false);
});

test("shipping tax is added once rounded", () => {
  const items = [line({ unitPrice: 100.0, qty: 1, taxPercent: 10.0 })];
  const result = decideTaxDrift(items, 20.0, 10.0, "ROW_BASE_CALCULATION", 12.00);
  assert.equal(result.expectedTax, 12.00);
  assert.equal(result.isDrift, false);
});

test("discount reduces row total before tax on row base", () => {
  const items = [line({ unitPrice: 100.0, qty: 2, taxPercent: 10.0, discountAmount: 20.0 })];
  const result = decideTaxDrift(items, 0, 0, "ROW_BASE_CALCULATION", 18.00);
  assert.equal(result.expectedTax, 18.00);
  assert.equal(result.isDrift, false);
});

test("unknown algorithm throws", () => {
  const items = [line()];
  assert.throws(() => decideTaxDrift(items, 0, 0, "NOT_A_REAL_ALGORITHM", 0));
});
