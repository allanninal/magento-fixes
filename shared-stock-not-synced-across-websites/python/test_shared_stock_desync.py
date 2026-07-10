from detect_stock_desync import detect_stock_desync


def report(**over):
    base = {"website_code": "base", "stock_id": 1, "salable_qty": 42}
    base.update(over)
    return base


def test_in_sync_when_stock_ids_and_qty_match():
    reports = [report(), report(website_code="eu_website")]
    result = detect_stock_desync(reports, expected_shared_stock_id=1)
    assert result == {"inSync": True, "driftedWebsites": [], "qtyMismatches": []}


def test_flags_drifted_website_with_wrong_stock_id():
    reports = [report(), report(website_code="eu_website", stock_id=2, salable_qty=42)]
    result = detect_stock_desync(reports, expected_shared_stock_id=1)
    assert result["inSync"] is False
    assert result["driftedWebsites"] == ["eu_website"]
    assert result["qtyMismatches"] == []


def test_flags_qty_mismatch_when_stock_ids_agree():
    reports = [report(salable_qty=42), report(website_code="eu_website", stock_id=1, salable_qty=10)]
    result = detect_stock_desync(reports, expected_shared_stock_id=1)
    assert result["inSync"] is False
    assert result["driftedWebsites"] == []
    assert result["qtyMismatches"] == [{"website_code": "eu_website", "salable_qty": 10}]


def test_flags_both_drift_and_mismatch_together():
    reports = [
        report(salable_qty=42),
        report(website_code="eu_website", stock_id=1, salable_qty=10),
        report(website_code="apac_website", stock_id=3, salable_qty=99),
    ]
    result = detect_stock_desync(reports, expected_shared_stock_id=1)
    assert result["inSync"] is False
    assert result["driftedWebsites"] == ["apac_website"]
    assert result["qtyMismatches"] == [{"website_code": "eu_website", "salable_qty": 10}]


def test_single_website_is_trivially_in_sync():
    result = detect_stock_desync([report()], expected_shared_stock_id=1)
    assert result["inSync"] is True


def test_empty_reports_is_in_sync():
    result = detect_stock_desync([], expected_shared_stock_id=1)
    assert result == {"inSync": True, "driftedWebsites": [], "qtyMismatches": []}
