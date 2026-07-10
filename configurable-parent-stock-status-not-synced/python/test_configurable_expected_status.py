from configurable_stock_sync import compute_expected_parent_stock_status


def child(**over):
    base = {"sku": "CHILD-1", "isInStock": True, "salableQty": 5}
    base.update(over)
    return base


def test_true_when_one_child_in_stock_and_salable():
    children = [child(isInStock=False, salableQty=0), child()]
    assert compute_expected_parent_stock_status(children) is True


def test_false_when_all_children_out_of_stock():
    children = [child(isInStock=False, salableQty=0), child(isInStock=False, salableQty=3)]
    assert compute_expected_parent_stock_status(children) is False


def test_false_when_children_empty():
    assert compute_expected_parent_stock_status([]) is False


def test_false_when_in_stock_flag_true_but_qty_zero():
    children = [child(isInStock=True, salableQty=0)]
    assert compute_expected_parent_stock_status(children) is False


def test_false_when_qty_positive_but_flag_false():
    children = [child(isInStock=False, salableQty=10)]
    assert compute_expected_parent_stock_status(children) is False


def test_true_with_floating_point_qty_edge_case():
    children = [child(isInStock=True, salableQty=0.0001)]
    assert compute_expected_parent_stock_status(children) is True


def test_true_when_multiple_children_and_only_last_is_salable():
    children = [
        child(isInStock=False, salableQty=0),
        child(isInStock=True, salableQty=0),
        child(isInStock=True, salableQty=2),
    ]
    assert compute_expected_parent_stock_status(children) is True


def test_false_when_salable_qty_negative():
    children = [child(isInStock=True, salableQty=-1)]
    assert compute_expected_parent_stock_status(children) is False


def test_missing_salable_qty_key_defaults_to_zero():
    children = [{"sku": "CHILD-2", "isInStock": True}]
    assert compute_expected_parent_stock_status(children) is False
