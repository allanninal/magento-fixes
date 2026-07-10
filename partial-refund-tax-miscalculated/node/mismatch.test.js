import { test } from "node:test";
import assert from "node:assert/strict";
import { isCreditMemoTaxMismatched, expectedTaxForCreditMemo, buildAdjustmentPayload } from "./flag-creditmemo-tax-mismatch.js";

test("proportional tax match is not mismatched", () => {
  const result = isCreditMemoTaxMismatched(10.00, 5, 2, 4.00);
  assert.equal(result.expectedTax, 4.00);
  assert.equal(result.mismatched, false);
});

test("within epsilon is not mismatched", () => {
  const result = isCreditMemoTaxMismatched(10.00, 5, 2, 4.005);
  assert.equal(result.mismatched, false);
});

test("full order tax on partial refund is mismatched", () => {
  const result = isCreditMemoTaxMismatched(10.00, 5, 2, 10.00);
  assert.equal(result.expectedTax, 4.00);
  assert.equal(result.delta, 6.00);
  assert.equal(result.mismatched, true);
});

test("over refunded tax is mismatched with negative delta", () => {
  const result = isCreditMemoTaxMismatched(10.00, 5, 2, 1.00);
  assert.equal(result.delta, -3.00);
  assert.equal(result.mismatched, true);
});

test("zero qty ordered guarded to zero expected tax", () => {
  const result = isCreditMemoTaxMismatched(10.00, 0, 0, 0);
  assert.equal(result.expectedTax, 0);
  assert.equal(result.mismatched, false);
});

test("custom epsilon is respected", () => {
  const result = isCreditMemoTaxMismatched(10.00, 5, 2, 4.08, 0.1);
  assert.equal(result.mismatched, false);
});

test("expectedTaxForCreditMemo sums multiple lines", () => {
  const orderItemsById = {
    101: { tax_amount: 10.00, qty_ordered: 5 },
    102: { tax_amount: 6.00, qty_ordered: 3 },
  };
  const creditMemo = {
    items: [
      { order_item_id: 101, qty: 2 },
      { order_item_id: 102, qty: 1 },
    ],
  };
  const expected = expectedTaxForCreditMemo(orderItemsById, creditMemo);
  assert.equal(Math.round(expected * 10000) / 10000, Math.round((4.00 + 2.00) * 10000) / 10000);
});

test("expectedTaxForCreditMemo skips unknown order item", () => {
  const orderItemsById = { 101: { tax_amount: 10.00, qty_ordered: 5 } };
  const creditMemo = { items: [{ order_item_id: 999, qty: 1 }] };
  assert.equal(expectedTaxForCreditMemo(orderItemsById, creditMemo), 0);
});

test("buildAdjustmentPayload positive delta uses adjustment_negative", () => {
  const payload = buildAdjustmentPayload(6.00);
  assert.deepEqual(payload, { arguments: { adjustment_negative: 6.00 } });
});

test("buildAdjustmentPayload negative delta uses adjustment_positive", () => {
  const payload = buildAdjustmentPayload(-3.00);
  assert.deepEqual(payload, { arguments: { adjustment_positive: 3.00 } });
});
