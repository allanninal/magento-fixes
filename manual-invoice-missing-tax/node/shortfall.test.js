import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInvoiceTaxShortfall } from "./detect-invoice-tax-shortfall.js";

const order = (over = {}) => ({ baseGrandTotal: 110.00, baseTaxAmount: 10.00, totalDue: 0.00, ...over });

test("two invoices, second missing tax, is a shortfall", () => {
  const invoices = [
    { baseGrandTotal: 88.00, baseTaxAmount: 8.00 },
    { baseGrandTotal: 20.00, baseTaxAmount: 0.00 },
  ];
  const result = detectInvoiceTaxShortfall(order({ totalDue: 2.00 }), invoices);
  assert.equal(result.isShortfall, true);
  assert.equal(result.taxDelta, 2.00);
  assert.equal(result.grandTotalDelta, 2.00);
});

test("fully matched invoices is not a shortfall", () => {
  const invoices = [
    { baseGrandTotal: 88.00, baseTaxAmount: 8.00 },
    { baseGrandTotal: 22.00, baseTaxAmount: 2.00 },
  ];
  const result = detectInvoiceTaxShortfall(order({ totalDue: 0.00 }), invoices);
  assert.equal(result.isShortfall, false);
});

test("zero total due is not a shortfall even with a tax delta", () => {
  const invoices = [{ baseGrandTotal: 110.00, baseTaxAmount: 8.00 }];
  const result = detectInvoiceTaxShortfall(order({ totalDue: 0.00 }), invoices);
  assert.equal(result.isShortfall, false);
});

test("legitimately uninvoiced item is not a tax shortfall", () => {
  const invoices = [{ baseGrandTotal: 60.00, baseTaxAmount: 10.00 }];
  const result = detectInvoiceTaxShortfall(order({ totalDue: 50.00 }), invoices);
  assert.equal(result.taxDelta, 0.00);
  assert.equal(result.isShortfall, false);
});

test("within epsilon is not a shortfall", () => {
  const invoices = [{ baseGrandTotal: 109.995, baseTaxAmount: 9.995 }];
  const result = detectInvoiceTaxShortfall(order({ totalDue: 0.01 }), invoices, 0.01);
  assert.equal(result.isShortfall, false);
});

test("no invoices at all with due and tax is a shortfall", () => {
  const result = detectInvoiceTaxShortfall(order({ totalDue: 110.00 }), []);
  assert.equal(result.isShortfall, true);
  assert.equal(result.invoicedGrandTotal, 0);
  assert.equal(result.invoicedTax, 0);
});
