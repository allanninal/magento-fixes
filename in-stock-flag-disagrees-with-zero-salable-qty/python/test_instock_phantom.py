from flag_phantom_in_stock import is_phantom_in_stock


def stock_item(**over):
    base = {"is_in_stock": True, "manage_stock": True}
    base.update(over)
    return base


def test_phantom_when_in_stock_managed_zero_qty_no_backorders():
    assert is_phantom_in_stock(stock_item(), 0, False) is True


def test_phantom_when_salable_qty_negative():
    assert is_phantom_in_stock(stock_item(), -2, False) is True


def test_not_phantom_when_salable_qty_positive():
    assert is_phantom_in_stock(stock_item(), 5, False) is False


def test_not_phantom_when_already_out_of_stock():
    assert is_phantom_in_stock(stock_item(is_in_stock=False), 0, False) is False


def test_not_phantom_when_stock_unmanaged():
    assert is_phantom_in_stock(stock_item(manage_stock=False), 0, False) is False


def test_not_phantom_when_backorders_allowed():
    assert is_phantom_in_stock(stock_item(), 0, True) is False


def test_not_phantom_when_backorders_allowed_and_negative_qty():
    assert is_phantom_in_stock(stock_item(), -5, True) is False


def test_phantom_at_exactly_zero_boundary():
    assert is_phantom_in_stock(stock_item(), 0, False) is True
