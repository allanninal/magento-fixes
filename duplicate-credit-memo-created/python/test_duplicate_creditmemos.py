from flag_duplicate_creditmemos import detect_duplicate_credit_memos


def cm(entity_id, order_id, grand_total, created_at_epoch):
    return {
        "entityId": entity_id,
        "orderId": order_id,
        "grandTotal": grand_total,
        "createdAtEpoch": created_at_epoch,
    }


def test_no_duplicates_for_single_creditmemo_per_order():
    records = [cm(1, "100", 50.0, 1000)]
    assert detect_duplicate_credit_memos(records) == []


def test_flags_two_near_identical_creditmemos_seconds_apart():
    records = [
        cm(1, "100", 50.0, 1000),
        cm(2, "100", 50.0, 1030),
    ]
    result = detect_duplicate_credit_memos(records)
    assert len(result) == 1
    assert result[0]["orderId"] == "100"
    assert sorted(result[0]["duplicateGroup"]) == [1, 2]
    assert result[0]["totalOverRefund"] == 50.0


def test_does_not_flag_two_legitimate_partial_refunds_far_apart():
    records = [
        cm(1, "100", 30.0, 1000),
        cm(2, "100", 20.0, 1000 + 3600),
    ]
    assert detect_duplicate_credit_memos(records) == []


def test_does_not_flag_different_amounts_close_in_time():
    records = [
        cm(1, "100", 30.0, 1000),
        cm(2, "100", 45.0, 1010),
    ]
    assert detect_duplicate_credit_memos(records) == []


def test_flags_three_way_duplicate_and_sums_excess():
    records = [
        cm(1, "200", 20.0, 5000),
        cm(2, "200", 20.0, 5015),
        cm(3, "200", 20.0, 5040),
    ]
    result = detect_duplicate_credit_memos(records)
    assert len(result) == 1
    assert sorted(result[0]["duplicateGroup"]) == [1, 2, 3]
    assert result[0]["totalOverRefund"] == 40.0


def test_separate_orders_are_evaluated_independently():
    records = [
        cm(1, "100", 50.0, 1000),
        cm(2, "100", 50.0, 1020),
        cm(3, "200", 50.0, 1000),
    ]
    result = detect_duplicate_credit_memos(records)
    assert len(result) == 1
    assert result[0]["orderId"] == "100"


def test_amount_within_epsilon_still_counts_as_duplicate():
    records = [
        cm(1, "100", 50.00, 1000),
        cm(2, "100", 50.005, 1010),
    ]
    result = detect_duplicate_credit_memos(records, amount_epsilon=0.01)
    assert len(result) == 1


def test_exactly_at_tolerance_boundary_is_flagged():
    records = [
        cm(1, "100", 50.0, 1000),
        cm(2, "100", 50.0, 1060),
    ]
    result = detect_duplicate_credit_memos(records, tolerance_seconds=60)
    assert len(result) == 1


def test_empty_input_returns_empty_list():
    assert detect_duplicate_credit_memos([]) == []
