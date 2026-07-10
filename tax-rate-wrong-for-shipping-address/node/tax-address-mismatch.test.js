import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectedTaxRate,
  detectTaxMismatch,
  isDefaultAddressLeak,
} from "./detect-tax-address-mismatch.js";

const TAX_RATES = [
  { id: 1, tax_country_id: "BE", tax_region_id: 0, tax_postcode: "*", rate: 0.0 },
  { id: 2, tax_country_id: "FR", tax_region_id: 0, tax_postcode: "*", rate: 20.0 },
  { id: 3, tax_country_id: "US", tax_region_id: 12, tax_postcode: "90001-90099", rate: 8.25 },
];

const TAX_RULES = [
  { id: 1, priority: 0, customer_tax_class_ids: [3], product_tax_class_ids: [2], tax_rate_ids: [1, 2] },
  { id: 2, priority: 1, customer_tax_class_ids: [3], product_tax_class_ids: [2], tax_rate_ids: [3] },
];

test("French shipping address expects French VAT", () => {
  const france = { country_id: "FR", region_id: null, postcode: "75001" };
  const result = expectedTaxRate(france, 3, 2, TAX_RULES, TAX_RATES);
  assert.equal(result.expectedRate, 20.0);
  assert.equal(result.matchedRuleId, 1);
});

test("Belgium default address expects zero", () => {
  const belgium = { country_id: "BE", region_id: null, postcode: "1000" };
  const result = expectedTaxRate(belgium, 3, 2, TAX_RULES, TAX_RATES);
  assert.equal(result.expectedRate, 0.0);
});

test("issue 38232 style mismatch is detected", () => {
  const france = { country_id: "FR", region_id: null, postcode: "75001" };
  const expected = expectedTaxRate(france, 3, 2, TAX_RULES, TAX_RATES);
  const mismatch = detectTaxMismatch(0.0, expected);
  assert.equal(mismatch.isMismatch, true);
  assert.equal(mismatch.expectedRate, 20.0);
  assert.equal(mismatch.delta, 20.0);
});

test("matching rate is not a mismatch", () => {
  const france = { country_id: "FR", region_id: null, postcode: "75001" };
  const expected = expectedTaxRate(france, 3, 2, TAX_RULES, TAX_RATES);
  const mismatch = detectTaxMismatch(20.0, expected);
  assert.equal(mismatch.isMismatch, false);
});

test("within epsilon is not a mismatch", () => {
  const france = { country_id: "FR", region_id: null, postcode: "75001" };
  const expected = expectedTaxRate(france, 3, 2, TAX_RULES, TAX_RATES);
  const mismatch = detectTaxMismatch(19.98, expected, 0.05);
  assert.equal(mismatch.isMismatch, false);
});

test("US postcode range rate matches", () => {
  const address = { country_id: "US", region_id: 12, postcode: "90045" };
  const result = expectedTaxRate(address, 3, 2, TAX_RULES, TAX_RATES);
  assert.equal(result.expectedRate, 8.25);
  assert.equal(result.matchedRuleId, 2);
});

test("default address leak detected when shipping id differs", () => {
  assert.equal(isDefaultAddressLeak(42, 7, 7), true);
});

test("no leak when shipping matches default", () => {
  assert.equal(isDefaultAddressLeak(7, 7, 9), false);
});

test("no leak when no customer address id present", () => {
  assert.equal(isDefaultAddressLeak(null, 7, 9), false);
});
