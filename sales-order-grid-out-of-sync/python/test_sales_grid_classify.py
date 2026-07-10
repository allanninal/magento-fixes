from flag_grid_sync_drift import classify_order_sync

WATERMARK = "2026-07-10 00:00:00"


def entity(**over):
    base = {
        "entityId": 501,
        "incrementId": "100000501",
        "status": "processing",
        "updatedAt": "2026-07-09 12:00:00",
        "grandTotal": 129.99,
    }
    base.update(over)
    return base


def grid(**over):
    base = {
        "entityId": 501,
        "incrementId": "100000501",
        "status": "processing",
        "updatedAt": "2026-07-09 12:00:00",
        "grandTotal": 129.99,
    }
    base.update(over)
    return base


def test_missing_and_due_is_flagged():
    result = classify_order_sync(entity(), None, WATERMARK)
    assert result["driftType"] == "MISSING_FROM_GRID"
    assert result["action"] == "FLAG_REINDEX"


def test_missing_but_not_due_is_ok():
    result = classify_order_sync(entity(updatedAt="2026-07-10 08:00:00"), None, WATERMARK)
    assert result["driftType"] == "OK"
    assert result["action"] == "NONE"


def test_status_drift_is_flagged():
    result = classify_order_sync(entity(), grid(status="pending"), WATERMARK)
    assert result["driftType"] == "STALE_STATUS"
    assert result["action"] == "FLAG_REINDEX"


def test_total_drift_is_flagged():
    result = classify_order_sync(entity(), grid(grandTotal=89.99), WATERMARK)
    assert result["driftType"] == "STALE_TOTAL"
    assert result["action"] == "FLAG_REINDEX"


def test_matched_rows_are_ok():
    result = classify_order_sync(entity(), grid(), WATERMARK)
    assert result["driftType"] == "OK"
    assert result["action"] == "NONE"


def test_entity_id_is_preserved_in_result():
    result = classify_order_sync(entity(entityId=777), None, WATERMARK)
    assert result["entityId"] == 777


def test_exactly_at_watermark_is_flagged():
    result = classify_order_sync(entity(updatedAt=WATERMARK), None, WATERMARK)
    assert result["driftType"] == "MISSING_FROM_GRID"


def test_status_checked_before_total_when_both_differ():
    result = classify_order_sync(entity(), grid(status="pending", grandTotal=1.0), WATERMARK)
    assert result["driftType"] == "STALE_STATUS"
