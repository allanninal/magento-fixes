from url_rewrite_missing import is_url_rewrite_missing


def product(**over):
    base = {"sku": "GREEN-SHIRT", "urlKey": "green-shirt", "storeIds": [1]}
    base.update(over)
    return base


def test_no_gap_when_expected_path_already_known():
    existing = {1: {"green-shirt.html"}}
    result = is_url_rewrite_missing(product(), ".html", existing)
    assert result == []


def test_flags_missing_when_store_has_no_matching_path():
    existing = {1: set()}
    result = is_url_rewrite_missing(product(), ".html", existing)
    assert result == [{"sku": "GREEN-SHIRT", "storeId": 1, "expectedPath": "green-shirt.html"}]


def test_flags_missing_when_store_id_absent_from_map():
    existing = {}
    result = is_url_rewrite_missing(product(), ".html", existing)
    assert result == [{"sku": "GREEN-SHIRT", "storeId": 1, "expectedPath": "green-shirt.html"}]


def test_checks_every_store_the_product_belongs_to():
    p = product(storeIds=[1, 2])
    existing = {1: {"green-shirt.html"}, 2: set()}
    result = is_url_rewrite_missing(p, ".html", existing)
    assert result == [{"sku": "GREEN-SHIRT", "storeId": 2, "expectedPath": "green-shirt.html"}]


def test_no_stores_means_no_gaps():
    p = product(storeIds=[])
    result = is_url_rewrite_missing(p, ".html", {})
    assert result == []


def test_respects_a_custom_suffix():
    existing = {1: {"green-shirt.htm"}}
    result = is_url_rewrite_missing(product(), ".htm", existing)
    assert result == []


def test_wrong_suffix_in_existing_paths_is_still_a_gap():
    existing = {1: {"green-shirt.htm"}}
    result = is_url_rewrite_missing(product(), ".html", existing)
    assert result == [{"sku": "GREEN-SHIRT", "storeId": 1, "expectedPath": "green-shirt.html"}]


def test_multiple_stores_all_missing_reports_each():
    p = product(storeIds=[1, 2, 3])
    existing = {1: set(), 2: set(), 3: set()}
    result = is_url_rewrite_missing(p, ".html", existing)
    assert result == [
        {"sku": "GREEN-SHIRT", "storeId": 1, "expectedPath": "green-shirt.html"},
        {"sku": "GREEN-SHIRT", "storeId": 2, "expectedPath": "green-shirt.html"},
        {"sku": "GREEN-SHIRT", "storeId": 3, "expectedPath": "green-shirt.html"},
    ]
