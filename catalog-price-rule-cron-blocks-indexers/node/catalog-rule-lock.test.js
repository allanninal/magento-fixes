import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStuckCatalogRulePricing } from "./detect-stuck-catalog-rule.js";

const NOW = "2026-07-10T12:00:00Z";

const rule = (over = {}) => ({
  ruleId: 7,
  websiteIds: [1],
  discountAmount: 20,
  simpleAction: "by_percent",
  fromDate: null,
  toDate: null,
  ...over,
});

const price = (over = {}) => ({ sku: "SKU-1", storeId: 1, basePrice: 100.0, livePrice: 80.0, ...over });

const cronRow = (over = {}) => ({ jobCode: "catalogrule_apply_all", status: "error", scheduledAt: "2026-07-10T00:00:00Z", ...over });

test("stuck when mismatch and error cron", () => {
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 100.0 })], [cronRow()], NOW);
  assert.equal(result.stuck, true);
  assert.deepEqual(result.affectedSkus, ["SKU-1"]);
  assert.deepEqual(result.affectedRuleIds, [7]);
  assert.deepEqual(result.staleCronJobs, ["catalogrule_apply_all"]);
});

test("not stuck when price matches", () => {
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 80.0 })], [cronRow()], NOW);
  assert.equal(result.stuck, false);
  assert.deepEqual(result.affectedSkus, []);
});

test("not stuck when cron is healthy", () => {
  const healthy = cronRow({ status: "success" });
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 100.0 })], [healthy], NOW);
  assert.equal(result.stuck, false);
  assert.deepEqual(result.staleCronJobs, []);
});

test("running within lock timeout is not stale", () => {
  const row = cronRow({ status: "running", scheduledAt: "2026-07-10T11:50:00Z" });
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 100.0 })], [row], NOW, 15);
  assert.deepEqual(result.staleCronJobs, []);
  assert.equal(result.stuck, false);
});

test("running past lock timeout is stale", () => {
  const row = cronRow({ status: "running", scheduledAt: "2026-07-10T11:30:00Z" });
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 100.0 })], [row], NOW, 15);
  assert.deepEqual(result.staleCronJobs, ["catalogrule_apply_all"]);
  assert.equal(result.stuck, true);
});

test("rule not yet active is ignored", () => {
  const futureRule = rule({ fromDate: "2026-08-01T00:00:00Z" });
  const result = detectStuckCatalogRulePricing([futureRule], [price({ livePrice: 100.0 })], [cronRow()], NOW);
  assert.deepEqual(result.affectedSkus, []);
  assert.equal(result.stuck, false);
});

test("rule past end date is ignored", () => {
  const expiredRule = rule({ toDate: "2026-01-01T00:00:00Z" });
  const result = detectStuckCatalogRulePricing([expiredRule], [price({ livePrice: 100.0 })], [cronRow()], NOW);
  assert.deepEqual(result.affectedSkus, []);
  assert.equal(result.stuck, false);
});

test("by_fixed discount computes expected price", () => {
  const fixedRule = rule({ simpleAction: "by_fixed", discountAmount: 15 });
  const result = detectStuckCatalogRulePricing([fixedRule], [price({ livePrice: 100.0 })], [cronRow()], NOW);
  assert.deepEqual(result.affectedSkus, ["SKU-1"]);
});

test("unrelated job code is ignored", () => {
  const row = cronRow({ jobCode: "some_other_job", status: "error" });
  const result = detectStuckCatalogRulePricing([rule()], [price({ livePrice: 100.0 })], [row], NOW);
  assert.deepEqual(result.staleCronJobs, []);
  assert.equal(result.stuck, false);
});

test("store not targeted by rule is ignored", () => {
  const result = detectStuckCatalogRulePricing([rule()], [price({ storeId: 99, livePrice: 100.0 })], [cronRow()], NOW);
  assert.deepEqual(result.affectedSkus, []);
  assert.equal(result.stuck, false);
});
