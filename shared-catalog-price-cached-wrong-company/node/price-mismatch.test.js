import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePriceMismatch } from "./flag-shared-catalog-price-mismatch.js";

const expected = (over = {}) => ({ sku: "widget-01", customerGroupId: 5, sharedCatalogId: 2, expectedPrice: 80.00, ...over });
const observed = (over = {}) => ({ sku: "widget-01", customerGroupId: 5, renderedPrice: 80.00, cacheAgeSeconds: 30, ...over });

test("ok when price matches within tolerance", () => {
  const result = decidePriceMismatch(expected(), observed({ renderedPrice: 80.004 }));
  assert.equal(result.isMismatch, false);
  assert.equal(result.severity, "ok");
});

test("wrong company when price matches another group's expected price", () => {
  // We expected group 5 (Company A) to see 80.00. Instead, the request
  // observed as group 7 rendered 45.00, which is exactly Company C's
  // (group 9) shared catalog price -- i.e. the price got crossed with a
  // third company's cached entry.
  const otherPrices = { 9: 45.00 };
  const result = decidePriceMismatch(
    expected({ customerGroupId: 5, expectedPrice: 80.00 }),
    observed({ customerGroupId: 7, renderedPrice: 45.00 }),
    otherPrices,
  );
  assert.equal(result.isMismatch, true);
  assert.equal(result.severity, "wrong_company");
});

test("wrong group when stale and matches no known group", () => {
  const result = decidePriceMismatch(expected(), observed({ renderedPrice: 99.99 }), { 7: 65.00 });
  assert.equal(result.isMismatch, true);
  assert.equal(result.severity, "wrong_group");
});

test("wrong group when same group but price disagrees", () => {
  const result = decidePriceMismatch(expected(), observed({ customerGroupId: 5, renderedPrice: 75.00 }));
  assert.equal(result.isMismatch, true);
  assert.equal(result.severity, "wrong_group");
});

test("ok ignores penny rounding", () => {
  const result = decidePriceMismatch(expected({ expectedPrice: 19.99 }), observed({ renderedPrice: 19.995 }));
  assert.equal(result.severity, "ok");
});

test("wrong_company only triggers when observed group differs from expected group", () => {
  const otherPrices = { 7: 75.00 };
  const result = decidePriceMismatch(expected({ customerGroupId: 5 }), observed({ customerGroupId: 5, renderedPrice: 75.00 }), otherPrices);
  assert.equal(result.severity, "wrong_group");
});

test("no mismatch includes a reason", () => {
  const result = decidePriceMismatch(expected(), observed());
  assert.equal(result.isMismatch, false);
  assert.ok(result.reason.length > 0);
});
