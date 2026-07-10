import { test } from "node:test";
import assert from "node:assert/strict";
import { findSkuCollisions } from "./find-sku-collisions.js";

const product = (over = {}) => ({
  id: 4501,
  sku: "ABC-100",
  created_at: "2026-07-01T10:00:00Z",
  ...over,
});

test("no collisions when all skus unique", () => {
  const products = [product({ id: 1, sku: "A" }), product({ id: 2, sku: "B" })];
  assert.deepEqual(findSkuCollisions(products), []);
});

test("detects collision across two entity ids", () => {
  const products = [
    product({ id: 4501, sku: "ABC-100", created_at: "2026-07-01T10:00:00Z" }),
    product({ id: 4502, sku: "ABC-100", created_at: "2026-07-01T10:00:01Z" }),
  ];
  const result = findSkuCollisions(products);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, "abc-100");
  assert.deepEqual(result[0].entity_ids, [4501, 4502]);
});

test("same entity id repeated is not a collision", () => {
  const products = [product({ id: 4501, sku: "ABC-100" }), product({ id: 4501, sku: "ABC-100" })];
  assert.deepEqual(findSkuCollisions(products), []);
});

test("whitespace and case variants are treated as the same sku", () => {
  const products = [
    product({ id: 1, sku: "  ABC-100 ", created_at: "2026-07-01T10:00:00Z" }),
    product({ id: 2, sku: "abc-100", created_at: "2026-07-01T10:00:01Z" }),
  ];
  const result = findSkuCollisions(products);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, "abc-100");
});

test("entity ids sorted by created_at ascending", () => {
  const products = [
    product({ id: 4502, sku: "ABC-100", created_at: "2026-07-01T10:00:01Z" }),
    product({ id: 4501, sku: "ABC-100", created_at: "2026-07-01T10:00:00Z" }),
  ];
  const result = findSkuCollisions(products);
  assert.deepEqual(result[0].entity_ids, [4501, 4502]);
  assert.deepEqual(result[0].created_at, ["2026-07-01T10:00:00Z", "2026-07-01T10:00:01Z"]);
});

test("groups sorted by sku ascending", () => {
  const products = [
    product({ id: 1, sku: "ZZZ-1" }), product({ id: 2, sku: "ZZZ-1" }),
    product({ id: 3, sku: "AAA-1" }), product({ id: 4, sku: "AAA-1" }),
  ];
  const result = findSkuCollisions(products);
  assert.deepEqual(result.map((c) => c.sku), ["aaa-1", "zzz-1"]);
});

test("three way collision is one group with three ids", () => {
  const products = [
    product({ id: 1, sku: "X-1", created_at: "2026-07-01T00:00:00Z" }),
    product({ id: 2, sku: "X-1", created_at: "2026-07-01T00:00:01Z" }),
    product({ id: 3, sku: "X-1", created_at: "2026-07-01T00:00:02Z" }),
  ];
  const result = findSkuCollisions(products);
  assert.equal(result.length, 1);
  assert.equal(result[0].entity_ids.length, 3);
});

test("empty input returns empty list", () => {
  assert.deepEqual(findSkuCollisions([]), []);
});
