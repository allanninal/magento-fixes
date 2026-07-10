import { test } from "node:test";
import assert from "node:assert/strict";
import { isPhantomInStock } from "./flag-phantom-in-stock.js";

const stockItem = (over = {}) => ({ is_in_stock: true, manage_stock: true, ...over });

test("phantom when in stock, managed, zero qty, no backorders", () => {
  assert.equal(isPhantomInStock(stockItem(), 0, false), true);
});

test("phantom when salable qty negative", () => {
  assert.equal(isPhantomInStock(stockItem(), -2, false), true);
});

test("not phantom when salable qty positive", () => {
  assert.equal(isPhantomInStock(stockItem(), 5, false), false);
});

test("not phantom when already out of stock", () => {
  assert.equal(isPhantomInStock(stockItem({ is_in_stock: false }), 0, false), false);
});

test("not phantom when stock unmanaged", () => {
  assert.equal(isPhantomInStock(stockItem({ manage_stock: false }), 0, false), false);
});

test("not phantom when backorders allowed", () => {
  assert.equal(isPhantomInStock(stockItem(), 0, true), false);
});

test("not phantom when backorders allowed and negative qty", () => {
  assert.equal(isPhantomInStock(stockItem(), -5, true), false);
});

test("phantom at exactly zero boundary", () => {
  assert.equal(isPhantomInStock(stockItem(), 0, false), true);
});
