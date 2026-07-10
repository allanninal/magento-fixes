from flag_stuck_cron import classify_stale_cron_row

NOW = 1_800_000_000.0
TIMEOUT = 7200


def row(**over):
    base = {"status": "running", "executedAt": NOW - 9000, "createdAt": NOW - 9100, "now": NOW}
    base.update(over)
    return base


def test_ok_when_not_running():
    assert classify_stale_cron_row(row(status="success"), TIMEOUT) == "ok"


def test_ok_when_running_within_timeout():
    r = row(executedAt=NOW - 60)
    assert classify_stale_cron_row(r, TIMEOUT) == "ok"


def test_stale_running_when_past_timeout():
    assert classify_stale_cron_row(row(), TIMEOUT) == "stale_running"


def test_exactly_at_timeout_is_ok():
    r = row(executedAt=NOW - TIMEOUT)
    assert classify_stale_cron_row(r, TIMEOUT) == "ok"


def test_stale_unstarted_when_executed_at_missing_and_old():
    r = row(executedAt=None, createdAt=NOW - 600)
    assert classify_stale_cron_row(r, TIMEOUT) == "stale_unstarted"


def test_ok_when_executed_at_missing_but_within_grace():
    r = row(executedAt=None, createdAt=NOW - 30)
    assert classify_stale_cron_row(r, TIMEOUT) == "ok"


def test_ok_when_running_but_no_timestamps_at_all():
    r = row(executedAt=None, createdAt=None)
    assert classify_stale_cron_row(r, TIMEOUT) == "ok"
