import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCategoryCountDiscrepancy } from "./category-count-check.js";

test("equal counts not flagged", () => {
  const result = decideCategoryCountDiscrepancy(42, 42, false);
  assert.deepEqual(result, { flagged: false, severity: "none", delta: 0 });
});

test("off by one is drift", () => {
  const result = decideCategoryCountDiscrepancy(41, 42, false);
  assert.equal(result.flagged, true);
  assert.equal(result.severity, "drift");
  assert.equal(result.delta, 1);
});

test("reported zero with real assignments is zeroed", () => {
  const result = decideCategoryCountDiscrepancy(0, 50, true);
  assert.equal(result.flagged, true);
  assert.equal(result.severity, "zeroed");
  assert.equal(result.delta, 50);
});

test("reported zero and actual zero not flagged", () => {
  const result = decideCategoryCountDiscrepancy(0, 0, true);
  assert.equal(result.flagged, false);
  assert.equal(result.severity, "none");
});

test("near miss within tolerance not flagged", () => {
  const result = decideCategoryCountDiscrepancy(100, 102, false, 5);
  assert.equal(result.flagged, false);
});

test("drift beyond tolerance is flagged", () => {
  const result = decideCategoryCountDiscrepancy(100, 108, false, 5);
  assert.equal(result.flagged, true);
  assert.equal(result.severity, "drift");
});

test("zeroed ignores tolerance", () => {
  const result = decideCategoryCountDiscrepancy(0, 3, true, 10);
  assert.equal(result.flagged, true);
  assert.equal(result.severity, "zeroed");
});

test("isAnchor does not change the flag boundary", () => {
  const anchor = decideCategoryCountDiscrepancy(10, 20, true);
  const leaf = decideCategoryCountDiscrepancy(10, 20, false);
  assert.equal(anchor.flagged, leaf.flagged);
  assert.equal(anchor.severity, leaf.severity);
});
