import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateIncrementIds } from "./find-duplicate-increment-ids.js";

const order = (over = {}) => ({
  entityId: 501,
  incrementId: "000000045",
  storeId: 1,
  createdAt: "2026-07-01T10:00:00Z",
  ...over,
});

test("no duplicates when all increment_ids unique", () => {
  const orders = [order({ entityId: 1, incrementId: "1" }), order({ entityId: 2, incrementId: "2" })];
  assert.deepEqual(findDuplicateIncrementIds(orders), []);
});

test("detects collision across two entity ids", () => {
  const orders = [
    order({ entityId: 501, incrementId: "000000045", createdAt: "2026-07-01T10:00:00Z" }),
    order({ entityId: 812, incrementId: "000000045", createdAt: "2026-07-02T09:00:00Z" }),
  ];
  const result = findDuplicateIncrementIds(orders);
  assert.equal(result.length, 1);
  assert.equal(result[0].incrementId, "000000045");
  assert.equal(result[0].members.length, 2);
});

test("same entity id repeated is not a collision", () => {
  const orders = [order({ entityId: 501, incrementId: "000000045" }), order({ entityId: 501, incrementId: "000000045" })];
  assert.deepEqual(findDuplicateIncrementIds(orders), []);
});

test("members sorted by createdAt ascending", () => {
  const orders = [
    order({ entityId: 812, incrementId: "000000045", createdAt: "2026-07-02T09:00:00Z" }),
    order({ entityId: 501, incrementId: "000000045", createdAt: "2026-07-01T10:00:00Z" }),
  ];
  const result = findDuplicateIncrementIds(orders);
  assert.equal(result[0].members[0].entityId, 501);
  assert.equal(result[0].members[1].entityId, 812);
});

test("groups sorted by incrementId ascending", () => {
  const orders = [
    order({ entityId: 1, incrementId: "000000099" }), order({ entityId: 2, incrementId: "000000099" }),
    order({ entityId: 3, incrementId: "000000010" }), order({ entityId: 4, incrementId: "000000010" }),
  ];
  const result = findDuplicateIncrementIds(orders);
  assert.deepEqual(result.map((d) => d.incrementId), ["000000010", "000000099"]);
});

test("three way collision is one group with three members", () => {
  const orders = [
    order({ entityId: 1, incrementId: "000000005", createdAt: "2026-07-01T00:00:00Z" }),
    order({ entityId: 2, incrementId: "000000005", createdAt: "2026-07-02T00:00:00Z" }),
    order({ entityId: 3, incrementId: "000000005", createdAt: "2026-07-03T00:00:00Z" }),
  ];
  const result = findDuplicateIncrementIds(orders);
  assert.equal(result.length, 1);
  assert.equal(result[0].members.length, 3);
});

test("empty input returns empty list", () => {
  assert.deepEqual(findDuplicateIncrementIds([]), []);
});

test("different store ids still flagged as collision", () => {
  const orders = [
    order({ entityId: 501, incrementId: "000000045", storeId: 1, createdAt: "2026-07-01T10:00:00Z" }),
    order({ entityId: 812, incrementId: "000000045", storeId: 2, createdAt: "2026-07-02T09:00:00Z" }),
  ];
  const result = findDuplicateIncrementIds(orders);
  assert.equal(result.length, 1);
  assert.equal(result[0].members[0].storeId, 1);
  assert.equal(result[0].members[1].storeId, 2);
});
