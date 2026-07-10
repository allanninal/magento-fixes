from reconcile_coupon_tax import reconcile_order_tax


def base_order(**over):
    order = {
        "baseSubtotal": 100.0,
        "baseDiscountAmount": 0.0,
        "baseTaxAmount": 10.0,
        "baseShippingAmount": 0.0,
        "baseShippingTaxAmount": 0.0,
        "baseShippingDiscountAmount": 0.0,
        "baseGrandTotal": 110.0,
        "items": [{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 0.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 10.0,
        }],
    }
    order.update(over)
    return order


def test_no_coupon_order_reconciles():
    result = reconcile_order_tax(base_order())
    assert result["ok"] is True
    assert result["expectedTax"] == 10.0
    assert result["taxDelta"] == 0.0


def test_percentage_coupon_with_correct_compensation_reconciles():
    # 20% off a 100 row, tax compensation correctly reduces the taxable base
    order = base_order(
        baseDiscountAmount=20.0,
        baseTaxAmount=8.0,
        baseGrandTotal=88.0,
        items=[{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 20.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 8.0,
        }],
    )
    result = reconcile_order_tax(order)
    assert result["ok"] is True
    assert result["expectedTax"] == 8.0


def test_fixed_amount_coupon_bug_leaves_tax_on_pre_discount_base():
    # discount collector reduced the row, but tax collector still taxed the
    # full pre discount 100 instead of the discounted 90
    order = base_order(
        baseDiscountAmount=10.0,
        baseTaxAmount=10.0,
        baseGrandTotal=100.0,
        items=[{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 10.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 10.0,
        }],
    )
    result = reconcile_order_tax(order)
    assert result["ok"] is False
    assert result["expectedTax"] == 9.0
    assert result["taxDelta"] == 1.0


def test_tax_inclusive_price_order_with_missing_compensation_is_flagged():
    order = base_order(
        baseDiscountAmount=15.0,
        baseTaxAmount=10.0,
        baseGrandTotal=95.0,
        items=[{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 15.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 10.0,
        }],
    )
    result = reconcile_order_tax(order)
    assert result["ok"] is False
    assert result["expectedTax"] == 8.5


def test_within_epsilon_is_ok():
    order = base_order(baseTaxAmount=10.004, baseGrandTotal=110.004)
    result = reconcile_order_tax(order, epsilon=0.01)
    assert result["ok"] is True


def test_per_item_deltas_reported():
    order = base_order(
        items=[{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 10.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 10.0,
        }],
        baseDiscountAmount=10.0,
    )
    result = reconcile_order_tax(order)
    assert result["perItemDeltas"][0]["expectedItemTax"] == 9.0
    assert result["perItemDeltas"][0]["delta"] == 1.0


def test_correctly_compensated_tax_inclusive_order_reconciles():
    # discount_tax_compensation_amount correctly restores the taxable base
    # after a fixed discount on a tax inclusive priced item
    order = base_order(
        baseDiscountAmount=10.0,
        baseTaxAmount=9.0,
        baseGrandTotal=99.0,
        items=[{
            "baseRowTotal": 100.0,
            "baseDiscountAmount": 10.0,
            "baseDiscountTaxCompensationAmount": 0.0,
            "taxPercent": 10.0,
            "baseTaxAmount": 9.0,
        }],
    )
    result = reconcile_order_tax(order)
    assert result["ok"] is True
    assert result["expectedTax"] == 9.0


def test_multiple_items_sum_expected_tax():
    order = base_order(
        baseSubtotal=200.0,
        baseDiscountAmount=20.0,
        baseTaxAmount=18.0,
        baseGrandTotal=198.0,
        items=[
            {
                "baseRowTotal": 100.0,
                "baseDiscountAmount": 10.0,
                "baseDiscountTaxCompensationAmount": 0.0,
                "taxPercent": 10.0,
                "baseTaxAmount": 9.0,
            },
            {
                "baseRowTotal": 100.0,
                "baseDiscountAmount": 10.0,
                "baseDiscountTaxCompensationAmount": 0.0,
                "taxPercent": 10.0,
                "baseTaxAmount": 9.0,
            },
        ],
    )
    result = reconcile_order_tax(order)
    assert result["ok"] is True
    assert result["expectedTax"] == 18.0
