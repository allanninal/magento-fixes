from reconcile_reserved_order_ids import classify_reserved_order_gap


def quote(**over):
    base = {"reservedOrderId": "000000512", "isActive": False, "updatedAt": "2026-07-01T10:00:00Z"}
    base.update(over)
    return base


def test_consumed_when_matching_order_exists():
    result = classify_reserved_order_gap(quote(), [{"incrementId": "000000512"}])
    assert result["status"] == "consumed"


def test_orphaned_gap_when_inactive_and_no_match():
    result = classify_reserved_order_gap(quote(), [])
    assert result["status"] == "orphaned_gap"


def test_pending_checkout_when_still_active_and_no_match():
    result = classify_reserved_order_gap(quote(isActive=True), [])
    assert result["status"] == "pending_checkout"


def test_consumed_takes_priority_over_active_flag():
    result = classify_reserved_order_gap(quote(isActive=True), [{"incrementId": "000000512"}])
    assert result["status"] == "consumed"


def test_unrelated_order_match_does_not_count_as_consumed():
    result = classify_reserved_order_gap(quote(), [{"incrementId": "000000999"}])
    assert result["status"] == "orphaned_gap"


def test_result_carries_the_reserved_order_id():
    result = classify_reserved_order_gap(quote(reservedOrderId="000000777"), [])
    assert result["reservedOrderId"] == "000000777"


def test_empty_matching_orders_list_is_handled():
    result = classify_reserved_order_gap(quote(isActive=False), [])
    assert result["status"] == "orphaned_gap"


def test_multiple_matching_orders_with_one_correct_is_consumed():
    result = classify_reserved_order_gap(
        quote(),
        [{"incrementId": "000000001"}, {"incrementId": "000000512"}],
    )
    assert result["status"] == "consumed"
