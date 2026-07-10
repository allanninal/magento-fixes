from flag_creditmemo_tax_mismatch import is_creditmemo_tax_mismatched, expected_tax_for_creditmemo, build_adjustment_payload


def test_proportional_tax_matches_is_not_mismatched():
    # order item taxed 10.00 across 5 units, refund 2 units, so expect 4.00
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=5,
        creditmemo_item_qty=2, creditmemo_base_tax_amount=4.00,
    )
    assert result["expectedTax"] == 4.00
    assert result["mismatched"] is False


def test_within_epsilon_is_not_mismatched():
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=5,
        creditmemo_item_qty=2, creditmemo_base_tax_amount=4.005,
    )
    assert result["mismatched"] is False


def test_full_order_tax_on_partial_refund_is_mismatched():
    # tell tale bug: partial refund of 2 of 5 carries the full 10.00 order tax
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=5,
        creditmemo_item_qty=2, creditmemo_base_tax_amount=10.00,
    )
    assert result["expectedTax"] == 4.00
    assert result["delta"] == 6.00
    assert result["mismatched"] is True


def test_over_refunded_tax_is_mismatched_with_negative_delta():
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=5,
        creditmemo_item_qty=2, creditmemo_base_tax_amount=1.00,
    )
    assert result["delta"] == -3.00
    assert result["mismatched"] is True


def test_zero_qty_ordered_guarded_to_zero_expected_tax():
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=0,
        creditmemo_item_qty=0, creditmemo_base_tax_amount=0,
    )
    assert result["expectedTax"] == 0.0
    assert result["mismatched"] is False


def test_custom_epsilon_is_respected():
    result = is_creditmemo_tax_mismatched(
        order_item_tax_amount=10.00, order_item_qty_ordered=5,
        creditmemo_item_qty=2, creditmemo_base_tax_amount=4.08,
        epsilon=0.1,
    )
    assert result["mismatched"] is False


def test_expected_tax_for_creditmemo_sums_multiple_lines():
    order_items_by_id = {
        101: {"tax_amount": 10.00, "qty_ordered": 5},
        102: {"tax_amount": 6.00, "qty_ordered": 3},
    }
    creditmemo = {
        "items": [
            {"order_item_id": 101, "qty": 2},
            {"order_item_id": 102, "qty": 1},
        ]
    }
    expected = expected_tax_for_creditmemo(order_items_by_id, creditmemo)
    assert round(expected, 4) == round(4.00 + 2.00, 4)


def test_expected_tax_for_creditmemo_skips_unknown_order_item():
    order_items_by_id = {101: {"tax_amount": 10.00, "qty_ordered": 5}}
    creditmemo = {"items": [{"order_item_id": 999, "qty": 1}]}
    assert expected_tax_for_creditmemo(order_items_by_id, creditmemo) == 0.0


def test_build_adjustment_payload_positive_delta_uses_adjustment_negative():
    payload = build_adjustment_payload(6.00)
    assert payload == {"arguments": {"adjustment_negative": 6.00}}


def test_build_adjustment_payload_negative_delta_uses_adjustment_positive():
    payload = build_adjustment_payload(-3.00)
    assert payload == {"arguments": {"adjustment_positive": 3.00}}
