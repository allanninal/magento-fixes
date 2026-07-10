from detect_stuck_catalog_rule import detect_stuck_catalog_rule_pricing

NOW = "2026-07-10T12:00:00Z"


def rule(**over):
    base = {
        "ruleId": 7,
        "websiteIds": [1],
        "discountAmount": 20,
        "simpleAction": "by_percent",
        "fromDate": None,
        "toDate": None,
    }
    base.update(over)
    return base


def price(**over):
    base = {"sku": "SKU-1", "storeId": 1, "basePrice": 100.0, "livePrice": 80.0}
    base.update(over)
    return base


def cron_row(**over):
    base = {"jobCode": "catalogrule_apply_all", "status": "error", "scheduledAt": "2026-07-10T00:00:00Z"}
    base.update(over)
    return base


def test_stuck_when_mismatch_and_error_cron():
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=100.0)], [cron_row()], NOW)
    assert result["stuck"] is True
    assert result["affectedSkus"] == ["SKU-1"]
    assert result["affectedRuleIds"] == [7]
    assert result["staleCronJobs"] == ["catalogrule_apply_all"]


def test_not_stuck_when_price_matches():
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=80.0)], [cron_row()], NOW)
    assert result["stuck"] is False
    assert result["affectedSkus"] == []


def test_not_stuck_when_cron_is_healthy():
    healthy = cron_row(status="success")
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=100.0)], [healthy], NOW)
    assert result["stuck"] is False
    assert result["staleCronJobs"] == []


def test_running_within_lock_timeout_is_not_stale():
    row = cron_row(status="running", scheduledAt="2026-07-10T11:50:00Z")
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=100.0)], [row], NOW, lock_timeout_minutes=15)
    assert result["staleCronJobs"] == []
    assert result["stuck"] is False


def test_running_past_lock_timeout_is_stale():
    row = cron_row(status="running", scheduledAt="2026-07-10T11:30:00Z")
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=100.0)], [row], NOW, lock_timeout_minutes=15)
    assert result["staleCronJobs"] == ["catalogrule_apply_all"]
    assert result["stuck"] is True


def test_rule_not_yet_active_is_ignored():
    future_rule = rule(fromDate="2026-08-01T00:00:00Z")
    result = detect_stuck_catalog_rule_pricing([future_rule], [price(livePrice=100.0)], [cron_row()], NOW)
    assert result["affectedSkus"] == []
    assert result["stuck"] is False


def test_rule_past_end_date_is_ignored():
    expired_rule = rule(toDate="2026-01-01T00:00:00Z")
    result = detect_stuck_catalog_rule_pricing([expired_rule], [price(livePrice=100.0)], [cron_row()], NOW)
    assert result["affectedSkus"] == []
    assert result["stuck"] is False


def test_by_fixed_discount_computes_expected_price():
    fixed_rule = rule(simpleAction="by_fixed", discountAmount=15)
    result = detect_stuck_catalog_rule_pricing([fixed_rule], [price(livePrice=100.0)], [cron_row()], NOW)
    assert result["affectedSkus"] == ["SKU-1"]


def test_unrelated_job_code_is_ignored():
    row = cron_row(jobCode="some_other_job", status="error")
    result = detect_stuck_catalog_rule_pricing([rule()], [price(livePrice=100.0)], [row], NOW)
    assert result["staleCronJobs"] == []
    assert result["stuck"] is False


def test_store_not_targeted_by_rule_is_ignored():
    result = detect_stuck_catalog_rule_pricing([rule()], [price(storeId=99, livePrice=100.0)], [cron_row()], NOW)
    assert result["affectedSkus"] == []
    assert result["stuck"] is False
