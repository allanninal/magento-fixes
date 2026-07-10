import datetime
from flag_stalled_cron import is_job_stalled

NOW = datetime.datetime(2026, 7, 10, 12, 0, 0, tzinfo=datetime.timezone.utc)


def test_stalled_when_running_far_past_interval():
    executed_at = NOW - datetime.timedelta(minutes=200)
    assert is_job_stalled("indexer_reindex_all_invalid", "running", executed_at, 60, NOW) is True


def test_not_stalled_when_running_within_multiplier():
    executed_at = NOW - datetime.timedelta(minutes=90)
    assert is_job_stalled("indexer_reindex_all_invalid", "running", executed_at, 60, NOW) is False


def test_not_stalled_when_status_success():
    executed_at = NOW - datetime.timedelta(minutes=500)
    assert is_job_stalled("indexer_reindex_all_invalid", "success", executed_at, 60, NOW) is False


def test_not_stalled_when_status_error():
    executed_at = NOW - datetime.timedelta(minutes=500)
    assert is_job_stalled("indexer_reindex_all_invalid", "error", executed_at, 60, NOW) is False


def test_not_stalled_when_status_missed():
    executed_at = NOW - datetime.timedelta(minutes=500)
    assert is_job_stalled("indexer_reindex_all_invalid", "missed", executed_at, 60, NOW) is False


def test_not_stalled_when_status_pending():
    assert is_job_stalled("indexer_reindex_all_invalid", "pending", None, 60, NOW) is False


def test_not_stalled_when_executed_at_missing():
    assert is_job_stalled("indexer_reindex_all_invalid", "running", None, 60, NOW) is False


def test_custom_stale_multiplier_widens_the_window():
    executed_at = NOW - datetime.timedelta(minutes=200)
    assert is_job_stalled("indexer_reindex_all_invalid", "running", executed_at, 60, NOW, stale_multiplier=5.0) is False


def test_exactly_at_threshold_is_not_stalled():
    executed_at = NOW - datetime.timedelta(minutes=180)
    assert is_job_stalled("indexer_reindex_all_invalid", "running", executed_at, 60, NOW) is False


def test_just_past_threshold_is_stalled():
    executed_at = NOW - datetime.timedelta(minutes=180, seconds=1)
    assert is_job_stalled("indexer_reindex_all_invalid", "running", executed_at, 60, NOW) is True
