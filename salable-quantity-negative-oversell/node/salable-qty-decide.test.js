import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSalableQtyAction } from "./flag-salable-qty-oversell.js";

const CONFIG_NO_BACKORDERS = { manageStock: true, backorders: 0 };
const CONFIG_BACKORDERS = { manageStock: true, backorders: 1 };

test("ok when consistent", () => {
  const result = decideSalableQtyAction("SKU-1", 5, 10, 5, CONFIG_NO_BACKORDERS);
  assert.equal(result.flag, false);
  assert.equal(result.severity, "ok");
});

test("warning when manage_stock disabled", () => {
  const config = { manageStock: false, backorders: 0 };
  const result = decideSalableQtyAction("SKU-1", 5, 10, 5, config);
  assert.equal(result.flag, true);
  assert.equal(result.severity, "warning");
});

test("critical when negative and backorders disabled", () => {
  const result = decideSalableQtyAction("SKU-1", -2, 10, 12, CONFIG_NO_BACKORDERS);
  assert.equal(result.flag, true);
  assert.equal(result.severity, "critical");
  assert.match(result.reason, /backorders disabled/);
});

test("ok when negative and backorders enabled matching demand", () => {
  const result = decideSalableQtyAction("SKU-1", -3, 10, 13, CONFIG_BACKORDERS);
  assert.equal(result.flag, false);
  assert.equal(result.severity, "ok");
});

test("critical when negative backorders enabled but exceeds demand", () => {
  const result = decideSalableQtyAction("SKU-1", -50, 10, 5, CONFIG_BACKORDERS);
  assert.equal(result.flag, true);
  assert.equal(result.severity, "critical");
  assert.match(result.reason, /phantom/);
});

test("warning when salable does not reconcile", () => {
  const result = decideSalableQtyAction("SKU-1", 8, 10, 5, CONFIG_NO_BACKORDERS);
  assert.equal(result.flag, true);
  assert.equal(result.severity, "warning");
  assert.match(result.reason, /does not reconcile/);
});

test("ok when reconciles within tolerance", () => {
  const result = decideSalableQtyAction("SKU-1", 5, 10, 5, CONFIG_NO_BACKORDERS, 0);
  assert.equal(result.flag, false);
});

test("manage_stock check takes priority over negative backorders", () => {
  const config = { manageStock: false, backorders: 0 };
  const result = decideSalableQtyAction("SKU-1", -100, 10, 5, config);
  assert.equal(result.severity, "warning");
  assert.match(result.reason, /manage_stock disabled/);
});

test("exactly at phantom reservation boundary is ok", () => {
  const result = decideSalableQtyAction("SKU-1", -15, 10, 5, CONFIG_BACKORDERS);
  assert.equal(result.flag, false);
  assert.equal(result.severity, "ok");
});
