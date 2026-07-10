from repair_website_drift import decide_website_drift


def test_no_drift_when_ids_match_regardless_of_order():
    result = decide_website_drift([2, 1], [1, 2], "default")
    assert result["isDrifted"] is False
    assert result["missing"] == []
    assert result["unexpected"] == []


def test_detects_missing_website_id():
    result = decide_website_drift([1], [1, 2, 3], "admin")
    assert result["isDrifted"] is True
    assert result["missing"] == [2, 3]
    assert result["unexpected"] == []


def test_detects_unexpected_website_id():
    result = decide_website_drift([1, 2, 9], [1, 2], "default")
    assert result["isDrifted"] is True
    assert result["missing"] == []
    assert result["unexpected"] == [9]


def test_detects_both_missing_and_unexpected():
    result = decide_website_drift([1, 9], [1, 2], "default")
    assert result["isDrifted"] is True
    assert result["missing"] == [2]
    assert result["unexpected"] == [9]


def test_flags_likely_forced_default_signature():
    result = decide_website_drift([1], [1, 2, 3], "admin", "admin")
    assert result["likelyForcedDefault"] is True


def test_not_forced_default_when_store_context_is_not_admin():
    result = decide_website_drift([1], [1, 2, 3], "default", "admin")
    assert result["likelyForcedDefault"] is False


def test_not_forced_default_when_expected_is_single_website():
    result = decide_website_drift([1], [1], "admin", "admin")
    assert result["likelyForcedDefault"] is False
    assert result["isDrifted"] is False


def test_not_forced_default_when_actual_has_more_than_default():
    result = decide_website_drift([1, 2], [1, 2, 3], "admin", "admin")
    assert result["likelyForcedDefault"] is False
    assert result["isDrifted"] is True


def test_dedupes_duplicate_ids_in_input():
    result = decide_website_drift([1, 1, 2], [1, 2, 2], "default")
    assert result["isDrifted"] is False


def test_empty_actual_and_expected_is_not_drifted():
    result = decide_website_drift([], [], "default")
    assert result["isDrifted"] is False
    assert result["likelyForcedDefault"] is False
