import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStorefrontEligibility } from "./diagnose-missing-product.js";

const CATEGORIES = [{ id: 2, isActive: true }, { id: 9, isActive: false }];

const product = (over = {}) => ({ status: 1, visibility: 4, websiteIds: [1], categoryIds: [2], ...over });

test("eligible when all conditions pass", () => {
  const result = decideStorefrontEligibility(product(), CATEGORIES, 1);
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

test("disabled is flagged", () => {
  const result = decideStorefrontEligibility(product({ status: 2 }), CATEGORIES, 1);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("disabled"));
});

test("not visible individually is flagged", () => {
  const result = decideStorefrontEligibility(product({ visibility: 1 }), CATEGORIES, 1);
  assert.ok(result.reasons.includes("not_visible_individually"));
});

test("visibility catalog only is eligible", () => {
  const result = decideStorefrontEligibility(product({ visibility: 2 }), CATEGORIES, 1);
  assert.equal(result.eligible, true);
});

test("website not assigned is flagged", () => {
  const result = decideStorefrontEligibility(product({ websiteIds: [2] }), CATEGORIES, 1);
  assert.ok(result.reasons.includes("website_not_assigned"));
});

test("no active category is flagged", () => {
  const result = decideStorefrontEligibility(product({ categoryIds: [9] }), CATEGORIES, 1);
  assert.ok(result.reasons.includes("no_active_category"));
});

test("no categories at all is flagged", () => {
  const result = decideStorefrontEligibility(product({ categoryIds: [] }), CATEGORIES, 1);
  assert.ok(result.reasons.includes("no_active_category"));
});

test("multiple failures all listed", () => {
  const result = decideStorefrontEligibility(
    product({ status: 2, visibility: 1, websiteIds: [], categoryIds: [9] }), CATEGORIES, 1
  );
  assert.deepEqual(
    new Set(result.reasons),
    new Set(["disabled", "not_visible_individually", "website_not_assigned", "no_active_category"])
  );
});

test("eligible with at least one active category among several", () => {
  const result = decideStorefrontEligibility(product({ categoryIds: [9, 2] }), CATEGORIES, 1);
  assert.equal(result.eligible, true);
});
