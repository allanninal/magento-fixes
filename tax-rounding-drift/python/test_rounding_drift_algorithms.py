from flag_tax_rounding_drift import decide_tax_drift


def line(unit_price=100.0, qty=1, tax_percent=10.0, discount=0.0):
    return {"unitPrice": unit_price, "qty": qty, "taxPercent": tax_percent, "discountAmount": discount}


def test_unit_base_rounds_per_unit_then_sums():
    # 333.33 * 0.10 = 33.333 -> rounds to 33.33 per unit, times qty 3 = 99.99
    items = [line(unit_price=333.33, qty=3, tax_percent=10.0)]
    result = decide_tax_drift(items, 0, 0, "UNIT_BASE_CALCULATION", actual_order_tax_amount=99.99)
    assert result["expectedTax"] == 99.99
    assert result["isDrift"] is False


def test_row_base_rounds_once_per_row_can_differ_by_a_cent():
    # 333.33 * 3 = 999.99, * 0.10 = 99.999 -> rounds to 100.00, one cent above unit-based
    items = [line(unit_price=333.33, qty=3, tax_percent=10.0)]
    result = decide_tax_drift(items, 0, 0, "ROW_BASE_CALCULATION", actual_order_tax_amount=100.00)
    assert result["expectedTax"] == 100.00
    assert result["isDrift"] is False


def test_row_base_flags_real_drift_beyond_tolerance():
    items = [line(unit_price=333.33, qty=3, tax_percent=10.0)]
    result = decide_tax_drift(items, 0, 0, "ROW_BASE_CALCULATION", actual_order_tax_amount=95.00)
    assert result["isDrift"] is True
    assert result["delta"] == 5.00


def test_total_base_single_rate_sums_all_rows_first():
    items = [line(unit_price=50.0, qty=2, tax_percent=8.0), line(unit_price=25.0, qty=1, tax_percent=8.0)]
    # subtotal 125.00 * 0.08 = 10.00
    result = decide_tax_drift(items, 0, 0, "TOTAL_BASE_CALCULATION", actual_order_tax_amount=10.00)
    assert result["expectedTax"] == 10.00
    assert result["isDrift"] is False


def test_total_base_mixed_rates_is_non_comparable():
    items = [line(unit_price=50.0, qty=1, tax_percent=8.0), line(unit_price=50.0, qty=1, tax_percent=20.0)]
    result = decide_tax_drift(items, 0, 0, "TOTAL_BASE_CALCULATION", actual_order_tax_amount=999.0)
    assert result["nonComparable"] is True
    assert result["isDrift"] is False


def test_shipping_tax_is_added_once_rounded():
    items = [line(unit_price=100.0, qty=1, tax_percent=10.0)]
    result = decide_tax_drift(items, 20.0, 10.0, "ROW_BASE_CALCULATION", actual_order_tax_amount=12.00)
    # 10.00 item tax + round(20.00 * 0.10, 2) = 2.00 shipping tax = 12.00
    assert result["expectedTax"] == 12.00
    assert result["isDrift"] is False


def test_discount_reduces_row_total_before_tax_on_row_base():
    items = [line(unit_price=100.0, qty=2, tax_percent=10.0, discount=20.0)]
    # (100*2 - 20) * 0.10 = 18.00
    result = decide_tax_drift(items, 0, 0, "ROW_BASE_CALCULATION", actual_order_tax_amount=18.00)
    assert result["expectedTax"] == 18.00
    assert result["isDrift"] is False


def test_unknown_algorithm_raises():
    items = [line()]
    try:
        decide_tax_drift(items, 0, 0, "NOT_A_REAL_ALGORITHM", actual_order_tax_amount=0)
        assert False, "expected ValueError"
    except ValueError:
        pass
