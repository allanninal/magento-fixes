from detect_rule_price_mismatch import evaluate_rule_price_mismatch


def tier(**over):
    base = {"customerGroupId": 3, "price": 80.0, "priceType": "fixed", "qty": 1}
    base.update(over)
    return base


def test_no_mismatch_when_tier_price_correctly_discounted():
    # base=100, group 3 has a fixed tier price of 80, rule discounts 10% off that tier price
    result = evaluate_rule_price_mismatch(100.0, [tier()], 3, 10, 72.0)
    assert result["isMismatch"] is False
    assert result["mismatchType"] is None
    assert round(result["expectedPrice"], 2) == 72.0


def test_base_price_used_instead_of_tier_price():
    # base=100, group 3 tier price is 80, but actual price is base*(1-10%) = 90
    result = evaluate_rule_price_mismatch(100.0, [tier()], 3, 10, 90.0)
    assert result["isMismatch"] is True
    assert result["mismatchType"] == "base_price_used"


def test_scope_leak_to_other_customer_group():
    # rule targets group 3 (tier 80), but actual price matches group 4's tier (60) discounted
    rows = [tier(customerGroupId=3, price=80.0), tier(customerGroupId=4, price=60.0)]
    actual = 60.0 * (1 - 10 / 100)  # 54.0, discount leaked onto group 4's price
    result = evaluate_rule_price_mismatch(100.0, rows, 3, 10, actual)
    assert result["isMismatch"] is True
    assert result["mismatchType"] == "scope_leak"


def test_falls_back_to_all_groups_row_when_no_group_specific_row():
    rows = [tier(customerGroupId=32000, price=90.0)]
    result = evaluate_rule_price_mismatch(100.0, rows, 3, 10, 81.0)
    assert result["isMismatch"] is False
    assert round(result["expectedPrice"], 2) == 81.0


def test_falls_back_to_base_price_when_no_tier_rows_at_all():
    result = evaluate_rule_price_mismatch(100.0, [], 3, 10, 90.0)
    assert result["isMismatch"] is False
    assert round(result["expectedPrice"], 2) == 90.0


def test_discount_type_tier_price_is_applied_to_base():
    # tier row itself is a percent discount off base, not a fixed price
    rows = [tier(customerGroupId=3, price=15.0, priceType="discount")]
    # starting price = 100 * (1 - 15/100) = 85, then rule discounts another 10%
    result = evaluate_rule_price_mismatch(100.0, rows, 3, 10, 76.5)
    assert result["isMismatch"] is False
    assert round(result["expectedPrice"], 2) == 76.5


def test_within_tolerance_is_not_a_mismatch():
    result = evaluate_rule_price_mismatch(100.0, [tier()], 3, 10, 72.005)
    assert result["isMismatch"] is False


def test_qty_greater_than_one_rows_are_ignored_for_qty1_lookup():
    rows = [tier(qty=5, price=50.0), tier(qty=1, price=80.0)]
    result = evaluate_rule_price_mismatch(100.0, rows, 3, 10, 72.0)
    assert result["isMismatch"] is False
    assert round(result["expectedPrice"], 2) == 72.0
