from detect_pending_payment_mismatch import detect_pending_payment_mismatch


def order(**over):
    base = {
        "entityId": "101",
        "incrementId": "000000101",
        "state": "pending_payment",
        "status": "pending_payment",
        "grandTotal": 150.0,
        "totalPaid": 0.0,
        "totalInvoiced": 0.0,
    }
    base.update(over)
    return base


def invoice(**over):
    base = {"entityId": "501", "orderId": "101", "state": 2, "grandTotal": 150.0}
    base.update(over)
    return base


def test_mismatched_when_paid_invoice_exists():
    result = detect_pending_payment_mismatch(order(), [invoice()])
    assert result["isMismatched"] is True
    assert result["matchedInvoiceId"] == "501"


def test_mismatched_when_totals_already_paid_with_no_invoice():
    o = order(totalPaid=150.0)
    result = detect_pending_payment_mismatch(o, [])
    assert result["isMismatched"] is True
    assert result["matchedInvoiceId"] is None


def test_mismatched_when_total_invoiced_meets_grand_total():
    o = order(totalInvoiced=150.0)
    result = detect_pending_payment_mismatch(o, [])
    assert result["isMismatched"] is True


def test_not_mismatched_when_order_already_processing():
    o = order(state="processing")
    result = detect_pending_payment_mismatch(o, [invoice()])
    assert result["isMismatched"] is False


def test_not_mismatched_when_order_state_new_but_invoice_open():
    o = order(state="new")
    result = detect_pending_payment_mismatch(o, [invoice(state=1)])
    assert result["isMismatched"] is False


def test_not_mismatched_when_invoice_open():
    result = detect_pending_payment_mismatch(order(), [invoice(state=1)])
    assert result["isMismatched"] is False


def test_not_mismatched_when_invoice_cancelled():
    result = detect_pending_payment_mismatch(order(), [invoice(state=3)])
    assert result["isMismatched"] is False


def test_not_mismatched_when_invoice_belongs_to_other_order():
    result = detect_pending_payment_mismatch(order(), [invoice(orderId="999")])
    assert result["isMismatched"] is False


def test_not_mismatched_when_nothing_paid_yet():
    result = detect_pending_payment_mismatch(order(), [])
    assert result["isMismatched"] is False


def test_reason_mentions_matched_invoice_id():
    result = detect_pending_payment_mismatch(order(), [invoice()])
    assert "501" in result["reason"]
