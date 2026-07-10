import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCronEmailBacklog } from "./flag-cron-email-backlog.js";

const NOW = "2026-07-10T12:00:00Z";

const order = (over = {}) => ({
  entityId: 501,
  incrementId: "100000501",
  createdAt: "2026-07-10T11:00:00Z", // 60 minutes old
  status: "processing",
  ...over,
});

test("no stale orders when all recent", () => {
  const result = classifyCronEmailBacklog([order({ createdAt: "2026-07-10T11:55:00Z" })], NOW, 30, 5);
  assert.deepEqual(result.staleOrders, []);
  assert.equal(result.cronLikelyDown, false);
});

test("stale order past threshold", () => {
  const result = classifyCronEmailBacklog([order()], NOW, 30, 5);
  assert.equal(result.staleOrders.length, 1);
  assert.equal(result.staleOrders[0].incrementId, "100000501");
});

test("canceled orders are excluded", () => {
  const result = classifyCronEmailBacklog([order({ status: "canceled" })], NOW, 30, 5);
  assert.deepEqual(result.staleOrders, []);
});

test("cron likely down when backlog count reached", () => {
  const orders = [0, 1, 2, 3, 4].map((i) => order({ entityId: i, incrementId: String(i) }));
  const result = classifyCronEmailBacklog(orders, NOW, 30, 5);
  assert.equal(result.cronLikelyDown, true);
});

test("cron likely down when one order extremely overdue", () => {
  const result = classifyCronEmailBacklog(
    [order({ createdAt: "2026-07-10T09:00:00Z" })], NOW, 30, 5 // 180 minutes overdue
  );
  assert.equal(result.cronLikelyDown, true);
});

test("not cron likely down with small recent backlog", () => {
  const result = classifyCronEmailBacklog([order()], NOW, 30, 5);
  assert.equal(result.cronLikelyDown, false);
});

test("stale orders sorted by minutes overdue descending", () => {
  const orders = [
    order({ entityId: 1, incrementId: "1", createdAt: "2026-07-10T11:00:00Z" }),
    order({ entityId: 2, incrementId: "2", createdAt: "2026-07-10T10:00:00Z" }),
  ];
  const result = classifyCronEmailBacklog(orders, NOW, 30, 5);
  assert.deepEqual(result.staleOrders.map((o) => o.incrementId), ["2", "1"]);
});

test("exactly at threshold is not stale", () => {
  const result = classifyCronEmailBacklog(
    [order({ createdAt: "2026-07-10T11:30:00Z" })], NOW, 30, 5 // exactly 30 minutes
  );
  assert.deepEqual(result.staleOrders, []);
});

test("closed status is not excluded by classifier", () => {
  // The API call excludes closed via searchCriteria; the pure classifier only
  // excludes the terminal set it knows about (canceled), so a closed order
  // reaching it would still be evaluated on age alone.
  const result = classifyCronEmailBacklog([order({ status: "closed" })], NOW, 30, 5);
  assert.equal(result.staleOrders.length, 1);
});
