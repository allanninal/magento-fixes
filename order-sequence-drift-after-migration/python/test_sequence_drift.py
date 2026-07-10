from detect_sequence_drift import detect_sequence_drift, strip_prefix


def order(**over):
    base = {"entityId": 1, "storeId": 1, "incrementId": "100000001", "createdAt": "2026-07-01 00:00:00"}
    base.update(over)
    return base


def test_no_drift_on_clean_sequential_orders():
    orders = [
        order(entityId=1, incrementId="100000001"),
        order(entityId=2, incrementId="100000002"),
        order(entityId=3, incrementId="100000003"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert result["duplicates"] == []
    assert result["gaps"] == []
    assert result["maxNumericByStore"][1] == 100000003


def test_duplicate_increment_id_across_two_entity_ids():
    orders = [
        order(entityId=10, incrementId="100000050"),
        order(entityId=11, incrementId="100000050"),
        order(entityId=12, incrementId="100000051"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert len(result["duplicates"]) == 1
    assert result["duplicates"][0]["entityIds"] == [10, 11]
    assert result["duplicates"][0]["incrementId"] == "100000050"


def test_gap_beyond_threshold_is_flagged():
    orders = [
        order(entityId=1, incrementId="100004521"),
        order(entityId=2, incrementId="100009000"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert len(result["gaps"]) == 1
    assert result["gaps"][0]["fromIncrement"] == 100004521
    assert result["gaps"][0]["toIncrement"] == 100009000
    assert result["gaps"][0]["gapSize"] == 4479


def test_gap_within_threshold_is_not_flagged():
    orders = [
        order(entityId=1, incrementId="100000001"),
        order(entityId=2, incrementId="100000500"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert result["gaps"] == []


def test_stores_are_isolated_from_each_other():
    orders = [
        order(entityId=1, storeId=1, incrementId="100000001"),
        order(entityId=2, storeId=2, incrementId="200000001"),
        order(entityId=3, storeId=2, incrementId="200000001"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert len(result["duplicates"]) == 1
    assert result["duplicates"][0]["storeId"] == 2
    assert result["maxNumericByStore"][1] == 100000001


def test_strip_prefix_handles_store_prefix():
    assert strip_prefix("ORD-000123", "ORD-") == 123


def test_strip_prefix_handles_no_prefix():
    assert strip_prefix("100000042", "") == 100000042


def test_max_numeric_by_store_recommends_reset_value():
    orders = [
        order(entityId=1, incrementId="100000001"),
        order(entityId=2, incrementId="100000099"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    recommended_reset = result["maxNumericByStore"][1] + 1
    assert recommended_reset == 100000100


def test_single_order_has_no_gaps_or_duplicates():
    orders = [order(entityId=1, incrementId="100000001")]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert result["duplicates"] == []
    assert result["gaps"] == []
    assert result["maxNumericByStore"][1] == 100000001


def test_three_way_duplicate_reports_all_entity_ids():
    orders = [
        order(entityId=1, incrementId="100000010"),
        order(entityId=2, incrementId="100000010"),
        order(entityId=3, incrementId="100000010"),
    ]
    result = detect_sequence_drift(orders, {}, gap_threshold=1000)
    assert len(result["duplicates"]) == 1
    assert result["duplicates"][0]["entityIds"] == [1, 2, 3]
