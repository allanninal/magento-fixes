import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRulePriceMismatch } from "./detect-rule-price-mismatch.js";

const tier = (over = {}) => ({ customerGroupId: 3, price: 80.0, priceType: "fixed", qty: 1, ...over });

test("no mismatch when tier price correctly discounted", () => {
  const result = evaluateRulePriceMismatch(100.0, [tier()], 3, 10, 72.0);
  assert.equal(result.isMismatch, false);
  assert.equal(result.mismatchType, null);
  assert.equal(Math.round(result.expectedPrice * 100) / 100, 72.0);
});

test("base price used instead of tier price", () => {
  const result = evaluateRulePriceMismatch(100.0, [tier()], 3, 10, 90.0);
  assert.equal(result.isMismatch, true);
  assert.equal(result.mismatchType, "base_price_used");
});

test("scope leak to other customer group", () => {
  const rows = [tier({ customerGroupId: 3, price: 80.0 }), tier({ customerGroupId: 4, price: 60.0 })];
  const actual = 60.0 * (1 - 10 / 100); // 54.0, discount leaked onto group 4's price
  const result = evaluateRulePriceMismatch(100.0, rows, 3, 10, actual);
  assert.equal(result.isMismatch, true);
  assert.equal(result.mismatchType, "scope_leak");
});

test("falls back to ALL GROUPS row when no group specific row", () => {
  const rows = [tier({ customerGroupId: 32000, price: 90.0 })];
  const result = evaluateRulePriceMismatch(100.0, rows, 3, 10, 81.0);
  assert.equal(result.isMismatch, false);
  assert.equal(Math.round(result.expectedPrice * 100) / 100, 81.0);
});

test("falls back to base price when no tier rows at all", () => {
  const result = evaluateRulePriceMismatch(100.0, [], 3, 10, 90.0);
  assert.equal(result.isMismatch, false);
  assert.equal(Math.round(result.expectedPrice * 100) / 100, 90.0);
});

test("discount type tier price is applied to base", () => {
  const rows = [tier({ customerGroupId: 3, price: 15.0, priceType: "discount" })];
  const result = evaluateRulePriceMismatch(100.0, rows, 3, 10, 76.5);
  assert.equal(result.isMismatch, false);
  assert.equal(Math.round(result.expectedPrice * 100) / 100, 76.5);
});

test("within tolerance is not a mismatch", () => {
  const result = evaluateRulePriceMismatch(100.0, [tier()], 3, 10, 72.005);
  assert.equal(result.isMismatch, false);
});

test("qty greater than one rows are ignored for qty1 lookup", () => {
  const rows = [tier({ qty: 5, price: 50.0 }), tier({ qty: 1, price: 80.0 })];
  const result = evaluateRulePriceMismatch(100.0, rows, 3, 10, 72.0);
  assert.equal(result.isMismatch, false);
  assert.equal(Math.round(result.expectedPrice * 100) / 100, 72.0);
});
