import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCreditMemoDiscrepancy } from "./flag-creditmemo-discrepancy.js";

const invoice = (over = {}) => ({
  entityId: 900,
  baseGrandTotal: 220.00,
  baseTaxAmount: 20.00,
  items: [
    { itemId: 1, qtyInvoiced: 2.0, baseTaxAmount: 20.00, baseRowTotal: 200.00 },
  ],
  ...over,
});

const creditMemo = (over = {}) => ({
  entityId: 700,
  incrementId: "100000700",
  invoiceId: 900,
  baseGrandTotal: 110.00,
  baseTaxAmount: 10.00,
  baseShippingAmount: 0,
  adjustmentPositive: 0,
  adjustmentNegative: 0,
  items: [
    { itemId: 1, qtyRefunded: 1.0, baseRowTotal: 100.00, baseTaxAmount: 10.00 },
  ],
  ...over,
});

test("matched credit memo is ok", () => {
  const result = decideCreditMemoDiscrepancy(creditMemo(), invoice(), []);
  assert.equal(result.reason, "ok");
  assert.equal(result.isDiscrepant, false);
});

test("tax mismatch is flagged", () => {
  const cm = creditMemo({ baseTaxAmount: 20.00, baseGrandTotal: 120.00 });
  const result = decideCreditMemoDiscrepancy(cm, invoice(), []);
  assert.equal(result.reason, "tax_mismatch");
  assert.equal(result.isDiscrepant, true);
  assert.equal(result.expectedTaxAmount, 10.00);
});

test("grand total mismatch is flagged", () => {
  const cm = creditMemo({ baseShippingAmount: 15.00, baseGrandTotal: 110.00 });
  const result = decideCreditMemoDiscrepancy(cm, invoice(), []);
  assert.equal(result.reason, "grand_total_mismatch");
  assert.equal(result.isDiscrepant, true);
});

test("over refund beats other reasons", () => {
  const prior = [{ baseGrandTotal: 150.00 }];
  const cm = creditMemo({ baseGrandTotal: 110.00 });
  const result = decideCreditMemoDiscrepancy(cm, invoice(), prior);
  assert.equal(result.reason, "over_refund");
  assert.equal(result.isDiscrepant, true);
});

test("within tolerance is ok", () => {
  const cm = creditMemo({ baseGrandTotal: 110.004 });
  const result = decideCreditMemoDiscrepancy(cm, invoice(), [], 0.01);
  assert.equal(result.reason, "ok");
});

test("expected totals prorate by refunded qty", () => {
  const inv = invoice({
    items: [{ itemId: 1, qtyInvoiced: 4.0, baseTaxAmount: 40.00, baseRowTotal: 400.00 }],
  });
  const cm = creditMemo({
    items: [{ itemId: 1, qtyRefunded: 1.0, baseRowTotal: 100.00, baseTaxAmount: 10.00 }],
    baseGrandTotal: 110.00,
    baseTaxAmount: 10.00,
  });
  const result = decideCreditMemoDiscrepancy(cm, inv, []);
  assert.equal(result.expectedTaxAmount, 10.00);
  assert.equal(result.expectedGrandTotal, 110.00);
  assert.equal(result.reason, "ok");
});

test("missing invoice item falls back to credit memo row total", () => {
  const inv = invoice({ items: [] });
  const cm = creditMemo({
    items: [{ itemId: 99, qtyRefunded: 1.0, baseRowTotal: 50.00, baseTaxAmount: 0 }],
    baseGrandTotal: 50.00,
    baseTaxAmount: 0,
  });
  const result = decideCreditMemoDiscrepancy(cm, inv, []);
  assert.equal(result.expectedTaxAmount, 0);
  assert.equal(result.expectedGrandTotal, 50.00);
  assert.equal(result.reason, "ok");
});

test("exactly at tolerance boundary is ok", () => {
  const cm = creditMemo({ baseGrandTotal: 110.01 });
  const result = decideCreditMemoDiscrepancy(cm, invoice(), [], 0.01);
  assert.equal(result.reason, "ok");
});
