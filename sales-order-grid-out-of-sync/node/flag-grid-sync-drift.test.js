import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderSync } from "./flag-grid-sync-drift.js";

const WATERMARK = "2026-07-10 00:00:00";

const entity = (over = {}) => ({
  entityId: 501,
  incrementId: "100000501",
  status: "processing",
  updatedAt: "2026-07-09 12:00:00",
  grandTotal: 129.99,
  ...over,
});

const grid = (over = {}) => ({
  entityId: 501,
  incrementId: "100000501",
  status: "processing",
  updatedAt: "2026-07-09 12:00:00",
  grandTotal: 129.99,
  ...over,
});

test("missing and due is flagged", () => {
  const result = classifyOrderSync(entity(), null, WATERMARK);
  assert.equal(result.driftType, "MISSING_FROM_GRID");
  assert.equal(result.action, "FLAG_REINDEX");
});

test("missing but not due is ok", () => {
  const result = classifyOrderSync(entity({ updatedAt: "2026-07-10 08:00:00" }), null, WATERMARK);
  assert.equal(result.driftType, "OK");
  assert.equal(result.action, "NONE");
});

test("status drift is flagged", () => {
  const result = classifyOrderSync(entity(), grid({ status: "pending" }), WATERMARK);
  assert.equal(result.driftType, "STALE_STATUS");
  assert.equal(result.action, "FLAG_REINDEX");
});

test("total drift is flagged", () => {
  const result = classifyOrderSync(entity(), grid({ grandTotal: 89.99 }), WATERMARK);
  assert.equal(result.driftType, "STALE_TOTAL");
  assert.equal(result.action, "FLAG_REINDEX");
});

test("matched rows are ok", () => {
  const result = classifyOrderSync(entity(), grid(), WATERMARK);
  assert.equal(result.driftType, "OK");
  assert.equal(result.action, "NONE");
});

test("entity id is preserved in result", () => {
  const result = classifyOrderSync(entity({ entityId: 777 }), null, WATERMARK);
  assert.equal(result.entityId, 777);
});

test("exactly at watermark is flagged", () => {
  const result = classifyOrderSync(entity({ updatedAt: WATERMARK }), null, WATERMARK);
  assert.equal(result.driftType, "MISSING_FROM_GRID");
});

test("status checked before total when both differ", () => {
  const result = classifyOrderSync(entity(), grid({ status: "pending", grandTotal: 1.0 }), WATERMARK);
  assert.equal(result.driftType, "STALE_STATUS");
});
