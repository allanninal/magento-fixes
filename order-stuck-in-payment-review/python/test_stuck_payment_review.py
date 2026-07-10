import datetime

from reconcile_payment_review import decide_stuck_order_action

NOW = datetime.datetime(2026, 7, 10, 0, 0, 0, tzinfo=datetime.timezone.utc)


def order(**over):
    base = {
        "state": "payment_review",
        "status": "payment_review",
        "createdAt": "2026-07-07 00:00:00",  # 72 hours before NOW
        "totalInvoiced": 0,
        "statusHistories": [],
    }
    base.update(over)
    return base


def test_cancel_when_stuck_past_threshold_no_invoice():
    result = decide_stuck_order_action(order(), NOW, 48)
    assert result == {"action": "cancel", "reason": "no_gateway_callback_within_threshold"}


def test_skip_when_not_payment_review():
    result = decide_stuck_order_action(order(state="processing"), NOW, 48)
    assert result["action"] == "skip"
    assert result["reason"] == "not_in_payment_review"


def test_skip_when_below_age_threshold():
    o = order(createdAt="2026-07-09 12:00:00")  # 12 hours before NOW
    result = decide_stuck_order_action(o, NOW, 48)
    assert result["action"] == "skip"
    assert result["reason"] == "below_age_threshold"


def test_skip_when_status_history_progressed_after_created():
    o = order(statusHistories=[{"createdAt": "2026-07-08 00:00:00"}])
    result = decide_stuck_order_action(o, NOW, 48)
    assert result["action"] == "skip"
    assert result["reason"] == "gateway_callback_already_progressed"


def test_does_not_skip_when_status_history_equals_created_at():
    o = order(statusHistories=[{"createdAt": "2026-07-07 00:00:00"}])
    result = decide_stuck_order_action(o, NOW, 48)
    assert result["action"] == "cancel"


def test_flag_when_payment_captured():
    o = order(totalInvoiced=99.99)
    result = decide_stuck_order_action(o, NOW, 48)
    assert result == {"action": "flag", "reason": "payment_captured_needs_manual_review"}


def test_skip_when_missing_created_at():
    o = order(createdAt=None)
    result = decide_stuck_order_action(o, NOW, 48)
    assert result["action"] == "skip"
    assert result["reason"] == "missing_created_at"


def test_exactly_at_threshold_is_stuck():
    o = order(createdAt="2026-07-08 00:00:00")  # exactly 48 hours before NOW
    result = decide_stuck_order_action(o, NOW, 48)
    assert result["action"] == "cancel"
