from flag_shared_catalog_price_mismatch import decide_price_mismatch


def expected(**over):
    base = {"sku": "widget-01", "customerGroupId": 5, "sharedCatalogId": 2, "expectedPrice": 80.00}
    base.update(over)
    return base


def observed(**over):
    base = {"sku": "widget-01", "customerGroupId": 5, "renderedPrice": 80.00, "cacheAgeSeconds": 30}
    base.update(over)
    return base


def test_ok_when_price_matches_within_tolerance():
    result = decide_price_mismatch(expected(), observed(renderedPrice=80.004))
    assert result["isMismatch"] is False
    assert result["severity"] == "ok"


def test_wrong_company_when_price_matches_another_groups_expected_price():
    # We expected group 5 (Company A) to see 80.00. Instead, the request
    # observed as group 5 rendered 45.00, which is exactly Company C's
    # (group 9) shared catalog price -- i.e. Company A was served
    # Company C's cached price.
    other_prices = {9: 45.00}
    result = decide_price_mismatch(
        expected(customerGroupId=5, expectedPrice=80.00),
        observed(customerGroupId=7, renderedPrice=45.00),
        other_prices,
    )
    assert result["isMismatch"] is True
    assert result["severity"] == "wrong_company"


def test_wrong_group_when_stale_and_matches_no_known_group():
    result = decide_price_mismatch(expected(), observed(renderedPrice=99.99), {7: 65.00})
    assert result["isMismatch"] is True
    assert result["severity"] == "wrong_group"


def test_wrong_group_when_same_group_but_price_disagrees():
    result = decide_price_mismatch(expected(), observed(customerGroupId=5, renderedPrice=75.00))
    assert result["isMismatch"] is True
    assert result["severity"] == "wrong_group"


def test_ok_ignores_penny_rounding():
    result = decide_price_mismatch(expected(expectedPrice=19.99), observed(renderedPrice=19.995))
    assert result["severity"] == "ok"


def test_wrong_company_only_triggers_when_group_differs_from_expected():
    # Same group as expected, price differs, and happens to equal another group's price:
    # this is still just "wrong_group" per the spec, since observed group == expected group.
    other_prices = {7: 75.00}
    result = decide_price_mismatch(expected(customerGroupId=5), observed(customerGroupId=5, renderedPrice=75.00), other_prices)
    assert result["severity"] == "wrong_group"


def test_no_mismatch_reported_as_ok_reason_present():
    result = decide_price_mismatch(expected(), observed())
    assert result["isMismatch"] is False
    assert "reason" in result
