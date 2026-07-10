from flag_grid_sync_backlog import classify_grid_sync_backlog


def samples(*counts):
    return [{"timestampMs": i, "updatedSinceLastPollCount": c} for i, c in enumerate(counts)]


def test_healthy_when_all_polls_under_batch_size():
    result = classify_grid_sync_backlog(samples(10, 20, 5), 100, 2)
    assert result["backlogSuspected"] is False
    assert result["consecutiveOverBatchRuns"] == 0
    assert result["estimatedBacklogRows"] == 0


def test_single_spike_is_not_enough():
    result = classify_grid_sync_backlog(samples(150, 30, 10), 100, 2)
    assert result["backlogSuspected"] is False


def test_two_consecutive_over_batch_size_flags_backlog():
    result = classify_grid_sync_backlog(samples(120, 140), 100, 2)
    assert result["backlogSuspected"] is True
    assert result["consecutiveOverBatchRuns"] == 2
    assert result["estimatedBacklogRows"] == 20 + 40


def test_streak_resets_after_a_healthy_poll():
    result = classify_grid_sync_backlog(samples(150, 40, 150, 160), 100, 2)
    assert result["backlogSuspected"] is True
    assert result["consecutiveOverBatchRuns"] == 2
    assert result["estimatedBacklogRows"] == 50 + 60


def test_exactly_at_batch_size_counts_as_over():
    result = classify_grid_sync_backlog(samples(100, 100), 100, 2)
    assert result["backlogSuspected"] is True
    assert result["consecutiveOverBatchRuns"] == 2


def test_empty_history_is_healthy():
    result = classify_grid_sync_backlog([], 100, 2)
    assert result["backlogSuspected"] is False
    assert result["consecutiveOverBatchRuns"] == 0


def test_threshold_of_one_flags_single_over_batch_poll():
    result = classify_grid_sync_backlog(samples(150), 100, 1)
    assert result["backlogSuspected"] is True
    assert result["consecutiveOverBatchRuns"] == 1
    assert result["estimatedBacklogRows"] == 50
