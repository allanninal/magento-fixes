from flag_premature_closure import classify_premature_closure


def order(**over):
    base = {"status": "closed", "total_paid": 100.0, "total_due": 0.0, "grand_total": 100.0}
    base.update(over)
    return base


def test_closed_and_paid_and_no_due_is_not_premature():
    result = classify_premature_closure(order(), [{"state": 2}], True)
    assert result["isPrematureClosure"] is False


def test_closed_with_open_invoice_and_due_and_shipment_is_premature():
    o = order(total_paid=40.0, total_due=60.0)
    result = classify_premature_closure(o, [{"state": 1}], True)
    assert result["isPrematureClosure"] is True


def test_not_closed_yet_is_not_premature():
    o = order(status="processing", total_paid=40.0, total_due=60.0)
    result = classify_premature_closure(o, [{"state": 1}], True)
    assert result["isPrematureClosure"] is False


def test_open_invoice_but_rounding_zero_due_is_not_premature():
    o = order(total_paid=100.0, total_due=0.00001)
    result = classify_premature_closure(o, [{"state": 1}], True)
    assert result["isPrematureClosure"] is False


def test_no_shipment_is_not_premature():
    o = order(total_paid=40.0, total_due=60.0)
    result = classify_premature_closure(o, [{"state": 1}], False)
    assert result["isPrematureClosure"] is False


def test_no_open_invoice_is_not_premature_even_with_due():
    o = order(total_paid=40.0, total_due=60.0)
    result = classify_premature_closure(o, [{"state": 2}], True)
    assert result["isPrematureClosure"] is False
