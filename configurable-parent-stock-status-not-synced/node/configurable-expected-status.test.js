import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExpectedParentStockStatus } from "./configurable-stock-sync.js";

const child = (over = {}) => ({ sku: "CHILD-1", isInStock: true, salableQty: 5, ...over });

test("true when one child in stock and salable", () => {
  const children = [child({ isInStock: false, salableQty: 0 }), child()];
  assert.equal(computeExpectedParentStockStatus(children), true);
});

test("false when all children out of stock", () => {
  const children = [child({ isInStock: false, salableQty: 0 }), child({ isInStock: false, salableQty: 3 })];
  assert.equal(computeExpectedParentStockStatus(children), false);
});

test("false when children empty", () => {
  assert.equal(computeExpectedParentStockStatus([]), false);
});

test("false when in stock flag true but qty zero", () => {
  const children = [child({ isInStock: true, salableQty: 0 })];
  assert.equal(computeExpectedParentStockStatus(children), false);
});

test("false when qty positive but flag false", () => {
  const children = [child({ isInStock: false, salableQty: 10 })];
  assert.equal(computeExpectedParentStockStatus(children), false);
});

test("true with floating point qty edge case", () => {
  const children = [child({ isInStock: true, salableQty: 0.0001 })];
  assert.equal(computeExpectedParentStockStatus(children), true);
});

test("true when multiple children and only last is salable", () => {
  const children = [
    child({ isInStock: false, salableQty: 0 }),
    child({ isInStock: true, salableQty: 0 }),
    child({ isInStock: true, salableQty: 2 }),
  ];
  assert.equal(computeExpectedParentStockStatus(children), true);
});

test("false when salable qty negative", () => {
  const children = [child({ isInStock: true, salableQty: -1 })];
  assert.equal(computeExpectedParentStockStatus(children), false);
});

test("missing salableQty key defaults to zero", () => {
  const children = [{ sku: "CHILD-2", isInStock: true }];
  assert.equal(computeExpectedParentStockStatus(children), false);
});
