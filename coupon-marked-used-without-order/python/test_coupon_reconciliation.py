from reconcile_coupon_usage import compute_orphaned_coupon_usages


def coupon(**over):
    base = {"couponId": 1, "ruleId": 10, "code": "SAVE10", "timesUsed": 1}
    base.update(over)
    return base


def test_no_orphan_when_counts_match():
    orders = {"SAVE10": [{"entityId": 1, "incrementId": "000000001", "state": "complete"}]}
    assert compute_orphaned_coupon_usages([coupon()], orders) == []


def test_orphan_when_times_used_exceeds_real_orders():
    orders = {"SAVE10": []}
    result = compute_orphaned_coupon_usages([coupon()], orders)
    assert result == [{"couponId": 1, "code": "SAVE10", "timesUsed": 1, "actualOrderCount": 0, "orphanedCount": 1}]


def test_cancelled_orders_are_excluded_from_actual_count():
    orders = {"SAVE10": [{"entityId": 1, "incrementId": "000000001", "state": "canceled"}]}
    result = compute_orphaned_coupon_usages([coupon()], orders)
    assert result[0]["actualOrderCount"] == 0
    assert result[0]["orphanedCount"] == 1


def test_no_orphan_when_multiple_orders_cover_usage():
    orders = {"SAVE10": [
        {"entityId": 1, "incrementId": "000000001", "state": "complete"},
        {"entityId": 2, "incrementId": "000000002", "state": "processing"},
    ]}
    result = compute_orphaned_coupon_usages([coupon(timesUsed=2)], orders)
    assert result == []


def test_missing_coupon_code_in_orders_map_counts_as_zero_orders():
    result = compute_orphaned_coupon_usages([coupon()], {})
    assert result[0]["actualOrderCount"] == 0


def test_multiple_coupons_only_flags_the_orphaned_one():
    coupons = [coupon(couponId=1, code="SAVE10", timesUsed=1), coupon(couponId=2, code="WELCOME20", timesUsed=1)]
    orders = {"SAVE10": [], "WELCOME20": [{"entityId": 5, "incrementId": "000000005", "state": "complete"}]}
    result = compute_orphaned_coupon_usages(coupons, orders)
    assert len(result) == 1
    assert result[0]["code"] == "SAVE10"


def test_custom_excluded_states_are_respected():
    orders = {"SAVE10": [{"entityId": 1, "incrementId": "000000001", "state": "closed"}]}
    result = compute_orphaned_coupon_usages([coupon()], orders, excluded_states=("closed",))
    assert result[0]["actualOrderCount"] == 0
    assert result[0]["orphanedCount"] == 1
