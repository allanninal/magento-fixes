import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStaleCronRow } from "./flag-stuck-cron.js";

const NOW = 1_800_000_000;
const TIMEOUT = 7200;

const row = (over = {}) => ({
  status: "running",
  executedAt: NOW - 9000,
  createdAt: NOW - 9100,
  now: NOW,
  ...over,
});

test("ok when not running", () => {
  assert.equal(classifyStaleCronRow(row({ status: "success" }), TIMEOUT), "ok");
});

test("ok when running within timeout", () => {
  const r = row({ executedAt: NOW - 60 });
  assert.equal(classifyStaleCronRow(r, TIMEOUT), "ok");
});

test("stale running when past timeout", () => {
  assert.equal(classifyStaleCronRow(row(), TIMEOUT), "stale_running");
});

test("exactly at timeout is ok", () => {
  const r = row({ executedAt: NOW - TIMEOUT });
  assert.equal(classifyStaleCronRow(r, TIMEOUT), "ok");
});

test("stale unstarted when executedAt missing and old", () => {
  const r = row({ executedAt: null, createdAt: NOW - 600 });
  assert.equal(classifyStaleCronRow(r, TIMEOUT), "stale_unstarted");
});

test("ok when executedAt missing but within grace", () => {
  const r = row({ executedAt: null, createdAt: NOW - 30 });
  assert.equal(classifyStaleCronRow(r, TIMEOUT), "ok");
});

test("ok when running but no timestamps at all", () => {
  const r = row({ executedAt: null, createdAt: null });
  assert.equal(classifyStaleCronRow(r, TIMEOUT), "ok");
});
