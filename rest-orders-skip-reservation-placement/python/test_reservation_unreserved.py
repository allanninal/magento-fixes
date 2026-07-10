from flag_unreserved_orders import find_unreserved_order_items


def test_fully_reserved_sku_is_not_flagged():
    orders = [{"incrementId": "100000001", "items": [{"sku": "SKU-1", "qtyOrdered": 5}]}]
    findings = find_unreserved_order_items(orders, {"SKU-1": 100}, {"SKU-1": 95})
    assert findings == []


def test_completely_skipped_reservation_is_flagged():
    orders = [{"incrementId": "100000002", "items": [{"sku": "SKU-2", "qtyOrdered": 5}]}]
    findings = find_unreserved_order_items(orders, {"SKU-2": 100}, {"SKU-2": 100})
    assert findings == [{
        "incrementId": "100000002",
        "sku": "SKU-2",
        "qtyOrdered": 5,
        "missingReservationQty": 5,
    }]


def test_partially_reserved_sku_reports_only_the_shortfall():
    orders = [{"incrementId": "100000003", "items": [{"sku": "SKU-3", "qtyOrdered": 10}]}]
    # expected reserved is 10, actual reserved is 100-96=4, shortfall is 6
    findings = find_unreserved_order_items(orders, {"SKU-3": 100}, {"SKU-3": 96})
    assert findings == [{
        "incrementId": "100000003",
        "sku": "SKU-3",
        "qtyOrdered": 10,
        "missingReservationQty": 6,
    }]


def test_shortfall_attributed_to_earliest_orders_first():
    orders = [
        {"incrementId": "100000004", "items": [{"sku": "SKU-4", "qtyOrdered": 3}]},
        {"incrementId": "100000005", "items": [{"sku": "SKU-4", "qtyOrdered": 4}]},
    ]
    # expected reserved is 7, actual reserved is 0, so both orders are short
    findings = find_unreserved_order_items(orders, {"SKU-4": 100}, {"SKU-4": 100})
    assert findings == [
        {"incrementId": "100000004", "sku": "SKU-4", "qtyOrdered": 3, "missingReservationQty": 3},
        {"incrementId": "100000005", "sku": "SKU-4", "qtyOrdered": 4, "missingReservationQty": 4},
    ]


def test_shortfall_smaller_than_first_order_only_flags_that_order():
    orders = [
        {"incrementId": "100000006", "items": [{"sku": "SKU-5", "qtyOrdered": 5}]},
        {"incrementId": "100000007", "items": [{"sku": "SKU-5", "qtyOrdered": 5}]},
    ]
    # expected reserved is 10, actual reserved is 100-97=3, shortfall is 7
    findings = find_unreserved_order_items(orders, {"SKU-5": 100}, {"SKU-5": 97})
    assert findings == [
        {"incrementId": "100000006", "sku": "SKU-5", "qtyOrdered": 5, "missingReservationQty": 5},
        {"incrementId": "100000007", "sku": "SKU-5", "qtyOrdered": 5, "missingReservationQty": 2},
    ]


def test_multiple_skus_are_evaluated_independently():
    orders = [
        {"incrementId": "100000008", "items": [
            {"sku": "SKU-6", "qtyOrdered": 2},
            {"sku": "SKU-7", "qtyOrdered": 3},
        ]},
    ]
    findings = find_unreserved_order_items(
        orders,
        {"SKU-6": 50, "SKU-7": 50},
        {"SKU-6": 48, "SKU-7": 50},
    )
    assert findings == [{
        "incrementId": "100000008",
        "sku": "SKU-7",
        "qtyOrdered": 3,
        "missingReservationQty": 3,
    }]


def test_no_orders_produces_no_findings():
    findings = find_unreserved_order_items([], {}, {})
    assert findings == []


def test_over_reserved_sku_is_not_flagged():
    # actual reserved exceeds expected reserved: not a shortfall, so no finding
    orders = [{"incrementId": "100000009", "items": [{"sku": "SKU-8", "qtyOrdered": 5}]}]
    findings = find_unreserved_order_items(orders, {"SKU-8": 100}, {"SKU-8": 80})
    assert findings == []
