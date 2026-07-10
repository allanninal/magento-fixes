from flag_cron_email_backlog import classify_cron_email_backlog

NOW = "2026-07-10T12:00:00Z"


def order(**over):
    base = {
        "entityId": 501,
        "incrementId": "100000501",
        "createdAt": "2026-07-10T11:00:00Z",  # 60 minutes old
        "status": "processing",
    }
    base.update(over)
    return base


def test_no_stale_orders_when_all_recent():
    result = classify_cron_email_backlog([order(createdAt="2026-07-10T11:55:00Z")], NOW, 30, 5)
    assert result["staleOrders"] == []
    assert result["cronLikelyDown"] is False


def test_stale_order_past_threshold():
    result = classify_cron_email_backlog([order()], NOW, 30, 5)
    assert len(result["staleOrders"]) == 1
    assert result["staleOrders"][0]["incrementId"] == "100000501"


def test_canceled_orders_are_excluded():
    result = classify_cron_email_backlog([order(status="canceled")], NOW, 30, 5)
    assert result["staleOrders"] == []


def test_cron_likely_down_when_backlog_count_reached():
    orders = [order(entityId=i, incrementId=str(i)) for i in range(5)]
    result = classify_cron_email_backlog(orders, NOW, 30, 5)
    assert result["cronLikelyDown"] is True


def test_cron_likely_down_when_one_order_extremely_overdue():
    result = classify_cron_email_backlog(
        [order(createdAt="2026-07-10T09:00:00Z")], NOW, 30, 5  # 180 minutes overdue
    )
    assert result["cronLikelyDown"] is True


def test_not_cron_likely_down_with_small_recent_backlog():
    result = classify_cron_email_backlog([order()], NOW, 30, 5)
    assert result["cronLikelyDown"] is False


def test_stale_orders_sorted_by_minutes_overdue_descending():
    orders = [
        order(entityId=1, incrementId="1", createdAt="2026-07-10T11:00:00Z"),
        order(entityId=2, incrementId="2", createdAt="2026-07-10T10:00:00Z"),
    ]
    result = classify_cron_email_backlog(orders, NOW, 30, 5)
    assert [o["incrementId"] for o in result["staleOrders"]] == ["2", "1"]


def test_exactly_at_threshold_is_not_stale():
    result = classify_cron_email_backlog(
        [order(createdAt="2026-07-10T11:30:00Z")], NOW, 30, 5  # exactly 30 minutes
    )
    assert result["staleOrders"] == []


def test_closed_status_is_not_excluded_by_classifier():
    # The API call excludes closed via searchCriteria; the pure classifier only
    # excludes the terminal set it knows about (canceled), so a closed order
    # reaching it would still be evaluated on age alone.
    result = classify_cron_email_backlog([order(status="closed")], NOW, 30, 5)
    assert len(result["staleOrders"]) == 1
