import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIndexerRow } from "./flag-stuck-indexers.js";

const NOW = new Date("2026-07-10T12:00:00Z");
const THRESHOLDS = { stuckWorkingMinutes: 60, changelogBacklogMax: 5000 };

const row = (over = {}) => ({
  status: "working",
  updatedAt: new Date(NOW.getTime() - 90 * 60000).toISOString(),
  ...over,
});

test("ok when not working", () => {
  assert.equal(classifyIndexerRow(row({ status: "valid" }), NOW, THRESHOLDS).action, "ok");
});

test("ok when invalid status", () => {
  assert.equal(classifyIndexerRow(row({ status: "invalid" }), NOW, THRESHOLDS).action, "ok");
});

test("ok when working within threshold", () => {
  const r = row({ updatedAt: new Date(NOW.getTime() - 10 * 60000).toISOString() });
  assert.equal(classifyIndexerRow(r, NOW, THRESHOLDS).action, "ok");
});

test("reset candidate when stale and no backlog info", () => {
  assert.equal(classifyIndexerRow(row(), NOW, THRESHOLDS).action, "reset_candidate");
});

test("flag backlog when stale and backlog exceeds max", () => {
  const result = classifyIndexerRow(row(), NOW, THRESHOLDS, 9000);
  assert.equal(result.action, "flag_backlog");
});

test("reset candidate when stale and backlog within max", () => {
  const result = classifyIndexerRow(row(), NOW, THRESHOLDS, 100);
  assert.equal(result.action, "reset_candidate");
});

test("exactly at threshold is ok", () => {
  const r = row({ updatedAt: new Date(NOW.getTime() - 60 * 60000).toISOString() });
  assert.equal(classifyIndexerRow(r, NOW, THRESHOLDS).action, "ok");
});

test("just past threshold is flagged", () => {
  const r = row({ updatedAt: new Date(NOW.getTime() - 61 * 60000).toISOString() });
  assert.equal(classifyIndexerRow(r, NOW, THRESHOLDS).action, "reset_candidate");
});

test("missing backlog max threshold falls back to reset candidate", () => {
  const thresholds = { stuckWorkingMinutes: 60 };
  const result = classifyIndexerRow(row(), NOW, thresholds, 999999);
  assert.equal(result.action, "reset_candidate");
});
