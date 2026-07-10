import { test } from "node:test";
import assert from "node:assert/strict";
import { isUrlRewriteMissing } from "./url-rewrite-missing.js";

const product = (over = {}) => ({ sku: "GREEN-SHIRT", urlKey: "green-shirt", storeIds: [1], ...over });

test("no gap when expected path already known", () => {
  const existing = new Map([[1, new Set(["green-shirt.html"])]]);
  assert.deepEqual(isUrlRewriteMissing(product(), ".html", existing), []);
});

test("flags missing when store has no matching path", () => {
  const existing = new Map([[1, new Set()]]);
  assert.deepEqual(isUrlRewriteMissing(product(), ".html", existing), [
    { sku: "GREEN-SHIRT", storeId: 1, expectedPath: "green-shirt.html" },
  ]);
});

test("flags missing when store id absent from map", () => {
  const existing = new Map();
  assert.deepEqual(isUrlRewriteMissing(product(), ".html", existing), [
    { sku: "GREEN-SHIRT", storeId: 1, expectedPath: "green-shirt.html" },
  ]);
});

test("checks every store the product belongs to", () => {
  const p = product({ storeIds: [1, 2] });
  const existing = new Map([[1, new Set(["green-shirt.html"])], [2, new Set()]]);
  assert.deepEqual(isUrlRewriteMissing(p, ".html", existing), [
    { sku: "GREEN-SHIRT", storeId: 2, expectedPath: "green-shirt.html" },
  ]);
});

test("no stores means no gaps", () => {
  const p = product({ storeIds: [] });
  assert.deepEqual(isUrlRewriteMissing(p, ".html", new Map()), []);
});

test("respects a custom suffix", () => {
  const existing = new Map([[1, new Set(["green-shirt.htm"])]]);
  assert.deepEqual(isUrlRewriteMissing(product(), ".htm", existing), []);
});

test("wrong suffix in existing paths is still a gap", () => {
  const existing = new Map([[1, new Set(["green-shirt.htm"])]]);
  assert.deepEqual(isUrlRewriteMissing(product(), ".html", existing), [
    { sku: "GREEN-SHIRT", storeId: 1, expectedPath: "green-shirt.html" },
  ]);
});

test("multiple stores all missing reports each", () => {
  const p = product({ storeIds: [1, 2, 3] });
  const existing = new Map([[1, new Set()], [2, new Set()], [3, new Set()]]);
  assert.deepEqual(isUrlRewriteMissing(p, ".html", existing), [
    { sku: "GREEN-SHIRT", storeId: 1, expectedPath: "green-shirt.html" },
    { sku: "GREEN-SHIRT", storeId: 2, expectedPath: "green-shirt.html" },
    { sku: "GREEN-SHIRT", storeId: 3, expectedPath: "green-shirt.html" },
  ]);
});
