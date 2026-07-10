import { test } from "node:test";
import assert from "node:assert/strict";
import { isJobStalled } from "./flag-stalled-cron.js";

const NOW = new Date("2026-07-10T12:00:00Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

test("stalled when running far past interval", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", minutesAgo(200), 60, NOW), true);
});

test("not stalled when running within multiplier", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", minutesAgo(90), 60, NOW), false);
});

test("not stalled when status success", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "success", minutesAgo(500), 60, NOW), false);
});

test("not stalled when status error", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "error", minutesAgo(500), 60, NOW), false);
});

test("not stalled when status missed", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "missed", minutesAgo(500), 60, NOW), false);
});

test("not stalled when status pending", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "pending", null, 60, NOW), false);
});

test("not stalled when executedAt missing", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", null, 60, NOW), false);
});

test("custom stale multiplier widens the window", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", minutesAgo(200), 60, NOW, 5.0), false);
});

test("exactly at threshold is not stalled", () => {
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", minutesAgo(180), 60, NOW), false);
});

test("just past threshold is stalled", () => {
  const executedAt = new Date(NOW.getTime() - (180 * 60000 + 1000)).toISOString();
  assert.equal(isJobStalled("indexer_reindex_all_invalid", "running", executedAt, 60, NOW), true);
});
