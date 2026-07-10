from anchor_leak_check import find_leaked_anchor_products


def build_tree():
    return {
        "id": 10,
        "isActive": True,
        "isAnchor": True,
        "children": [
            {
                "id": 11,
                "isActive": False,
                "isAnchor": False,
                "children": [],
            },
            {
                "id": 12,
                "isActive": True,
                "isAnchor": False,
                "children": [],
            },
        ],
    }


PRODUCT_INDEX = {
    "SKU-LEAK": {"status": 1, "visibility": 4},
    "SKU-DISABLED-PRODUCT": {"status": 2, "visibility": 4},
    "SKU-HIDDEN": {"status": 1, "visibility": 1},
}


def test_leaks_enabled_visible_sku_from_disabled_child():
    assignments = {11: [{"sku": "SKU-LEAK"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert leaks == [{"anchorCategoryId": 10, "disabledCategoryId": 11, "sku": "SKU-LEAK"}]


def test_skips_products_from_active_child():
    assignments = {12: [{"sku": "SKU-LEAK"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert leaks == []


def test_skips_disabled_product_even_from_disabled_child():
    assignments = {11: [{"sku": "SKU-DISABLED-PRODUCT"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert leaks == []


def test_skips_not_visible_individually_product():
    assignments = {11: [{"sku": "SKU-HIDDEN"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert leaks == []


def test_skips_sku_missing_from_product_index():
    assignments = {11: [{"sku": "SKU-UNKNOWN"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert leaks == []


def test_dedupes_same_sku_and_anchor():
    assignments = {11: [{"sku": "SKU-LEAK"}, {"sku": "SKU-LEAK"}]}
    leaks = find_leaked_anchor_products(build_tree(), PRODUCT_INDEX, assignments)
    assert len(leaks) == 1


def test_no_leak_when_root_is_not_anchor():
    tree = build_tree()
    tree["isAnchor"] = False
    assignments = {11: [{"sku": "SKU-LEAK"}]}
    leaks = find_leaked_anchor_products(tree, PRODUCT_INDEX, assignments)
    assert leaks == []


def test_nested_disabled_grandchild_attributes_to_nearest_anchor():
    tree = {
        "id": 1,
        "isActive": True,
        "isAnchor": True,
        "children": [
            {
                "id": 2,
                "isActive": True,
                "isAnchor": False,
                "children": [
                    {"id": 3, "isActive": False, "isAnchor": False, "children": []}
                ],
            }
        ],
    }
    assignments = {3: [{"sku": "SKU-LEAK"}]}
    leaks = find_leaked_anchor_products(tree, PRODUCT_INDEX, assignments)
    assert leaks == [{"anchorCategoryId": 1, "disabledCategoryId": 3, "sku": "SKU-LEAK"}]
