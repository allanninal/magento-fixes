from flag_salable_qty_oversell import decide_salable_qty_action

CONFIG_NO_BACKORDERS = {"manageStock": True, "backorders": 0}
CONFIG_BACKORDERS = {"manageStock": True, "backorders": 1}


def test_ok_when_consistent():
    result = decide_salable_qty_action("SKU-1", 5, 10, 5, CONFIG_NO_BACKORDERS)
    assert result["flag"] is False
    assert result["severity"] == "ok"


def test_warning_when_manage_stock_disabled():
    config = {"manageStock": False, "backorders": 0}
    result = decide_salable_qty_action("SKU-1", 5, 10, 5, config)
    assert result["flag"] is True
    assert result["severity"] == "warning"


def test_critical_when_negative_and_backorders_disabled():
    result = decide_salable_qty_action("SKU-1", -2, 10, 12, CONFIG_NO_BACKORDERS)
    assert result["flag"] is True
    assert result["severity"] == "critical"
    assert "backorders disabled" in result["reason"]


def test_ok_when_negative_and_backorders_enabled_matching_demand():
    result = decide_salable_qty_action("SKU-1", -3, 10, 13, CONFIG_BACKORDERS)
    assert result["flag"] is False
    assert result["severity"] == "ok"


def test_critical_when_negative_backorders_enabled_but_exceeds_demand():
    result = decide_salable_qty_action("SKU-1", -50, 10, 5, CONFIG_BACKORDERS)
    assert result["flag"] is True
    assert result["severity"] == "critical"
    assert "phantom" in result["reason"]


def test_warning_when_salable_does_not_reconcile():
    result = decide_salable_qty_action("SKU-1", 8, 10, 5, CONFIG_NO_BACKORDERS)
    assert result["flag"] is True
    assert result["severity"] == "warning"
    assert "does not reconcile" in result["reason"]


def test_ok_when_reconciles_within_tolerance():
    result = decide_salable_qty_action("SKU-1", 5, 10, 5, CONFIG_NO_BACKORDERS, tolerance_units=0)
    assert result["flag"] is False


def test_manage_stock_check_takes_priority_over_negative_backorders():
    config = {"manageStock": False, "backorders": 0}
    result = decide_salable_qty_action("SKU-1", -100, 10, 5, config)
    assert result["severity"] == "warning"
    assert "manage_stock disabled" in result["reason"]


def test_exactly_at_phantom_reservation_boundary_is_ok():
    # abs(salable) == open_order_qty_total + physical_qty is NOT > so it stays ok
    result = decide_salable_qty_action("SKU-1", -15, 10, 5, CONFIG_BACKORDERS)
    assert result["flag"] is False
    assert result["severity"] == "ok"
