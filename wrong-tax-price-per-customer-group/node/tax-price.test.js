import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExpectedFinalPrice } from "./flag-tax-price-mismatch.js";

const RULES = [
  { customerTaxClassIds: [3], productTaxClassIds: [2], rateIds: [1] },
  { customerTaxClassIds: [10], productTaxClassIds: [2], rateIds: [2, 3] },
];
const RATES = { 1: 8.0, 2: 5.0, 3: 2.5 };

test("matched rule computes expected final", () => {
  const result = decideExpectedFinalPrice(100.0, 2, 3, RULES, RATES);
  assert.deepEqual(result, { expectedFinal: 108.0, matchedRuleFound: true, appliedRatePct: 8.0 });
});

test("no matching rule is orphaned", () => {
  const result = decideExpectedFinalPrice(100.0, 2, 999, RULES, RATES);
  assert.deepEqual(result, { expectedFinal: 100.0, matchedRuleFound: false, appliedRatePct: 0 });
});

test("multi rate stacking sums rates", () => {
  const result = decideExpectedFinalPrice(100.0, 2, 10, RULES, RATES);
  assert.equal(result.matchedRuleFound, true);
  assert.equal(result.appliedRatePct, 7.5);
  assert.equal(result.expectedFinal, 107.5);
});

test("price includes tax returns tier price unchanged", () => {
  const result = decideExpectedFinalPrice(100.0, 2, 3, RULES, RATES, true);
  assert.deepEqual(result, { expectedFinal: 100.0, matchedRuleFound: true, appliedRatePct: 8.0 });
});

test("rounds to two decimals", () => {
  const result = decideExpectedFinalPrice(19.99, 2, 3, RULES, RATES);
  assert.equal(result.expectedFinal, 21.59);
});

test("no rules at all is orphaned", () => {
  const result = decideExpectedFinalPrice(50.0, 2, 3, [], {});
  assert.deepEqual(result, { expectedFinal: 50.0, matchedRuleFound: false, appliedRatePct: 0 });
});

test("rule matches customer class but not product class", () => {
  const rules = [{ customerTaxClassIds: [3], productTaxClassIds: [99], rateIds: [1] }];
  const result = decideExpectedFinalPrice(100.0, 2, 3, rules, RATES);
  assert.equal(result.matchedRuleFound, false);
});
