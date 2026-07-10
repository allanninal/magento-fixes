import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStuckOrderAction } from "./reconcile-payment-review.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const order = (over = {}) => ({
  state: "payment_review",
  status: "payment_review",
  createdAt: "2026-07-07 00:00:00", // 72 hours before NOW
  totalInvoiced: 0,
  statusHistories: [],
  ...over,
});

test("cancel when stuck past threshold with no invoice", () => {
  assert.deepEqual(decideStuckOrderAction(order(), NOW, 48), {
    action: "cancel",
    reason: "no_gateway_callback_within_threshold",
  });
});

test("skip when not payment_review", () => {
  const result = decideStuckOrderAction(order({ state: "processing" }), NOW, 48);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "not_in_payment_review");
});

test("skip when below age threshold", () => {
  const result = decideStuckOrderAction(
    order({ createdAt: "2026-07-09 12:00:00" }), // 12 hours before NOW
    NOW,
    48
  );
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "below_age_threshold");
});

test("skip when status history progressed after created", () => {
  const result = decideStuckOrderAction(
    order({ statusHistories: [{ createdAt: "2026-07-08 00:00:00" }] }),
    NOW,
    48
  );
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "gateway_callback_already_progressed");
});

test("does not skip when status history equals created at", () => {
  const result = decideStuckOrderAction(
    order({ statusHistories: [{ createdAt: "2026-07-07 00:00:00" }] }),
    NOW,
    48
  );
  assert.equal(result.action, "cancel");
});

test("flag when payment captured", () => {
  assert.deepEqual(decideStuckOrderAction(order({ totalInvoiced: 99.99 }), NOW, 48), {
    action: "flag",
    reason: "payment_captured_needs_manual_review",
  });
});

test("skip when missing created at", () => {
  const result = decideStuckOrderAction(order({ createdAt: null }), NOW, 48);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "missing_created_at");
});

test("exactly at threshold is stuck", () => {
  const result = decideStuckOrderAction(
    order({ createdAt: "2026-07-08 00:00:00" }), // exactly 48 hours before NOW
    NOW,
    48
  );
  assert.equal(result.action, "cancel");
});
