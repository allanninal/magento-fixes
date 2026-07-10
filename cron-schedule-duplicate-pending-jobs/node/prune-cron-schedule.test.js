import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePendingSchedulesToPrune } from "./prune-cron-schedule.js";

const row = (scheduleId, jobCode, scheduledAt, createdAt) => ({
  schedule_id: scheduleId,
  job_code: jobCode,
  status: "pending",
  scheduled_at: scheduledAt,
  created_at: createdAt,
});

test("keeps earliest of true duplicates", () => {
  const rows = [
    row(1, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
    row(2, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 09:59:30"),
    row(3, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 10:00:10"),
  ];
  const [plan] = decidePendingSchedulesToPrune(rows, 20);
  assert.equal(plan.job_code, "sales_grid_sync");
  assert.deepEqual(plan.prune_ids, [2, 3]);
  assert.deepEqual(plan.keep_ids, [1]);
});

test("no duplicates no prune", () => {
  const rows = [
    row(1, "indexer_update_all_views", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
    row(2, "indexer_update_all_views", "2026-07-10 10:01:00", "2026-07-10 10:00:00"),
  ];
  const [plan] = decidePendingSchedulesToPrune(rows, 20);
  assert.deepEqual(plan.prune_ids, []);
  assert.deepEqual(plan.keep_ids, [1, 2]);
});

test("excess backlog beyond threshold prunes oldest first", () => {
  const rows = [1, 2, 3, 4, 5].map((i) =>
    row(i, "stuck_job", `2026-07-10 10:0${i}:00`, `2026-07-10 09:0${i}:00`)
  );
  const [plan] = decidePendingSchedulesToPrune(rows, 2);
  assert.deepEqual(plan.prune_ids, [1, 2, 3]);
  assert.deepEqual(plan.keep_ids, [4, 5]);
});

test("always keeps at least one row per job", () => {
  const rows = [1, 2, 3].map((i) =>
    row(i, "very_stuck_job", `2026-07-10 10:0${i}:00`, `2026-07-10 09:0${i}:00`)
  );
  const [plan] = decidePendingSchedulesToPrune(rows, 0);
  assert.ok(plan.keep_ids.length >= 1);
});

test("separate job codes do not interfere", () => {
  const rows = [
    row(1, "job_a", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
    row(2, "job_a", "2026-07-10 10:00:00", "2026-07-10 09:59:30"),
    row(3, "job_b", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
  ];
  const byJob = Object.fromEntries(
    decidePendingSchedulesToPrune(rows, 20).map((p) => [p.job_code, p])
  );
  assert.deepEqual(byJob.job_a.prune_ids, [2]);
  assert.deepEqual(byJob.job_b.prune_ids, []);
});

test("duplicate then excess combines both rules", () => {
  const rows = [
    row(1, "combo_job", "2026-07-10 10:00:00", "2026-07-10 09:00:00"),
    row(2, "combo_job", "2026-07-10 10:00:00", "2026-07-10 09:00:05"),
    row(3, "combo_job", "2026-07-10 10:01:00", "2026-07-10 09:01:00"),
    row(4, "combo_job", "2026-07-10 10:02:00", "2026-07-10 09:02:00"),
  ];
  const [plan] = decidePendingSchedulesToPrune(rows, 2);
  assert.ok(plan.prune_ids.includes(2));
  assert.ok(plan.prune_ids.includes(1));
  assert.deepEqual(plan.keep_ids, [3, 4]);
});
