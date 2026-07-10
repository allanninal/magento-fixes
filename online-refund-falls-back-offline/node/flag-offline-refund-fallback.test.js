import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRefundFallback } from "./flag-offline-refund-fallback.js";

const GATEWAY_METHODS = ["stripe_payments", "braintree", "authorizenet_acceptjs", "adyen_cc"];

const creditmemo = (over = {}) => ({
  entityId: 501,
  incrementId: "300000501",
  orderId: 900,
  paymentMethod: "stripe_payments",
  grandTotal: 49.99,
  ...over,
});

const txn = (txnType, parentId = null) => ({ txnType, parentId });

test("flags gateway method with no refund transaction", () => {
  const transactions = [txn("order"), txn("capture")];
  const result = evaluateRefundFallback(creditmemo(), transactions, GATEWAY_METHODS);
  assert.equal(result.isGatewayMethod, true);
  assert.equal(result.hasRefundTxn, false);
  assert.equal(result.fellBackOffline, true);
});

test("not flagged when refund transaction exists", () => {
  const transactions = [txn("order"), txn("capture"), txn("refund")];
  const result = evaluateRefundFallback(creditmemo(), transactions, GATEWAY_METHODS);
  assert.equal(result.fellBackOffline, false);
});

test("not flagged for offline payment method", () => {
  const cm = creditmemo({ paymentMethod: "checkmo" });
  const result = evaluateRefundFallback(cm, [], GATEWAY_METHODS);
  assert.equal(result.isGatewayMethod, false);
  assert.equal(result.fellBackOffline, false);
});

test("not flagged for unlisted custom method", () => {
  const cm = creditmemo({ paymentMethod: "some_custom_offline_method" });
  const result = evaluateRefundFallback(cm, [], GATEWAY_METHODS);
  assert.equal(result.fellBackOffline, false);
});

test("flags when transactions list is empty", () => {
  const result = evaluateRefundFallback(creditmemo(), [], GATEWAY_METHODS);
  assert.equal(result.fellBackOffline, true);
});

test("not flagged when only authorize and refund exist", () => {
  const transactions = [txn("authorization"), txn("refund")];
  const result = evaluateRefundFallback(creditmemo(), transactions, GATEWAY_METHODS);
  assert.equal(result.fellBackOffline, false);
});
