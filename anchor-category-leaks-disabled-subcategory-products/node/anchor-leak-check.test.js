import { test } from "node:test";
import assert from "node:assert/strict";
import { findLeakedAnchorProducts } from "./anchor-leak-check.js";

function buildTree() {
  return {
    id: 10,
    isActive: true,
    isAnchor: true,
    children: [
      { id: 11, isActive: false, isAnchor: false, children: [] },
      { id: 12, isActive: true, isAnchor: false, children: [] },
    ],
  };
}

const productIndex = new Map([
  ["SKU-LEAK", { status: 1, visibility: 4 }],
  ["SKU-DISABLED-PRODUCT", { status: 2, visibility: 4 }],
  ["SKU-HIDDEN", { status: 1, visibility: 1 }],
]);

test("leaks an enabled, visible sku from a disabled child", () => {
  const assignments = new Map([[11, [{ sku: "SKU-LEAK" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.deepEqual(leaks, [{ anchorCategoryId: 10, disabledCategoryId: 11, sku: "SKU-LEAK" }]);
});

test("skips products from an active child", () => {
  const assignments = new Map([[12, [{ sku: "SKU-LEAK" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.deepEqual(leaks, []);
});

test("skips a disabled product even from a disabled child", () => {
  const assignments = new Map([[11, [{ sku: "SKU-DISABLED-PRODUCT" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.deepEqual(leaks, []);
});

test("skips a not visible individually product", () => {
  const assignments = new Map([[11, [{ sku: "SKU-HIDDEN" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.deepEqual(leaks, []);
});

test("skips a sku missing from the product index", () => {
  const assignments = new Map([[11, [{ sku: "SKU-UNKNOWN" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.deepEqual(leaks, []);
});

test("dedupes the same sku and anchor", () => {
  const assignments = new Map([[11, [{ sku: "SKU-LEAK" }, { sku: "SKU-LEAK" }]]]);
  const leaks = findLeakedAnchorProducts(buildTree(), productIndex, assignments);
  assert.equal(leaks.length, 1);
});

test("no leak when the root is not an anchor", () => {
  const tree = buildTree();
  tree.isAnchor = false;
  const assignments = new Map([[11, [{ sku: "SKU-LEAK" }]]]);
  const leaks = findLeakedAnchorProducts(tree, productIndex, assignments);
  assert.deepEqual(leaks, []);
});

test("a nested disabled grandchild attributes to the nearest anchor", () => {
  const tree = {
    id: 1,
    isActive: true,
    isAnchor: true,
    children: [
      {
        id: 2,
        isActive: true,
        isAnchor: false,
        children: [{ id: 3, isActive: false, isAnchor: false, children: [] }],
      },
    ],
  };
  const assignments = new Map([[3, [{ sku: "SKU-LEAK" }]]]);
  const leaks = findLeakedAnchorProducts(tree, productIndex, assignments);
  assert.deepEqual(leaks, [{ anchorCategoryId: 1, disabledCategoryId: 3, sku: "SKU-LEAK" }]);
});
