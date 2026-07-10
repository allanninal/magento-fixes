import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateGalleryEntries, safeDuplicateIds, normalizedStem } from "./find-duplicate-gallery-entries.js";

const entry = (id, file, hash = null, types = []) => ({ id, file, hash, types });

test("no duplicates when all hashes differ", () => {
  const entries = [entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/b.jpg", "h2")];
  assert.deepEqual(findDuplicateGalleryEntries(entries), []);
});

test("finds duplicate by hash and keeps lowest id", () => {
  const entries = [entry(3, "/m/b/a_2.jpg", "h1"), entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1")];
  const result = findDuplicateGalleryEntries(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].keepId, 1);
  assert.deepEqual(result[0].duplicateIds, [2, 3]);
  assert.equal(result[0].reason, "identical file content");
});

test("falls back to normalized filename without hash", () => {
  const entries = [entry(1, "/m/b/photo.jpg"), entry(2, "/m/b/photo_1.jpg")];
  const result = findDuplicateGalleryEntries(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "identical normalized filename");
});

test("different pictures are not grouped", () => {
  const entries = [entry(1, "/m/b/front.jpg", "h1"), entry(2, "/m/b/back.jpg", "h2"), entry(3, "/m/b/side.jpg", "h3")];
  assert.deepEqual(findDuplicateGalleryEntries(entries), []);
});

test("returns empty array for empty input", () => {
  assert.deepEqual(findDuplicateGalleryEntries([]), []);
});

test("multiple groups reported independently", () => {
  const entries = [
    entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1"),
    entry(3, "/m/b/b.jpg", "h2"), entry(4, "/m/b/b_1.jpg", "h2"),
    entry(5, "/m/b/c.jpg", "h3"),
  ];
  const result = findDuplicateGalleryEntries(entries);
  assert.equal(result.length, 2);
  const keepIds = result.map((g) => g.keepId).sort((a, b) => a - b);
  assert.deepEqual(keepIds, [1, 3]);
});

test("safeDuplicateIds allows removal when no role", () => {
  const entries = [entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1")];
  const group = { keepId: 1, duplicateIds: [2], reason: "identical file content" };
  assert.deepEqual(safeDuplicateIds(entries, group), [2]);
});

test("safeDuplicateIds blocks when role not covered by keeper", () => {
  const entries = [entry(1, "/m/b/a.jpg", "h1", []), entry(2, "/m/b/a_1.jpg", "h1", ["base"])];
  const group = { keepId: 1, duplicateIds: [2], reason: "identical file content" };
  assert.deepEqual(safeDuplicateIds(entries, group), []);
});

test("safeDuplicateIds allows when keeper covers role", () => {
  const entries = [entry(1, "/m/b/a.jpg", "h1", ["base", "small_image"]), entry(2, "/m/b/a_1.jpg", "h1", ["base"])];
  const group = { keepId: 1, duplicateIds: [2], reason: "identical file content" };
  assert.deepEqual(safeDuplicateIds(entries, group), [2]);
});

test("safeDuplicateIds never removes only image", () => {
  const entries = [entry(1, "/m/b/a.jpg", "h1")];
  const group = { keepId: 1, duplicateIds: [], reason: "identical file content" };
  assert.deepEqual(safeDuplicateIds(entries, group), []);
});

test("normalizedStem strips Magento disambiguation suffix", () => {
  assert.equal(normalizedStem("/m/b/photo_12.jpg"), "photo.jpg");
  assert.equal(normalizedStem("/m/b/photo.jpg"), "photo.jpg");
});
