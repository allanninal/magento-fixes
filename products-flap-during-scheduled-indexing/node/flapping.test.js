import { test } from "node:test";
import assert from "node:assert/strict";
import { isProductFlapping, advanceMissingTracker } from "./flag-flapping-products.js";

const BASELINE = new Set(["sku-a", "sku-b", "sku-c"]);

test("no missing when everything present", () => {
  const result = isProductFlapping(BASELINE, BASELINE, BASELINE, new Map(), 1000, 60);
  assert.equal(result.flapping.size, 0);
  assert.equal(result.stuck.size, 0);
});

test("new miss is flapping not stuck", () => {
  const currentCategory = new Set([...BASELINE].filter((s) => s !== "sku-a"));
  const result = isProductFlapping(BASELINE, currentCategory, BASELINE, new Map(), 1000, 60);
  assert.deepEqual([...result.flapping], ["sku-a"]);
  assert.equal(result.stuck.size, 0);
});

test("recently missing stays flapping", () => {
  const previousMissing = new Map([["sku-a", 1000]]);
  const currentCategory = new Set([...BASELINE].filter((s) => s !== "sku-a"));
  const result = isProductFlapping(BASELINE, currentCategory, BASELINE, previousMissing, 1090, 60);
  assert.deepEqual([...result.flapping], ["sku-a"]);
  assert.equal(result.stuck.size, 0);
});

test("missing past three cycles is stuck", () => {
  const previousMissing = new Map([["sku-a", 1000]]);
  const currentCategory = new Set([...BASELINE].filter((s) => s !== "sku-a"));
  const result = isProductFlapping(BASELINE, currentCategory, BASELINE, previousMissing, 1000 + 181, 60);
  assert.deepEqual([...result.stuck], ["sku-a"]);
  assert.equal(result.flapping.size, 0);
});

test("missing from search is tracked separately", () => {
  const currentSearch = new Set([...BASELINE].filter((s) => s !== "sku-b"));
  const result = isProductFlapping(BASELINE, BASELINE, currentSearch, new Map(), 1000, 60);
  assert.deepEqual([...result.missingFromSearch], ["sku-b"]);
  assert.equal(result.missingFromCategory.size, 0);
});

test("missing from both category and search still classifies as flapping", () => {
  const currentCategory = new Set([...BASELINE].filter((s) => s !== "sku-a"));
  const currentSearch = new Set([...BASELINE].filter((s) => s !== "sku-a"));
  const result = isProductFlapping(BASELINE, currentCategory, currentSearch, new Map(), 1000, 60);
  assert.deepEqual([...result.missingFromCategory], ["sku-a"]);
  assert.deepEqual([...result.missingFromSearch], ["sku-a"]);
  assert.deepEqual([...result.flapping], ["sku-a"]);
});

test("advanceMissingTracker keeps first seen timestamp", () => {
  const previousMissing = new Map([["sku-a", 500]]);
  const updated = advanceMissingTracker(previousMissing, new Set(["sku-a", "sku-b"]), 900);
  assert.equal(updated.get("sku-a"), 500);
  assert.equal(updated.get("sku-b"), 900);
});

test("advanceMissingTracker drops recovered skus", () => {
  const previousMissing = new Map([["sku-a", 500], ["sku-b", 600]]);
  const updated = advanceMissingTracker(previousMissing, new Set(["sku-a"]), 900);
  assert.equal(updated.has("sku-b"), false);
});

test("advanceMissingTracker is empty when nothing missing", () => {
  const previousMissing = new Map([["sku-a", 500]]);
  const updated = advanceMissingTracker(previousMissing, new Set(), 900);
  assert.equal(updated.size, 0);
});
