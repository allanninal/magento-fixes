import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPendingPaymentMismatch } from "./detect-pending-payment-mismatch.js";

const order = (over = {}) => ({
  entityId: "101",
  incrementId: "000000101",
  state: "pending_payment",
  status: "pending_payment",
  grandTotal: 150.0,
  totalPaid: 0.0,
  totalInvoiced: 0.0,
  ...over,
});

const invoice = (over = {}) => ({
  entityId: "501",
  orderId: "101",
  state: 2,
  grandTotal: 150.0,
  ...over,
});

test("mismatched when paid invoice exists", () => {
  const result = detectPendingPaymentMismatch(order(), [invoice()]);
  assert.equal(result.isMismatched, true);
  assert.equal(result.matchedInvoiceId, "501");
});

test("mismatched when totals already paid with no invoice", () => {
  const result = detectPendingPaymentMismatch(order({ totalPaid: 150.0 }), []);
  assert.equal(result.isMismatched, true);
  assert.equal(result.matchedInvoiceId, null);
});

test("mismatched when total invoiced meets grand total", () => {
  const result = detectPendingPaymentMismatch(order({ totalInvoiced: 150.0 }), []);
  assert.equal(result.isMismatched, true);
});

test("not mismatched when order already processing", () => {
  const result = detectPendingPaymentMismatch(order({ state: "processing" }), [invoice()]);
  assert.equal(result.isMismatched, false);
});

test("not mismatched when order state new but invoice open", () => {
  const result = detectPendingPaymentMismatch(order({ state: "new" }), [invoice({ state: 1 })]);
  assert.equal(result.isMismatched, false);
});

test("not mismatched when invoice open", () => {
  const result = detectPendingPaymentMismatch(order(), [invoice({ state: 1 })]);
  assert.equal(result.isMismatched, false);
});

test("not mismatched when invoice cancelled", () => {
  const result = detectPendingPaymentMismatch(order(), [invoice({ state: 3 })]);
  assert.equal(result.isMismatched, false);
});

test("not mismatched when invoice belongs to other order", () => {
  const result = detectPendingPaymentMismatch(order(), [invoice({ orderId: "999" })]);
  assert.equal(result.isMismatched, false);
});

test("not mismatched when nothing paid yet", () => {
  const result = detectPendingPaymentMismatch(order(), []);
  assert.equal(result.isMismatched, false);
});

test("reason mentions matched invoice id", () => {
  const result = detectPendingPaymentMismatch(order(), [invoice()]);
  assert.match(result.reason, /501/);
});
