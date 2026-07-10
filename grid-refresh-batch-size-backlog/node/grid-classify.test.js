import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGridSyncBacklog } from "./flag-grid-sync-backlog.js";

const samples = (...counts) => counts.map((c, i) => ({ timestampMs: i, updatedSinceLastPollCount: c }));

test("healthy when all polls under batch size", () => {
  const result = classifyGridSyncBacklog(samples(10, 20, 5), 100, 2);
  assert.equal(result.backlogSuspected, false);
  assert.equal(result.consecutiveOverBatchRuns, 0);
  assert.equal(result.estimatedBacklogRows, 0);
});

test("single spike is not enough", () => {
  const result = classifyGridSyncBacklog(samples(150, 30, 10), 100, 2);
  assert.equal(result.backlogSuspected, false);
});

test("two consecutive over batch size flags backlog", () => {
  const result = classifyGridSyncBacklog(samples(120, 140), 100, 2);
  assert.equal(result.backlogSuspected, true);
  assert.equal(result.consecutiveOverBatchRuns, 2);
  assert.equal(result.estimatedBacklogRows, 20 + 40);
});

test("streak resets after a healthy poll", () => {
  const result = classifyGridSyncBacklog(samples(150, 40, 150, 160), 100, 2);
  assert.equal(result.backlogSuspected, true);
  assert.equal(result.consecutiveOverBatchRuns, 2);
  assert.equal(result.estimatedBacklogRows, 50 + 60);
});

test("exactly at batch size counts as over", () => {
  const result = classifyGridSyncBacklog(samples(100, 100), 100, 2);
  assert.equal(result.backlogSuspected, true);
  assert.equal(result.consecutiveOverBatchRuns, 2);
});

test("empty history is healthy", () => {
  const result = classifyGridSyncBacklog([], 100, 2);
  assert.equal(result.backlogSuspected, false);
  assert.equal(result.consecutiveOverBatchRuns, 0);
});

test("threshold of one flags single over-batch poll", () => {
  const result = classifyGridSyncBacklog(samples(150), 100, 1);
  assert.equal(result.backlogSuspected, true);
  assert.equal(result.consecutiveOverBatchRuns, 1);
  assert.equal(result.estimatedBacklogRows, 50);
});
