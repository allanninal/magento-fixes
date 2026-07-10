from flag_salable_qty_corruption import reconcile_salable_qty


def test_exact_match_is_consistent():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=70, open_order_item_qty_sum_value=30)
    assert result == {"isConsistent": True, "expectedSalableQty": 70, "delta": 0}


def test_within_rounding_tolerance_is_consistent():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=70.00005, open_order_item_qty_sum_value=30)
    assert result["isConsistent"] is True


def test_overcompensation_positive_delta_is_flagged():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=85, open_order_item_qty_sum_value=30)
    assert result["isConsistent"] is False
    assert result["expectedSalableQty"] == 70
    assert result["delta"] == 15


def test_lost_reservation_negative_delta_is_flagged():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=40, open_order_item_qty_sum_value=30)
    assert result["isConsistent"] is False
    assert result["expectedSalableQty"] == 70
    assert result["delta"] == -30


def test_custom_tolerance_is_respected():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=70.01, open_order_item_qty_sum_value=30, tolerance=0.02)
    assert result["isConsistent"] is True


def test_just_over_default_tolerance_is_flagged():
    result = reconcile_salable_qty(source_qty=100, reported_salable_qty_value=70.001, open_order_item_qty_sum_value=30)
    assert result["isConsistent"] is False


def test_zero_open_orders_expected_equals_source():
    result = reconcile_salable_qty(source_qty=50, reported_salable_qty_value=50, open_order_item_qty_sum_value=0)
    assert result == {"isConsistent": True, "expectedSalableQty": 50, "delta": 0}
