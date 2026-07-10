from flag_creditmemo_total_drift import evaluate_creditmemo_total_drift


def creditmemo(**over):
    base = {
        "subtotal": 100.0,
        "discountAmount": 0.0,
        "shippingAmount": 10.0,
        "taxAmount": 8.0,
        "adjustmentPositive": 0.0,
        "adjustmentNegative": 0.0,
        "grandTotal": 118.0,
    }
    base.update(over)
    return base


def test_matching_totals_are_not_drifted():
    result = evaluate_creditmemo_total_drift(creditmemo())
    assert result["isDrifted"] is False
    assert result["expectedGrandTotal"] == 118.0
    assert result["delta"] == 0.0


def test_over_refunded_grand_total_is_drifted():
    result = evaluate_creditmemo_total_drift(creditmemo(grandTotal=140.0))
    assert result["isDrifted"] is True
    assert result["delta"] == 22.0


def test_under_refunded_grand_total_is_drifted():
    result = evaluate_creditmemo_total_drift(creditmemo(grandTotal=100.0))
    assert result["isDrifted"] is True
    assert result["delta"] == -18.0


def test_stale_after_adjustment_fee_typed_but_not_recalculated():
    # Adjustment Fee (adjustment_negative) was typed in but grand_total never moved.
    cm = creditmemo(adjustmentNegative=15.0, grandTotal=118.0)
    result = evaluate_creditmemo_total_drift(cm)
    assert result["isDrifted"] is True
    assert result["expectedGrandTotal"] == 103.0
    assert result["delta"] == 15.0


def test_zero_shipping_still_matches_when_consistent():
    cm = creditmemo(shippingAmount=0.0, grandTotal=108.0)
    result = evaluate_creditmemo_total_drift(cm)
    assert result["isDrifted"] is False


def test_within_epsilon_is_not_drifted():
    result = evaluate_creditmemo_total_drift(creditmemo(grandTotal=118.005), epsilon=0.01)
    assert result["isDrifted"] is False


def test_negative_adjustment_positive_offsets_correctly():
    cm = creditmemo(adjustmentPositive=5.0, grandTotal=123.0)
    result = evaluate_creditmemo_total_drift(cm)
    assert result["isDrifted"] is False
