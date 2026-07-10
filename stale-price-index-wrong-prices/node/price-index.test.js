import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePriceIndexAction } from "./flag-stale-price-index.js";

test("not stale within epsilon", () => {
  const result = decidePriceIndexAction(19.99, 19.98, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z");
  assert.deepEqual(result, { stale: false, action: "none" });
});

test("flag_reindex when edited after last reindex", () => {
  const result = decidePriceIndexAction(24.0, 19.99, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z");
  assert.deepEqual(result, { stale: true, action: "flag_reindex" });
});

test("flag_investigate when edited before last reindex", () => {
  const result = decidePriceIndexAction(24.0, 19.99, "2026-06-20T00:00:00Z", "2026-07-01T00:00:00Z");
  assert.deepEqual(result, { stale: true, action: "flag_investigate" });
});

test("flag_reindex when no known last reindex", () => {
  const result = decidePriceIndexAction(24.0, 19.99, "2026-06-20T00:00:00Z", null);
  assert.deepEqual(result, { stale: true, action: "flag_reindex" });
});

test("exactly at epsilon is not stale", () => {
  const result = decidePriceIndexAction(20.0, 19.995, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z", 0.01);
  assert.deepEqual(result, { stale: false, action: "none" });
});

test("just over epsilon is stale", () => {
  const result = decidePriceIndexAction(20.02, 20.0, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z", 0.01);
  assert.equal(result.stale, true);
});

test("equal prices are not stale", () => {
  const result = decidePriceIndexAction(15.5, 15.5, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z");
  assert.deepEqual(result, { stale: false, action: "none" });
});

test("edited exactly at last reindex is not after", () => {
  const result = decidePriceIndexAction(24.0, 19.99, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
  assert.deepEqual(result, { stale: true, action: "flag_investigate" });
});
