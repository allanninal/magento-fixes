import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMissingParentImage } from "./configurable-missing-image.js";

const entry = (over = {}) => ({ disabled: false, types: ["image", "small_image", "thumbnail"], ...over });

test("flags when parent empty and child has image", () => {
  const result = decideMissingParentImage([], { "CHILD-1": [entry()] });
  assert.equal(result.flagged, true);
  assert.equal(result.parentImageCount, 0);
  assert.deepEqual(result.childrenWithImages, ["CHILD-1"]);
  assert.equal(result.recommendedFixSku, "CHILD-1");
});

test("not flagged when parent has image", () => {
  const result = decideMissingParentImage([entry()], { "CHILD-1": [entry()] });
  assert.equal(result.flagged, false);
  assert.equal(result.recommendedFixSku, null);
});

test("not flagged when no children have images", () => {
  const result = decideMissingParentImage([], { "CHILD-1": [], "CHILD-2": [] });
  assert.equal(result.flagged, false);
  assert.deepEqual(result.childrenWithImages, []);
  assert.equal(result.recommendedFixSku, null);
});

test("disabled entries do not count as images", () => {
  const result = decideMissingParentImage(
    [entry({ disabled: true })],
    { "CHILD-1": [entry({ disabled: true })] }
  );
  assert.equal(result.flagged, false);
});

test("prefers child whose entry type includes image", () => {
  const result = decideMissingParentImage([], {
    "CHILD-1": [entry({ types: ["thumbnail"] })],
    "CHILD-2": [entry({ types: ["image", "small_image"] })],
  });
  assert.equal(result.flagged, true);
  assert.deepEqual(new Set(result.childrenWithImages), new Set(["CHILD-1", "CHILD-2"]));
  assert.equal(result.recommendedFixSku, "CHILD-2");
});

test("falls back to first child when none typed image", () => {
  const result = decideMissingParentImage([], {
    "CHILD-1": [entry({ types: ["thumbnail"] })],
    "CHILD-2": [entry({ types: ["small_image"] })],
  });
  assert.equal(result.flagged, true);
  assert.equal(result.recommendedFixSku, "CHILD-1");
});

test("no children at all is not flagged", () => {
  const result = decideMissingParentImage([], {});
  assert.equal(result.flagged, false);
  assert.equal(result.parentImageCount, 0);
  assert.equal(result.recommendedFixSku, null);
});

test("mixed disabled and enabled entries count only enabled", () => {
  const result = decideMissingParentImage(
    [entry({ disabled: true }), entry({ disabled: true })],
    { "CHILD-1": [entry({ disabled: true }), entry({ disabled: false })] }
  );
  assert.equal(result.flagged, true);
  assert.equal(result.parentImageCount, 0);
  assert.deepEqual(result.childrenWithImages, ["CHILD-1"]);
});
