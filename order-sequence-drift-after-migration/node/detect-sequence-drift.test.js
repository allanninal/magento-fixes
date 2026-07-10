import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSequenceDrift, stripPrefix } from "./detect-sequence-drift.js";

const order = (over = {}) => ({
  entityId: 1,
  storeId: 1,
  incrementId: "100000001",
  createdAt: "2026-07-01 00:00:00",
  ...over,
});

test("no drift on clean sequential orders", () => {
  const orders = [
    order({ entityId: 1, incrementId: "100000001" }),
    order({ entityId: 2, incrementId: "100000002" }),
    order({ entityId: 3, incrementId: "100000003" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.maxNumericByStore[1], 100000003);
});

test("duplicate increment_id across two entity_ids", () => {
  const orders = [
    order({ entityId: 10, incrementId: "100000050" }),
    order({ entityId: 11, incrementId: "100000050" }),
    order({ entityId: 12, incrementId: "100000051" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].entityIds, [10, 11]);
  assert.equal(result.duplicates[0].incrementId, "100000050");
});

test("gap beyond threshold is flagged", () => {
  const orders = [
    order({ entityId: 1, incrementId: "100004521" }),
    order({ entityId: 2, incrementId: "100009000" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].fromIncrement, 100004521);
  assert.equal(result.gaps[0].toIncrement, 100009000);
  assert.equal(result.gaps[0].gapSize, 4479);
});

test("gap within threshold is not flagged", () => {
  const orders = [
    order({ entityId: 1, incrementId: "100000001" }),
    order({ entityId: 2, incrementId: "100000500" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.deepEqual(result.gaps, []);
});

test("stores are isolated from each other", () => {
  const orders = [
    order({ entityId: 1, storeId: 1, incrementId: "100000001" }),
    order({ entityId: 2, storeId: 2, incrementId: "200000001" }),
    order({ entityId: 3, storeId: 2, incrementId: "200000001" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].storeId, 2);
  assert.equal(result.maxNumericByStore[1], 100000001);
});

test("stripPrefix handles store prefix", () => {
  assert.equal(stripPrefix("ORD-000123", "ORD-"), 123);
});

test("stripPrefix handles no prefix", () => {
  assert.equal(stripPrefix("100000042", ""), 100000042);
});

test("maxNumericByStore recommends reset value", () => {
  const orders = [
    order({ entityId: 1, incrementId: "100000001" }),
    order({ entityId: 2, incrementId: "100000099" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  const recommendedReset = result.maxNumericByStore[1] + 1;
  assert.equal(recommendedReset, 100000100);
});

test("single order has no gaps or duplicates", () => {
  const orders = [order({ entityId: 1, incrementId: "100000001" })];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.maxNumericByStore[1], 100000001);
});

test("three way duplicate reports all entity_ids", () => {
  const orders = [
    order({ entityId: 1, incrementId: "100000010" }),
    order({ entityId: 2, incrementId: "100000010" }),
    order({ entityId: 3, incrementId: "100000010" }),
  ];
  const result = detectSequenceDrift(orders, {}, 1000);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].entityIds, [1, 2, 3]);
});
