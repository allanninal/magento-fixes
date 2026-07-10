import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedOrderStatus } from "./flag-status-after-refund.js";

const totals = (over = {}) => ({ totalInvoiced: 100.0, totalPaid: 100.0, totalRefunded: 0.0, ...over });

test("nothing invoiced yet is never a mismatch", () => {
  const result = expectedOrderStatus(totals({ totalInvoiced: 0, totalPaid: 0 }), [], "pending");
  assert.equal(result.isMismatch, false);
  assert.equal(result.expected, "pending");
});

test("fully refunded but still processing is a mismatch", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 100.0 }), [{ grandTotal: 100.0 }], "processing");
  assert.equal(result.expected, "closed");
  assert.equal(result.isMismatch, true);
});

test("zero total memo covering full balance is treated as fully refunded", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 100.0 }), [{ grandTotal: 0.0 }], "complete");
  assert.equal(result.expected, "closed");
  assert.equal(result.isMismatch, true);
});

test("partial refund never forces closed on its own", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 40.0 }), [{ grandTotal: 40.0 }], "closed");
  assert.equal(result.expected, "processing");
  assert.equal(result.isMismatch, true);
});

test("partial refund leaves processing alone", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 40.0 }), [{ grandTotal: 40.0 }], "processing");
  assert.equal(result.expected, "processing");
  assert.equal(result.isMismatch, false);
});

test("already closed and fully refunded is not a mismatch", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 100.0 }), [{ grandTotal: 100.0 }], "closed");
  assert.equal(result.isMismatch, false);
});

test("no refund at all is not a mismatch", () => {
  const result = expectedOrderStatus(totals(), [], "processing");
  assert.equal(result.isMismatch, false);
});

test("partial bundle item memo below full balance is not fully refunded", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 25.0 }), [{ grandTotal: 25.0 }], "processing");
  assert.equal(result.expected, "processing");
  assert.equal(result.isMismatch, false);
});

test("epsilon tolerates tiny float rounding as fully refunded", () => {
  const result = expectedOrderStatus(totals({ totalRefunded: 99.995 }), [{ grandTotal: 99.995 }], "processing");
  assert.equal(result.expected, "closed");
  assert.equal(result.isMismatch, true);
});
