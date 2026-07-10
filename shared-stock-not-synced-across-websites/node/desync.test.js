import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStockDesync } from "./detect-stock-desync.js";

const report = (over = {}) => ({ website_code: "base", stock_id: 1, salable_qty: 42, ...over });

test("in sync when stock ids and qty match", () => {
  const reports = [report(), report({ website_code: "eu_website" })];
  const result = detectStockDesync(reports, 1);
  assert.deepEqual(result, { inSync: true, driftedWebsites: [], qtyMismatches: [] });
});

test("flags drifted website with wrong stock id", () => {
  const reports = [report(), report({ website_code: "eu_website", stock_id: 2, salable_qty: 42 })];
  const result = detectStockDesync(reports, 1);
  assert.equal(result.inSync, false);
  assert.deepEqual(result.driftedWebsites, ["eu_website"]);
  assert.deepEqual(result.qtyMismatches, []);
});

test("flags qty mismatch when stock ids agree", () => {
  const reports = [report({ salable_qty: 42 }), report({ website_code: "eu_website", stock_id: 1, salable_qty: 10 })];
  const result = detectStockDesync(reports, 1);
  assert.equal(result.inSync, false);
  assert.deepEqual(result.driftedWebsites, []);
  assert.deepEqual(result.qtyMismatches, [{ website_code: "eu_website", salable_qty: 10 }]);
});

test("flags both drift and mismatch together", () => {
  const reports = [
    report({ salable_qty: 42 }),
    report({ website_code: "eu_website", stock_id: 1, salable_qty: 10 }),
    report({ website_code: "apac_website", stock_id: 3, salable_qty: 99 }),
  ];
  const result = detectStockDesync(reports, 1);
  assert.equal(result.inSync, false);
  assert.deepEqual(result.driftedWebsites, ["apac_website"]);
  assert.deepEqual(result.qtyMismatches, [{ website_code: "eu_website", salable_qty: 10 }]);
});

test("single website is trivially in sync", () => {
  const result = detectStockDesync([report()], 1);
  assert.equal(result.inSync, true);
});

test("empty reports is in sync", () => {
  const result = detectStockDesync([], 1);
  assert.deepEqual(result, { inSync: true, driftedWebsites: [], qtyMismatches: [] });
});
