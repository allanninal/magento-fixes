from repair_threshold_source_items import recompute_source_item_status


def test_in_stock_when_quantity_above_positive_threshold():
    assert recompute_source_item_status(10, 5, False) == 1


def test_out_of_stock_when_quantity_at_positive_threshold():
    assert recompute_source_item_status(5, 5, False) == 0


def test_out_of_stock_when_quantity_below_positive_threshold():
    assert recompute_source_item_status(2, 5, False) == 0


def test_out_of_stock_when_quantity_zero_and_threshold_zero_no_backorders():
    assert recompute_source_item_status(0, 0, False) == 0


def test_in_stock_when_zero_threshold_and_backorders_enabled():
    assert recompute_source_item_status(0, 0, True) == 1


def test_in_stock_when_negative_threshold_and_backorders_enabled():
    assert recompute_source_item_status(-3, -2, True) == 1


def test_uses_normal_math_when_positive_threshold_even_with_backorders():
    assert recompute_source_item_status(10, 5, True) == 1
    assert recompute_source_item_status(3, 5, True) == 0
