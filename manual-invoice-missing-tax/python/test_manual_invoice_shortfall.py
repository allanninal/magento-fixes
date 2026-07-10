from detect_invoice_tax_shortfall import detect_invoice_tax_shortfall


def order(**over):
    base = {"baseGrandTotal": 110.00, "baseTaxAmount": 10.00, "totalDue": 0.00}
    base.update(over)
    return base


def test_two_invoices_second_missing_tax_is_shortfall():
    # invoice 1 covers simple products with its share of tax, invoice 2 (virtual
    # product) drops its 2.00 tax slice per magento2 issue 38978
    invoices = [
        {"baseGrandTotal": 88.00, "baseTaxAmount": 8.00},
        {"baseGrandTotal": 20.00, "baseTaxAmount": 0.00},
    ]
    result = detect_invoice_tax_shortfall(order(totalDue=2.00), invoices)
    assert result["isShortfall"] is True
    assert result["taxDelta"] == 2.00
    assert result["grandTotalDelta"] == 2.00


def test_fully_matched_invoices_is_not_shortfall():
    invoices = [
        {"baseGrandTotal": 88.00, "baseTaxAmount": 8.00},
        {"baseGrandTotal": 22.00, "baseTaxAmount": 2.00},
    ]
    result = detect_invoice_tax_shortfall(order(totalDue=0.00), invoices)
    assert result["isShortfall"] is False


def test_zero_total_due_is_not_shortfall_even_with_tax_delta():
    # a rounding blip in tax with nothing actually owed should not be flagged
    invoices = [{"baseGrandTotal": 110.00, "baseTaxAmount": 8.00}]
    result = detect_invoice_tax_shortfall(order(totalDue=0.00), invoices)
    assert result["isShortfall"] is False


def test_legitimately_uninvoiced_item_is_not_a_tax_shortfall():
    # order still has an un-invoiced item; grand total is short but tax is not
    invoices = [{"baseGrandTotal": 60.00, "baseTaxAmount": 10.00}]
    result = detect_invoice_tax_shortfall(order(totalDue=50.00), invoices)
    assert result["taxDelta"] == 0.00
    assert result["isShortfall"] is False


def test_within_epsilon_is_not_shortfall():
    invoices = [{"baseGrandTotal": 109.995, "baseTaxAmount": 9.995}]
    result = detect_invoice_tax_shortfall(order(totalDue=0.01), invoices, epsilon=0.01)
    assert result["isShortfall"] is False


def test_no_invoices_at_all_with_due_and_tax_is_shortfall():
    result = detect_invoice_tax_shortfall(order(totalDue=110.00), [])
    assert result["isShortfall"] is True
    assert result["invoicedGrandTotal"] == 0
    assert result["invoicedTax"] == 0
