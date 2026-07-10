from find_duplicate_increment_ids import find_duplicate_increment_ids


def order(**over):
    base = {
        "entityId": 501,
        "incrementId": "000000045",
        "storeId": 1,
        "createdAt": "2026-07-01T10:00:00Z",
    }
    base.update(over)
    return base


def test_no_duplicates_when_all_increment_ids_unique():
    orders = [order(entityId=1, incrementId="1"), order(entityId=2, incrementId="2")]
    assert find_duplicate_increment_ids(orders) == []


def test_detects_collision_across_two_entity_ids():
    orders = [
        order(entityId=501, incrementId="000000045", createdAt="2026-07-01T10:00:00Z"),
        order(entityId=812, incrementId="000000045", createdAt="2026-07-02T09:00:00Z"),
    ]
    result = find_duplicate_increment_ids(orders)
    assert len(result) == 1
    assert result[0]["incrementId"] == "000000045"
    assert len(result[0]["members"]) == 2


def test_same_entity_id_repeated_is_not_a_collision():
    orders = [order(entityId=501, incrementId="000000045"), order(entityId=501, incrementId="000000045")]
    assert find_duplicate_increment_ids(orders) == []


def test_members_sorted_by_created_at_ascending():
    orders = [
        order(entityId=812, incrementId="000000045", createdAt="2026-07-02T09:00:00Z"),
        order(entityId=501, incrementId="000000045", createdAt="2026-07-01T10:00:00Z"),
    ]
    result = find_duplicate_increment_ids(orders)
    assert result[0]["members"][0]["entityId"] == 501
    assert result[0]["members"][1]["entityId"] == 812


def test_groups_sorted_by_increment_id_ascending():
    orders = [
        order(entityId=1, incrementId="000000099"), order(entityId=2, incrementId="000000099"),
        order(entityId=3, incrementId="000000010"), order(entityId=4, incrementId="000000010"),
    ]
    result = find_duplicate_increment_ids(orders)
    assert [d["incrementId"] for d in result] == ["000000010", "000000099"]


def test_three_way_collision_is_one_group_with_three_members():
    orders = [
        order(entityId=1, incrementId="000000005", createdAt="2026-07-01T00:00:00Z"),
        order(entityId=2, incrementId="000000005", createdAt="2026-07-02T00:00:00Z"),
        order(entityId=3, incrementId="000000005", createdAt="2026-07-03T00:00:00Z"),
    ]
    result = find_duplicate_increment_ids(orders)
    assert len(result) == 1
    assert len(result[0]["members"]) == 3


def test_empty_input_returns_empty_list():
    assert find_duplicate_increment_ids([]) == []


def test_different_store_ids_still_flagged_as_collision():
    orders = [
        order(entityId=501, incrementId="000000045", storeId=1, createdAt="2026-07-01T10:00:00Z"),
        order(entityId=812, incrementId="000000045", storeId=2, createdAt="2026-07-02T09:00:00Z"),
    ]
    result = find_duplicate_increment_ids(orders)
    assert len(result) == 1
    assert result[0]["members"][0]["storeId"] == 1
    assert result[0]["members"][1]["storeId"] == 2
