import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOrderTax } from "./reconcile-coupon-tax.js";

function baseOrder(over = {}) {
  const order = {
    baseSubtotal: 100.0,
    baseDiscountAmount: 0.0,
    baseTaxAmount: 10.0,
    baseShippingAmount: 0.0,
    baseShippingTaxAmount: 0.0,
    baseShippingDiscountAmount: 0.0,
    baseGrandTotal: 110.0,
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 0.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 10.0,
    }],
    ...over,
  };
  return order;
}

test("no coupon order reconciles", () => {
  const result = reconcileOrderTax(baseOrder());
  assert.equal(result.ok, true);
  assert.equal(result.expectedTax, 10.0);
  assert.equal(result.taxDelta, 0.0);
});

test("percentage coupon with correct compensation reconciles", () => {
  const order = baseOrder({
    baseDiscountAmount: 20.0,
    baseTaxAmount: 8.0,
    baseGrandTotal: 88.0,
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 20.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 8.0,
    }],
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.ok, true);
  assert.equal(result.expectedTax, 8.0);
});

test("fixed amount coupon bug leaves tax on pre discount base", () => {
  const order = baseOrder({
    baseDiscountAmount: 10.0,
    baseTaxAmount: 10.0,
    baseGrandTotal: 100.0,
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 10.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 10.0,
    }],
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.ok, false);
  assert.equal(result.expectedTax, 9.0);
  assert.equal(result.taxDelta, 1.0);
});

test("tax inclusive price order with missing compensation is flagged", () => {
  const order = baseOrder({
    baseDiscountAmount: 15.0,
    baseTaxAmount: 10.0,
    baseGrandTotal: 95.0,
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 15.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 10.0,
    }],
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.ok, false);
  assert.equal(result.expectedTax, 8.5);
});

test("within epsilon is ok", () => {
  const order = baseOrder({ baseTaxAmount: 10.004, baseGrandTotal: 110.004 });
  const result = reconcileOrderTax(order, 0.01);
  assert.equal(result.ok, true);
});

test("per item deltas reported", () => {
  const order = baseOrder({
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 10.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 10.0,
    }],
    baseDiscountAmount: 10.0,
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.perItemDeltas[0].expectedItemTax, 9.0);
  assert.equal(result.perItemDeltas[0].delta, 1.0);
});

test("correctly compensated tax inclusive order reconciles", () => {
  const order = baseOrder({
    baseDiscountAmount: 10.0,
    baseTaxAmount: 9.0,
    baseGrandTotal: 99.0,
    items: [{
      baseRowTotal: 100.0,
      baseDiscountAmount: 10.0,
      baseDiscountTaxCompensationAmount: 0.0,
      taxPercent: 10.0,
      baseTaxAmount: 9.0,
    }],
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.ok, true);
  assert.equal(result.expectedTax, 9.0);
});

test("multiple items sum expected tax", () => {
  const order = baseOrder({
    baseSubtotal: 200.0,
    baseDiscountAmount: 20.0,
    baseTaxAmount: 18.0,
    baseGrandTotal: 198.0,
    items: [
      {
        baseRowTotal: 100.0,
        baseDiscountAmount: 10.0,
        baseDiscountTaxCompensationAmount: 0.0,
        taxPercent: 10.0,
        baseTaxAmount: 9.0,
      },
      {
        baseRowTotal: 100.0,
        baseDiscountAmount: 10.0,
        baseDiscountTaxCompensationAmount: 0.0,
        taxPercent: 10.0,
        baseTaxAmount: 9.0,
      },
    ],
  });
  const result = reconcileOrderTax(order);
  assert.equal(result.ok, true);
  assert.equal(result.expectedTax, 18.0);
});
