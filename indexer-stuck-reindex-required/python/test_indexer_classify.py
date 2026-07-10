import datetime

from flag_stuck_indexers import classify_indexer_row

NOW = datetime.datetime(2026, 7, 10, 12, 0, 0, tzinfo=datetime.timezone.utc)
THRESHOLDS = {"stuckWorkingMinutes": 60, "changelogBacklogMax": 5000}


def row(**over):
    base = {"status": "working", "updatedAt": NOW - datetime.timedelta(minutes=90)}
    base.update(over)
    return base


def test_ok_when_not_working():
    r = row(status="valid")
    assert classify_indexer_row(r, NOW, THRESHOLDS)["action"] == "ok"


def test_ok_when_invalid_status():
    r = row(status="invalid")
    assert classify_indexer_row(r, NOW, THRESHOLDS)["action"] == "ok"


def test_ok_when_working_within_threshold():
    r = row(updatedAt=NOW - datetime.timedelta(minutes=10))
    assert classify_indexer_row(r, NOW, THRESHOLDS)["action"] == "ok"


def test_reset_candidate_when_stale_and_no_backlog_info():
    result = classify_indexer_row(row(), NOW, THRESHOLDS)
    assert result["action"] == "reset_candidate"


def test_flag_backlog_when_stale_and_backlog_exceeds_max():
    result = classify_indexer_row(row(), NOW, THRESHOLDS, changelog_row_count=9000)
    assert result["action"] == "flag_backlog"


def test_reset_candidate_when_stale_and_backlog_within_max():
    result = classify_indexer_row(row(), NOW, THRESHOLDS, changelog_row_count=100)
    assert result["action"] == "reset_candidate"


def test_exactly_at_threshold_is_ok():
    r = row(updatedAt=NOW - datetime.timedelta(minutes=60))
    assert classify_indexer_row(r, NOW, THRESHOLDS)["action"] == "ok"


def test_just_past_threshold_is_flagged():
    r = row(updatedAt=NOW - datetime.timedelta(minutes=61))
    assert classify_indexer_row(r, NOW, THRESHOLDS)["action"] == "reset_candidate"


def test_missing_backlog_max_threshold_falls_back_to_reset_candidate():
    thresholds = {"stuckWorkingMinutes": 60}
    result = classify_indexer_row(row(), NOW, thresholds, changelog_row_count=999999)
    assert result["action"] == "reset_candidate"
