import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingWebsiteAssignment } from "./find-missing-website-assignment.js";

const product = (over = {}) => ({ sku: "SKU-1", extension_attributes: { website_ids: [1] }, ...over });

test("not affected when website ids present", () => {
  const result = isMissingWebsiteAssignment(product(), [1]);
  assert.deepEqual(result, { sku: "SKU-1", affected: false, missingWebsiteIds: [] });
});

test("affected when website ids empty", () => {
  const result = isMissingWebsiteAssignment(product({ extension_attributes: { website_ids: [] } }), [1]);
  assert.equal(result.affected, true);
  assert.deepEqual(result.missingWebsiteIds, [1]);
});

test("affected when extension_attributes missing", () => {
  const result = isMissingWebsiteAssignment({ sku: "SKU-2" }, [1]);
  assert.deepEqual(result, { sku: "SKU-2", affected: true, missingWebsiteIds: [1] });
});

test("affected when expected website id not in actual", () => {
  const result = isMissingWebsiteAssignment(product({ extension_attributes: { website_ids: [2] } }), [1]);
  assert.equal(result.affected, true);
  assert.deepEqual(result.missingWebsiteIds, [1]);
});

test("not affected when actual has extra websites", () => {
  const result = isMissingWebsiteAssignment(product({ extension_attributes: { website_ids: [1, 2] } }), [1]);
  assert.equal(result.affected, false);
  assert.deepEqual(result.missingWebsiteIds, []);
});

test("supports multiple expected website ids", () => {
  const result = isMissingWebsiteAssignment(product({ extension_attributes: { website_ids: [1] } }), [1, 2]);
  assert.equal(result.affected, true);
  assert.deepEqual(result.missingWebsiteIds, [2]);
});
