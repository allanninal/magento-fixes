import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCreditmemoTotalDrift } from "./flag-creditmemo-total-drift.js";

const creditmemo = (over = {}) => ({
  subtotal: 100.0,
  discountAmount: 0.0,
  shippingAmount: 10.0,
  taxAmount: 8.0,
  adjustmentPositive: 0.0,
  adjustmentNegative: 0.0,
  grandTotal: 118.0,
  ...over,
});

test("matching totals are not drifted", () => {
  const result = evaluateCreditmemoTotalDrift(creditmemo());
  assert.equal(result.isDrifted, false);
  assert.equal(result.expectedGrandTotal, 118.0);
  assert.equal(result.delta, 0.0);
});

test("over refunded grand total is drifted", () => {
  const result = evaluateCreditmemoTotalDrift(creditmemo({ grandTotal: 140.0 }));
  assert.equal(result.isDrifted, true);
  assert.equal(result.delta, 22.0);
});

test("under refunded grand total is drifted", () => {
  const result = evaluateCreditmemoTotalDrift(creditmemo({ grandTotal: 100.0 }));
  assert.equal(result.isDrifted, true);
  assert.equal(result.delta, -18.0);
});

test("stale after adjustment fee typed but not recalculated", () => {
  const cm = creditmemo({ adjustmentNegative: 15.0, grandTotal: 118.0 });
  const result = evaluateCreditmemoTotalDrift(cm);
  assert.equal(result.isDrifted, true);
  assert.equal(result.expectedGrandTotal, 103.0);
  assert.equal(result.delta, 15.0);
});

test("zero shipping still matches when consistent", () => {
  const cm = creditmemo({ shippingAmount: 0.0, grandTotal: 108.0 });
  const result = evaluateCreditmemoTotalDrift(cm);
  assert.equal(result.isDrifted, false);
});

test("within epsilon is not drifted", () => {
  const result = evaluateCreditmemoTotalDrift(creditmemo({ grandTotal: 118.005 }), 0.01);
  assert.equal(result.isDrifted, false);
});

test("negative adjustment positive offsets correctly", () => {
  const cm = creditmemo({ adjustmentPositive: 5.0, grandTotal: 123.0 });
  const result = evaluateCreditmemoTotalDrift(cm);
  assert.equal(result.isDrifted, false);
});
