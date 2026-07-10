from diagnose_stock_mismatch import diagnose_stock_mismatch


def test_consistent_when_grid_in_stock_and_salable_positive():
    result = diagnose_stock_mismatch("SKU1", True, 10, 5)
    assert result["mismatched"] is False
    assert result["severity"] == "none"


def test_consistent_when_grid_out_of_stock_and_salable_zero():
    result = diagnose_stock_mismatch("SKU2", False, 0, 0)
    assert result["mismatched"] is False
    assert result["severity"] == "none"


def test_critical_when_grid_in_stock_positive_qty_but_salable_zero():
    result = diagnose_stock_mismatch("SKU3", True, 8, 0)
    assert result["mismatched"] is True
    assert result["severity"] == "critical"


def test_stale_index_when_grid_in_stock_zero_qty_and_salable_zero():
    result = diagnose_stock_mismatch("SKU4", True, 0, 0)
    assert result["mismatched"] is True
    assert result["severity"] == "stale_index"


def test_stale_index_when_grid_out_of_stock_after_restock():
    result = diagnose_stock_mismatch("SKU5", False, 0, 12)
    assert result["mismatched"] is True
    assert result["severity"] == "stale_index"


def test_negative_salable_quantity_is_still_a_mismatch():
    result = diagnose_stock_mismatch("SKU6", True, 3, -2)
    assert result["mismatched"] is True
    assert result["severity"] == "critical"


def test_respects_custom_min_qty_threshold():
    result = diagnose_stock_mismatch("SKU7", True, 5, 2, min_qty_threshold=3)
    assert result["mismatched"] is True
    assert result["severity"] == "critical"


def test_exactly_at_threshold_counts_as_out_of_stock_side():
    # salable_qty == min_qty_threshold falls on the "<=" branch, not the "> " branch
    result = diagnose_stock_mismatch("SKU8", True, 4, 0, min_qty_threshold=0)
    assert result["mismatched"] is True
    assert result["severity"] == "critical"
