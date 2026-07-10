import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDuplicateCreditMemos } from "./flag-duplicate-creditmemos.js";

const cm = (entityId, orderId, grandTotal, createdAtEpoch) => ({
  entityId, orderId, grandTotal, createdAtEpoch,
});

test("no duplicates for single creditmemo per order", () => {
  const records = [cm(1, "100", 50.0, 1000)];
  assert.deepEqual(detectDuplicateCreditMemos(records), []);
});

test("flags two near-identical creditmemos seconds apart", () => {
  const records = [
    cm(1, "100", 50.0, 1000),
    cm(2, "100", 50.0, 1030),
  ];
  const result = detectDuplicateCreditMemos(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].orderId, "100");
  assert.deepEqual([...result[0].duplicateGroup].sort(), [1, 2]);
  assert.equal(result[0].totalOverRefund, 50.0);
});

test("does not flag two legitimate partial refunds far apart", () => {
  const records = [
    cm(1, "100", 30.0, 1000),
    cm(2, "100", 20.0, 1000 + 3600),
  ];
  assert.deepEqual(detectDuplicateCreditMemos(records), []);
});

test("does not flag different amounts close in time", () => {
  const records = [
    cm(1, "100", 30.0, 1000),
    cm(2, "100", 45.0, 1010),
  ];
  assert.deepEqual(detectDuplicateCreditMemos(records), []);
});

test("flags three-way duplicate and sums excess", () => {
  const records = [
    cm(1, "200", 20.0, 5000),
    cm(2, "200", 20.0, 5015),
    cm(3, "200", 20.0, 5040),
  ];
  const result = detectDuplicateCreditMemos(records);
  assert.equal(result.length, 1);
  assert.deepEqual([...result[0].duplicateGroup].sort(), [1, 2, 3]);
  assert.equal(result[0].totalOverRefund, 40.0);
});

test("separate orders are evaluated independently", () => {
  const records = [
    cm(1, "100", 50.0, 1000),
    cm(2, "100", 50.0, 1020),
    cm(3, "200", 50.0, 1000),
  ];
  const result = detectDuplicateCreditMemos(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].orderId, "100");
});

test("amount within epsilon still counts as duplicate", () => {
  const records = [
    cm(1, "100", 50.00, 1000),
    cm(2, "100", 50.005, 1010),
  ];
  const result = detectDuplicateCreditMemos(records, 60, 0.01);
  assert.equal(result.length, 1);
});

test("exactly at tolerance boundary is flagged", () => {
  const records = [
    cm(1, "100", 50.0, 1000),
    cm(2, "100", 50.0, 1060),
  ];
  const result = detectDuplicateCreditMemos(records, 60, 0.01);
  assert.equal(result.length, 1);
});

test("empty input returns empty array", () => {
  assert.deepEqual(detectDuplicateCreditMemos([]), []);
});
