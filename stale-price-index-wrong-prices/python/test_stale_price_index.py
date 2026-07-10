from flag_stale_price_index import decide_price_index_action


def test_not_stale_within_epsilon():
    result = decide_price_index_action(19.99, 19.98, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z")
    assert result == {"stale": False, "action": "none"}


def test_flag_reindex_when_edited_after_last_reindex():
    result = decide_price_index_action(24.00, 19.99, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z")
    assert result == {"stale": True, "action": "flag_reindex"}


def test_flag_investigate_when_edited_before_last_reindex():
    result = decide_price_index_action(24.00, 19.99, "2026-06-20T00:00:00Z", "2026-07-01T00:00:00Z")
    assert result == {"stale": True, "action": "flag_investigate"}


def test_flag_reindex_when_no_known_last_reindex():
    result = decide_price_index_action(24.00, 19.99, "2026-06-20T00:00:00Z", None)
    assert result == {"stale": True, "action": "flag_reindex"}


def test_exactly_at_epsilon_is_not_stale():
    result = decide_price_index_action(20.00, 19.995, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z", epsilon=0.01)
    assert result == {"stale": False, "action": "none"}


def test_just_over_epsilon_is_stale():
    result = decide_price_index_action(20.02, 20.00, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z", epsilon=0.01)
    assert result["stale"] is True


def test_equal_prices_are_not_stale():
    result = decide_price_index_action(15.50, 15.50, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z")
    assert result == {"stale": False, "action": "none"}


def test_edited_exactly_at_last_reindex_is_not_after():
    # updated_at equal to last_reindex_at is not strictly "after", so it is not explained
    # by a pending reindex and should be flagged for investigation.
    result = decide_price_index_action(24.00, 19.99, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z")
    assert result == {"stale": True, "action": "flag_investigate"}
