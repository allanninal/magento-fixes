from find_sku_collisions import find_sku_collisions


def product(**over):
    base = {"id": 4501, "sku": "ABC-100", "created_at": "2026-07-01T10:00:00Z"}
    base.update(over)
    return base


def test_no_collisions_when_all_skus_unique():
    products = [product(id=1, sku="A"), product(id=2, sku="B")]
    assert find_sku_collisions(products) == []


def test_detects_collision_across_two_entity_ids():
    products = [
        product(id=4501, sku="ABC-100", created_at="2026-07-01T10:00:00Z"),
        product(id=4502, sku="ABC-100", created_at="2026-07-01T10:00:01Z"),
    ]
    result = find_sku_collisions(products)
    assert len(result) == 1
    assert result[0]["sku"] == "abc-100"
    assert result[0]["entity_ids"] == [4501, 4502]


def test_same_entity_id_repeated_is_not_a_collision():
    products = [product(id=4501, sku="ABC-100"), product(id=4501, sku="ABC-100")]
    assert find_sku_collisions(products) == []


def test_whitespace_and_case_variants_are_treated_as_the_same_sku():
    products = [
        product(id=1, sku="  ABC-100 ", created_at="2026-07-01T10:00:00Z"),
        product(id=2, sku="abc-100", created_at="2026-07-01T10:00:01Z"),
    ]
    result = find_sku_collisions(products)
    assert len(result) == 1
    assert result[0]["sku"] == "abc-100"


def test_entity_ids_sorted_by_created_at_ascending():
    products = [
        product(id=4502, sku="ABC-100", created_at="2026-07-01T10:00:01Z"),
        product(id=4501, sku="ABC-100", created_at="2026-07-01T10:00:00Z"),
    ]
    result = find_sku_collisions(products)
    assert result[0]["entity_ids"] == [4501, 4502]
    assert result[0]["created_at"] == ["2026-07-01T10:00:00Z", "2026-07-01T10:00:01Z"]


def test_groups_sorted_by_sku_ascending():
    products = [
        product(id=1, sku="ZZZ-1"), product(id=2, sku="ZZZ-1"),
        product(id=3, sku="AAA-1"), product(id=4, sku="AAA-1"),
    ]
    result = find_sku_collisions(products)
    assert [c["sku"] for c in result] == ["aaa-1", "zzz-1"]


def test_three_way_collision_is_one_group_with_three_ids():
    products = [
        product(id=1, sku="X-1", created_at="2026-07-01T00:00:00Z"),
        product(id=2, sku="X-1", created_at="2026-07-01T00:00:01Z"),
        product(id=3, sku="X-1", created_at="2026-07-01T00:00:02Z"),
    ]
    result = find_sku_collisions(products)
    assert len(result) == 1
    assert len(result[0]["entity_ids"]) == 3


def test_empty_input_returns_empty_list():
    assert find_sku_collisions([]) == []
