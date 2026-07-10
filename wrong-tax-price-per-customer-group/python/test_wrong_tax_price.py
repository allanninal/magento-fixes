from flag_tax_price_mismatch import decide_expected_final_price

RULES = [
    {"customerTaxClassIds": [3], "productTaxClassIds": [2], "rateIds": [1]},
    {"customerTaxClassIds": [10], "productTaxClassIds": [2], "rateIds": [2, 3]},
]
RATES = {1: 8.0, 2: 5.0, 3: 2.5}


def test_matched_rule_computes_expected_final():
    result = decide_expected_final_price(100.0, 2, 3, RULES, RATES)
    assert result == {"expectedFinal": 108.0, "matchedRuleFound": True, "appliedRatePct": 8.0}


def test_no_matching_rule_is_orphaned():
    result = decide_expected_final_price(100.0, 2, 999, RULES, RATES)
    assert result == {"expectedFinal": 100.0, "matchedRuleFound": False, "appliedRatePct": 0}


def test_multi_rate_stacking_sums_rates():
    result = decide_expected_final_price(100.0, 2, 10, RULES, RATES)
    assert result["matchedRuleFound"] is True
    assert result["appliedRatePct"] == 7.5
    assert result["expectedFinal"] == 107.5


def test_price_includes_tax_returns_tier_price_unchanged():
    result = decide_expected_final_price(100.0, 2, 3, RULES, RATES, price_includes_tax=True)
    assert result == {"expectedFinal": 100.0, "matchedRuleFound": True, "appliedRatePct": 8.0}


def test_rounds_to_two_decimals():
    result = decide_expected_final_price(19.99, 2, 3, RULES, RATES)
    assert result["expectedFinal"] == 21.59


def test_no_rules_at_all_is_orphaned():
    result = decide_expected_final_price(50.0, 2, 3, [], {})
    assert result == {"expectedFinal": 50.0, "matchedRuleFound": False, "appliedRatePct": 0}


def test_rule_matches_customer_class_but_not_product_class():
    rules = [{"customerTaxClassIds": [3], "productTaxClassIds": [99], "rateIds": [1]}]
    result = decide_expected_final_price(100.0, 2, 3, rules, RATES)
    assert result["matchedRuleFound"] is False
