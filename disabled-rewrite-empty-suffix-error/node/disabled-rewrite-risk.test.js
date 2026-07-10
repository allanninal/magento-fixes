import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrlSuffixRisk } from "./url-suffix-risk-check.js";

const config = (over = {}) => ({
  productUrlSuffix: "",
  categoryUrlSuffix: "",
  useCategoriesPathForProductUrls: true,
  generateCategoryProductRewrites: false,
  ...over,
});

test("affected when all conditions and 404", () => {
  const result = classifyUrlSuffixRisk(config(), "test-category/test-sub-category/test", 404);
  assert.deepEqual(result, { affected: true, reason: "empty-suffix-category-path-collision" });
});

test("affected when all conditions and 500", () => {
  const result = classifyUrlSuffixRisk(config(), "test-category/test", 500);
  assert.equal(result.affected, true);
});

test("not affected when product suffix present", () => {
  const result = classifyUrlSuffixRisk(config({ productUrlSuffix: "html" }), "test-category/test", 404);
  assert.deepEqual(result, { affected: false, reason: "suffix-present" });
});

test("not affected when category suffix present", () => {
  const result = classifyUrlSuffixRisk(config({ categoryUrlSuffix: "html" }), "test-category/test", 404);
  assert.deepEqual(result, { affected: false, reason: "suffix-present" });
});

test("not affected when categories not used in path", () => {
  const result = classifyUrlSuffixRisk(config({ useCategoriesPathForProductUrls: false }), "test", 404);
  assert.deepEqual(result, { affected: false, reason: "no-category-path" });
});

test("not affected when rewrites enabled", () => {
  const result = classifyUrlSuffixRisk(config({ generateCategoryProductRewrites: true }), "test-category/test", 404);
  assert.deepEqual(result, { affected: false, reason: "rewrites-enabled" });
});

test("not affected when path has no category segment", () => {
  const result = classifyUrlSuffixRisk(config(), "test", 404);
  assert.deepEqual(result, { affected: false, reason: "no-category-path" });
});

test("not affected when status is 200", () => {
  const result = classifyUrlSuffixRisk(config(), "test-category/test", 200);
  assert.deepEqual(result, { affected: false, reason: "ok" });
});

test("not affected when status is 301", () => {
  const result = classifyUrlSuffixRisk(config(), "test-category/test", 301);
  assert.deepEqual(result, { affected: false, reason: "ok" });
});

test("category suffix alone blocks even without product suffix", () => {
  const result = classifyUrlSuffixRisk(
    config({ productUrlSuffix: "", categoryUrlSuffix: "html" }),
    "test-category/test",
    500
  );
  assert.deepEqual(result, { affected: false, reason: "suffix-present" });
});

test("both suffixes present is never affected", () => {
  const result = classifyUrlSuffixRisk(
    config({ productUrlSuffix: "html", categoryUrlSuffix: "html" }),
    "test-category/test",
    404
  );
  assert.equal(result.affected, false);
});
