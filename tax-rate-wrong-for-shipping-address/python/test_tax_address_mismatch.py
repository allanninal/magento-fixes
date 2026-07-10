from detect_tax_address_mismatch import (
    expected_tax_rate,
    detect_tax_mismatch,
    is_default_address_leak,
)

TAX_RATES = [
    {"id": 1, "tax_country_id": "BE", "tax_region_id": 0, "tax_postcode": "*", "rate": 0.0},
    {"id": 2, "tax_country_id": "FR", "tax_region_id": 0, "tax_postcode": "*", "rate": 20.0},
    {"id": 3, "tax_country_id": "US", "tax_region_id": 12, "tax_postcode": "90001-90099", "rate": 8.25},
]

TAX_RULES = [
    {"id": 1, "priority": 0, "customer_tax_class_ids": [3], "product_tax_class_ids": [2], "tax_rate_ids": [1, 2]},
    {"id": 2, "priority": 1, "customer_tax_class_ids": [3], "product_tax_class_ids": [2], "tax_rate_ids": [3]},
]


def test_french_shipping_address_expects_french_vat():
    france = {"country_id": "FR", "region_id": None, "postcode": "75001"}
    result = expected_tax_rate(france, 3, 2, TAX_RULES, TAX_RATES)
    assert result["expectedRate"] == 20.0
    assert result["matchedRuleId"] == 1


def test_belgium_default_address_expects_zero():
    belgium = {"country_id": "BE", "region_id": None, "postcode": "1000"}
    result = expected_tax_rate(belgium, 3, 2, TAX_RULES, TAX_RATES)
    assert result["expectedRate"] == 0.0


def test_issue_38232_style_mismatch_is_detected():
    # order shipped to France but was taxed as if the address were Belgium (0%)
    france = {"country_id": "FR", "region_id": None, "postcode": "75001"}
    expected = expected_tax_rate(france, 3, 2, TAX_RULES, TAX_RATES)
    mismatch = detect_tax_mismatch(order_actual_rate=0.0, expected_result=expected)
    assert mismatch["isMismatch"] is True
    assert mismatch["expectedRate"] == 20.0
    assert mismatch["delta"] == 20.0


def test_matching_rate_is_not_a_mismatch():
    france = {"country_id": "FR", "region_id": None, "postcode": "75001"}
    expected = expected_tax_rate(france, 3, 2, TAX_RULES, TAX_RATES)
    mismatch = detect_tax_mismatch(order_actual_rate=20.0, expected_result=expected)
    assert mismatch["isMismatch"] is False


def test_within_epsilon_is_not_a_mismatch():
    france = {"country_id": "FR", "region_id": None, "postcode": "75001"}
    expected = expected_tax_rate(france, 3, 2, TAX_RULES, TAX_RATES)
    mismatch = detect_tax_mismatch(order_actual_rate=19.98, expected_result=expected, epsilon=0.05)
    assert mismatch["isMismatch"] is False


def test_us_postcode_range_rate_matches():
    address = {"country_id": "US", "region_id": 12, "postcode": "90045"}
    result = expected_tax_rate(address, 3, 2, TAX_RULES, TAX_RATES)
    assert result["expectedRate"] == 8.25
    assert result["matchedRuleId"] == 2


def test_default_address_leak_detected_when_shipping_id_differs():
    assert is_default_address_leak(shipping_customer_address_id=42, default_shipping_id=7, default_billing_id=7) is True


def test_no_leak_when_shipping_matches_default():
    assert is_default_address_leak(shipping_customer_address_id=7, default_shipping_id=7, default_billing_id=9) is False


def test_no_leak_when_no_customer_address_id_present():
    assert is_default_address_leak(shipping_customer_address_id=None, default_shipping_id=7, default_billing_id=9) is False
