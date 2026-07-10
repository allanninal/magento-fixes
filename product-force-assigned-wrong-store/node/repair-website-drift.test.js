import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWebsiteDrift } from "./repair-website-drift.js";

test("no drift when ids match regardless of order", () => {
  const result = decideWebsiteDrift([2, 1], [1, 2], "default");
  assert.equal(result.isDrifted, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
});

test("detects missing website id", () => {
  const result = decideWebsiteDrift([1], [1, 2, 3], "admin");
  assert.equal(result.isDrifted, true);
  assert.deepEqual(result.missing, [2, 3]);
  assert.deepEqual(result.unexpected, []);
});

test("detects unexpected website id", () => {
  const result = decideWebsiteDrift([1, 2, 9], [1, 2], "default");
  assert.equal(result.isDrifted, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, [9]);
});

test("detects both missing and unexpected", () => {
  const result = decideWebsiteDrift([1, 9], [1, 2], "default");
  assert.equal(result.isDrifted, true);
  assert.deepEqual(result.missing, [2]);
  assert.deepEqual(result.unexpected, [9]);
});

test("flags likely forced default signature", () => {
  const result = decideWebsiteDrift([1], [1, 2, 3], "admin", "admin");
  assert.equal(result.likelyForcedDefault, true);
});

test("not forced default when store context is not admin", () => {
  const result = decideWebsiteDrift([1], [1, 2, 3], "default", "admin");
  assert.equal(result.likelyForcedDefault, false);
});

test("not forced default when expected is single website", () => {
  const result = decideWebsiteDrift([1], [1], "admin", "admin");
  assert.equal(result.likelyForcedDefault, false);
  assert.equal(result.isDrifted, false);
});

test("not forced default when actual has more than default", () => {
  const result = decideWebsiteDrift([1, 2], [1, 2, 3], "admin", "admin");
  assert.equal(result.likelyForcedDefault, false);
  assert.equal(result.isDrifted, true);
});

test("dedupes duplicate ids in input", () => {
  const result = decideWebsiteDrift([1, 1, 2], [1, 2, 2], "default");
  assert.equal(result.isDrifted, false);
});

test("empty actual and expected is not drifted", () => {
  const result = decideWebsiteDrift([], [], "default");
  assert.equal(result.isDrifted, false);
  assert.equal(result.likelyForcedDefault, false);
});
