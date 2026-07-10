from flag_status_after_refund import expected_order_status


def totals(**over):
    base = {"totalInvoiced": 100.0, "totalPaid": 100.0, "totalRefunded": 0.0}
    base.update(over)
    return base


def test_nothing_invoiced_yet_is_never_a_mismatch():
    result = expected_order_status(totals(totalInvoiced=0, totalPaid=0), [], "pending")
    assert result["isMismatch"] is False
    assert result["expected"] == "pending"


def test_fully_refunded_but_still_processing_is_a_mismatch():
    result = expected_order_status(totals(totalRefunded=100.0), [{"grandTotal": 100.0}], "processing")
    assert result["expected"] == "closed"
    assert result["isMismatch"] is True


def test_zero_total_memo_covering_full_balance_is_treated_as_fully_refunded():
    result = expected_order_status(totals(totalRefunded=100.0), [{"grandTotal": 0.0}], "complete")
    assert result["expected"] == "closed"
    assert result["isMismatch"] is True


def test_partial_refund_never_forces_closed_on_its_own():
    result = expected_order_status(totals(totalRefunded=40.0), [{"grandTotal": 40.0}], "closed")
    assert result["expected"] == "processing"
    assert result["isMismatch"] is True


def test_partial_refund_leaves_processing_alone():
    result = expected_order_status(totals(totalRefunded=40.0), [{"grandTotal": 40.0}], "processing")
    assert result["expected"] == "processing"
    assert result["isMismatch"] is False


def test_already_closed_and_fully_refunded_is_not_a_mismatch():
    result = expected_order_status(totals(totalRefunded=100.0), [{"grandTotal": 100.0}], "closed")
    assert result["isMismatch"] is False


def test_no_refund_at_all_is_not_a_mismatch():
    result = expected_order_status(totals(), [], "processing")
    assert result["isMismatch"] is False


def test_partial_bundle_item_memo_below_full_balance_is_not_fully_refunded():
    result = expected_order_status(totals(totalRefunded=25.0), [{"grandTotal": 25.0}], "processing")
    assert result["expected"] == "processing"
    assert result["isMismatch"] is False


def test_epsilon_tolerates_tiny_float_rounding_as_fully_refunded():
    result = expected_order_status(totals(totalRefunded=99.995), [{"grandTotal": 99.995}], "processing")
    assert result["expected"] == "closed"
    assert result["isMismatch"] is True
