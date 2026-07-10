from prune_cron_schedule import decide_pending_schedules_to_prune


def row(schedule_id, job_code, scheduled_at, created_at):
    return {
        "schedule_id": schedule_id,
        "job_code": job_code,
        "status": "pending",
        "scheduled_at": scheduled_at,
        "created_at": created_at,
    }


def test_keeps_earliest_of_true_duplicates():
    rows = [
        row(1, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
        row(2, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 09:59:30"),
        row(3, "sales_grid_sync", "2026-07-10 10:00:00", "2026-07-10 10:00:10"),
    ]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=20)
    plan = result[0]
    assert plan["job_code"] == "sales_grid_sync"
    assert plan["prune_ids"] == [2, 3]
    assert plan["keep_ids"] == [1]


def test_no_duplicates_no_prune():
    rows = [
        row(1, "indexer_update_all_views", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
        row(2, "indexer_update_all_views", "2026-07-10 10:01:00", "2026-07-10 10:00:00"),
    ]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=20)
    plan = result[0]
    assert plan["prune_ids"] == []
    assert plan["keep_ids"] == [1, 2]


def test_excess_backlog_beyond_threshold_prunes_oldest_first():
    rows = [row(i, "stuck_job", f"2026-07-10 10:{i:02d}:00", f"2026-07-10 09:{i:02d}:00") for i in range(1, 6)]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=2)
    plan = result[0]
    assert plan["prune_ids"] == [1, 2, 3]
    assert plan["keep_ids"] == [4, 5]


def test_always_keeps_at_least_one_row_per_job():
    rows = [row(i, "very_stuck_job", f"2026-07-10 10:{i:02d}:00", f"2026-07-10 09:{i:02d}:00") for i in range(1, 4)]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=0)
    plan = result[0]
    assert len(plan["keep_ids"]) >= 1


def test_separate_job_codes_do_not_interfere():
    rows = [
        row(1, "job_a", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
        row(2, "job_a", "2026-07-10 10:00:00", "2026-07-10 09:59:30"),
        row(3, "job_b", "2026-07-10 10:00:00", "2026-07-10 09:59:00"),
    ]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=20)
    by_job = {plan["job_code"]: plan for plan in result}
    assert by_job["job_a"]["prune_ids"] == [2]
    assert by_job["job_b"]["prune_ids"] == []


def test_duplicate_then_excess_combines_both_rules():
    rows = [
        row(1, "combo_job", "2026-07-10 10:00:00", "2026-07-10 09:00:00"),
        row(2, "combo_job", "2026-07-10 10:00:00", "2026-07-10 09:00:05"),  # dup of 1, pruned
        row(3, "combo_job", "2026-07-10 10:01:00", "2026-07-10 09:01:00"),
        row(4, "combo_job", "2026-07-10 10:02:00", "2026-07-10 09:02:00"),
    ]
    result = decide_pending_schedules_to_prune(rows, max_pending_per_job=2)
    plan = result[0]
    # dedup removes id 2, leaving [1, 3, 4] -> excess beyond 2 removes oldest (1)
    assert 2 in plan["prune_ids"]
    assert 1 in plan["prune_ids"]
    assert plan["keep_ids"] == [3, 4]
