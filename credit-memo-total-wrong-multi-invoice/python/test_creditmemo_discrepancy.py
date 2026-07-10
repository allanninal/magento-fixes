from flag_creditmemo_discrepancy import decide_credit_memo_discrepancy


def invoice(**over):
    base = {
        "entityId": 900,
        "baseGrandTotal": 220.00,
        "baseTaxAmount": 20.00,
        "items": [
            {"itemId": 1, "qtyInvoiced": 2.0, "baseTaxAmount": 20.00, "baseRowTotal": 200.00},
        ],
    }
    base.update(over)
    return base


def credit_memo(**over):
    base = {
        "entityId": 700,
        "incrementId": "100000700",
        "invoiceId": 900,
        "baseGrandTotal": 110.00,
        "baseTaxAmount": 10.00,
        "baseShippingAmount": 0.0,
        "adjustmentPositive": 0.0,
        "adjustmentNegative": 0.0,
        "items": [
            {"itemId": 1, "qtyRefunded": 1.0, "baseRowTotal": 100.00, "baseTaxAmount": 10.00},
        ],
    }
    base.update(over)
    return base


def test_matched_credit_memo_is_ok():
    result = decide_credit_memo_discrepancy(credit_memo(), invoice(), [])
    assert result["reason"] == "ok"
    assert result["isDiscrepant"] is False


def test_tax_mismatch_is_flagged():
    cm = credit_memo(baseTaxAmount=20.00, baseGrandTotal=120.00)
    result = decide_credit_memo_discrepancy(cm, invoice(), [])
    assert result["reason"] == "tax_mismatch"
    assert result["isDiscrepant"] is True
    assert result["expectedTaxAmount"] == 10.00


def test_grand_total_mismatch_is_flagged():
    cm = credit_memo(baseShippingAmount=15.00, baseGrandTotal=110.00)
    result = decide_credit_memo_discrepancy(cm, invoice(), [])
    assert result["reason"] == "grand_total_mismatch"
    assert result["isDiscrepant"] is True


def test_over_refund_beats_other_reasons():
    prior = [{"baseGrandTotal": 150.00}]
    cm = credit_memo(baseGrandTotal=110.00)
    result = decide_credit_memo_discrepancy(cm, invoice(), prior)
    assert result["reason"] == "over_refund"
    assert result["isDiscrepant"] is True


def test_within_tolerance_is_ok():
    cm = credit_memo(baseGrandTotal=110.004)
    result = decide_credit_memo_discrepancy(cm, invoice(), [], tolerance_cents=0.01)
    assert result["reason"] == "ok"


def test_expected_totals_prorate_by_refunded_qty():
    inv = invoice(items=[
        {"itemId": 1, "qtyInvoiced": 4.0, "baseTaxAmount": 40.00, "baseRowTotal": 400.00},
    ])
    cm = credit_memo(items=[
        {"itemId": 1, "qtyRefunded": 1.0, "baseRowTotal": 100.00, "baseTaxAmount": 10.00},
    ], baseGrandTotal=110.00, baseTaxAmount=10.00)
    result = decide_credit_memo_discrepancy(cm, inv, [])
    assert result["expectedTaxAmount"] == 10.00
    assert result["expectedGrandTotal"] == 110.00
    assert result["reason"] == "ok"


def test_missing_invoice_item_falls_back_to_creditmemo_row_total():
    inv = invoice(items=[])
    cm = credit_memo(items=[
        {"itemId": 99, "qtyRefunded": 1.0, "baseRowTotal": 50.00, "baseTaxAmount": 0.0},
    ], baseGrandTotal=50.00, baseTaxAmount=0.0)
    result = decide_credit_memo_discrepancy(cm, inv, [])
    assert result["expectedTaxAmount"] == 0.0
    assert result["expectedGrandTotal"] == 50.00
    assert result["reason"] == "ok"


def test_exactly_at_tolerance_boundary_is_ok():
    cm = credit_memo(baseGrandTotal=110.01)
    result = decide_credit_memo_discrepancy(cm, invoice(), [], tolerance_cents=0.01)
    assert result["reason"] == "ok"
