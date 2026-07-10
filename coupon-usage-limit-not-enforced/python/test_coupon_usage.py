from evaluate_coupon_usage import evaluate_coupon_usage


def rule(**over):
    base = {"ruleId": 12, "usesPerCoupon": 1, "usesPerCustomer": 1}
    base.update(over)
    return base


def coupon(**over):
    base = {"couponId": 55, "code": "SAVE10", "reportedTimesUsed": 1}
    base.update(over)
    return base


def order(**over):
    base = {"orderId": "1", "incrementId": "000000001", "customerId": 7, "state": "complete"}
    base.update(over)
    return base


def test_no_violation_when_within_limits_and_counter_matches():
    result = evaluate_coupon_usage(rule(), coupon(), [order()])
    assert result["isViolation"] is False
    assert result["realTotalCount"] == 1


def test_per_coupon_exceeded_when_real_count_over_limit():
    orders = [
        order(orderId="1", incrementId="000000001"),
        order(orderId="2", incrementId="000000002", customerId=9),
    ]
    result = evaluate_coupon_usage(
        rule(usesPerCoupon=1, usesPerCustomer=None), coupon(reportedTimesUsed=2), orders
    )
    assert result["isViolation"] is True
    assert result["reason"] == "per_coupon_exceeded"
    assert result["offendingOrderIncrementIds"] == ["000000002"]


def test_per_customer_exceeded_when_same_customer_reuses_coupon():
    orders = [
        order(orderId="1", incrementId="000000001"),
        order(orderId="2", incrementId="000000002"),
    ]
    result = evaluate_coupon_usage(
        rule(usesPerCoupon=None, usesPerCustomer=1), coupon(reportedTimesUsed=2), orders
    )
    assert result["isViolation"] is True
    assert result["reason"] == "per_customer_exceeded"
    assert result["perCustomerCounts"]["7"] == 2


def test_times_used_drift_when_counter_lags_real_orders():
    orders = [order()]
    result = evaluate_coupon_usage(
        rule(usesPerCoupon=None, usesPerCustomer=None), coupon(reportedTimesUsed=0), orders
    )
    assert result["isViolation"] is True
    assert result["reason"] == "times_used_drift"


def test_cancelled_orders_are_excluded_from_the_real_count():
    orders = [order(), order(orderId="2", incrementId="000000002", state="canceled")]
    result = evaluate_coupon_usage(rule(usesPerCoupon=1), coupon(reportedTimesUsed=1), orders)
    assert result["isViolation"] is False
    assert result["realTotalCount"] == 1


def test_guest_orders_are_grouped_under_guest_key():
    orders = [order(customerId=None)]
    result = evaluate_coupon_usage(
        rule(usesPerCoupon=None, usesPerCustomer=None), coupon(reportedTimesUsed=1), orders
    )
    assert result["perCustomerCounts"]["guest"] == 1


def test_no_violation_when_counter_reports_higher_than_real():
    # times_used can also be ahead of real (e.g. stale cancelled row); not a
    # violation on its own since it does not exceed configured limits.
    orders = [order()]
    result = evaluate_coupon_usage(rule(usesPerCoupon=5, usesPerCustomer=5), coupon(reportedTimesUsed=3), orders)
    assert result["isViolation"] is False
