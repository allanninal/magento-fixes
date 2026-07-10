from find_missing_category_assignments import find_missing_category_assignments


def test_reports_assigned_sku_missing_from_index():
    assert find_missing_category_assignments(["SKU-1"], [], {}) == ["SKU-1"]


def test_ignores_sku_present_in_index():
    assert find_missing_category_assignments(["SKU-1"], ["SKU-1"], {}) == []


def test_excludes_disabled_product():
    status = {"SKU-1": {"status": 2, "visibility": 4}}
    assert find_missing_category_assignments(["SKU-1"], [], status) == []


def test_excludes_not_visible_individually():
    status = {"SKU-1": {"status": 1, "visibility": 1}}
    assert find_missing_category_assignments(["SKU-1"], [], status) == []


def test_keeps_enabled_and_visible_product_missing_from_index():
    status = {"SKU-1": {"status": 1, "visibility": 4}}
    assert find_missing_category_assignments(["SKU-1"], [], status) == ["SKU-1"]


def test_handles_multiple_skus_mixed_outcomes():
    assigned = ["SKU-1", "SKU-2", "SKU-3"]
    indexed = ["SKU-2"]
    status = {"SKU-1": {"status": 1, "visibility": 4}, "SKU-3": {"status": 2, "visibility": 4}}
    assert find_missing_category_assignments(assigned, indexed, status) == ["SKU-1"]


def test_empty_assigned_list_returns_empty():
    assert find_missing_category_assignments([], ["SKU-9"], {}) == []


def test_missing_status_entry_defaults_to_reported():
    # No entry in product_status_by_sku means we could not rule it out, so it is reported.
    assert find_missing_category_assignments(["SKU-1"], [], {}) == ["SKU-1"]
