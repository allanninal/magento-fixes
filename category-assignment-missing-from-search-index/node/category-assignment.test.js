import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingCategoryAssignments } from "./find-missing-category-assignments.js";

test("reports assigned sku missing from index", () => {
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], [], {}), ["SKU-1"]);
});

test("ignores sku present in index", () => {
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], ["SKU-1"], {}), []);
});

test("excludes disabled product", () => {
  const status = { "SKU-1": { status: 2, visibility: 4 } };
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], [], status), []);
});

test("excludes not visible individually", () => {
  const status = { "SKU-1": { status: 1, visibility: 1 } };
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], [], status), []);
});

test("keeps enabled and visible product missing from index", () => {
  const status = { "SKU-1": { status: 1, visibility: 4 } };
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], [], status), ["SKU-1"]);
});

test("handles multiple skus with mixed outcomes", () => {
  const assigned = ["SKU-1", "SKU-2", "SKU-3"];
  const indexed = ["SKU-2"];
  const status = { "SKU-1": { status: 1, visibility: 4 }, "SKU-3": { status: 2, visibility: 4 } };
  assert.deepEqual(findMissingCategoryAssignments(assigned, indexed, status), ["SKU-1"]);
});

test("empty assigned list returns empty", () => {
  assert.deepEqual(findMissingCategoryAssignments([], ["SKU-9"], {}), []);
});

test("missing status entry defaults to reported", () => {
  assert.deepEqual(findMissingCategoryAssignments(["SKU-1"], [], {}), ["SKU-1"]);
});
