import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReindexAnomaly } from "./reindex-anomaly.js";

const PROCESSING = { code: "catalog_product_price", status: "processing" };
const INVALID = { code: "catalog_product_price", status: "invalid" };
const VALID = { code: "catalog_product_price", status: "valid" };

test("transient gap when missing returns and indexer processing", () => {
  const before = ["sku-1", "sku-2", "sku-3"];
  const during = ["sku-1", "sku-3"];
  const after = ["sku-1", "sku-2", "sku-3"];
  const result = decideReindexAnomaly(before, during, after, PROCESSING);
  assert.equal(result.isTransientDropDetected, true);
  assert.deepEqual(result.missingDuringWindow, ["sku-2"]);
  assert.equal(result.recommendation, "flag_transient_index_gap");
});

test("permanent loss when sku never returns", () => {
  const before = ["sku-1", "sku-2"];
  const during = ["sku-1"];
  const after = ["sku-1"];
  const result = decideReindexAnomaly(before, during, after, PROCESSING);
  assert.equal(result.isTransientDropDetected, false);
  assert.deepEqual(result.missingDuringWindow, ["sku-2"]);
  assert.equal(result.recommendation, "flag_permanent_loss");
});

test("permanent loss even if indexer says valid", () => {
  const before = ["sku-1", "sku-2"];
  const during = ["sku-1"];
  const after = ["sku-1"];
  const result = decideReindexAnomaly(before, during, after, VALID);
  assert.equal(result.recommendation, "flag_permanent_loss");
});

test("ok when nothing missing and counts match", () => {
  const before = ["sku-1", "sku-2"];
  const result = decideReindexAnomaly(before, before, before, VALID);
  assert.equal(result.recommendation, "ok");
  assert.equal(result.falsePositive, false);
});

test("false positive when nothing missing but counts differ", () => {
  const before = ["sku-1", "sku-2"];
  const after = ["sku-1", "sku-2", "sku-3"];
  const result = decideReindexAnomaly(before, before, after, VALID);
  assert.equal(result.recommendation, "ok");
  assert.equal(result.falsePositive, true);
});

test("transient gap detected when indexer status invalid", () => {
  const before = ["sku-1", "sku-2"];
  const during = ["sku-1"];
  const after = ["sku-1", "sku-2"];
  const result = decideReindexAnomaly(before, during, after, INVALID);
  assert.equal(result.recommendation, "flag_transient_index_gap");
});

test("missing set computed from before minus during only", () => {
  const before = ["sku-1"];
  const during = ["sku-1", "sku-2"];
  const after = ["sku-1", "sku-2"];
  const result = decideReindexAnomaly(before, during, after, PROCESSING);
  assert.deepEqual(result.missingDuringWindow, []);
  assert.equal(result.recommendation, "ok");
});
