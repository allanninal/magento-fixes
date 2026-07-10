from category_count_check import decide_category_count_discrepancy


def test_equal_counts_not_flagged():
    result = decide_category_count_discrepancy(42, 42, False)
    assert result == {"flagged": False, "severity": "none", "delta": 0}


def test_off_by_one_is_drift():
    result = decide_category_count_discrepancy(41, 42, False)
    assert result["flagged"] is True
    assert result["severity"] == "drift"
    assert result["delta"] == 1


def test_reported_zero_with_real_assignments_is_zeroed():
    result = decide_category_count_discrepancy(0, 50, True)
    assert result["flagged"] is True
    assert result["severity"] == "zeroed"
    assert result["delta"] == 50


def test_reported_zero_and_actual_zero_not_flagged():
    result = decide_category_count_discrepancy(0, 0, True)
    assert result["flagged"] is False
    assert result["severity"] == "none"


def test_near_miss_within_tolerance_not_flagged():
    result = decide_category_count_discrepancy(100, 102, False, tolerance=5)
    assert result["flagged"] is False


def test_drift_beyond_tolerance_is_flagged():
    result = decide_category_count_discrepancy(100, 108, False, tolerance=5)
    assert result["flagged"] is True
    assert result["severity"] == "drift"


def test_zeroed_ignores_tolerance():
    result = decide_category_count_discrepancy(0, 3, True, tolerance=10)
    assert result["flagged"] is True
    assert result["severity"] == "zeroed"


def test_is_anchor_does_not_change_flag_boundary():
    anchor = decide_category_count_discrepancy(10, 20, True)
    leaf = decide_category_count_discrepancy(10, 20, False)
    assert anchor["flagged"] == leaf["flagged"] == True
    assert anchor["severity"] == leaf["severity"] == "drift"
