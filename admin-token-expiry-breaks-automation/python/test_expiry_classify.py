import datetime
from detect_token_expiry import classify_token_failure

ISSUED = datetime.datetime(2026, 7, 10, 8, 0, tzinfo=datetime.timezone.utc)


def hours_later(h):
    return ISSUED + datetime.timedelta(hours=h)


def test_ok_on_200():
    assert classify_token_failure(200, {}, ISSUED, hours_later(1), 4) == "OK"


def test_expired_reauth_after_lifetime():
    body = {"message": "Unauthorized"}
    assert classify_token_failure(401, body, ISSUED, hours_later(5), 4) == "EXPIRED_REAUTH"


def test_revoked_when_within_lifetime():
    body = {"message": "The consumer isn't authorized to access %resources"}
    assert classify_token_failure(401, body, ISSUED, hours_later(1), 4) == "REVOKED_OR_INVALID"


def test_exactly_at_lifetime_is_expired():
    assert classify_token_failure(401, {}, ISSUED, hours_later(4), 4) == "EXPIRED_REAUTH"


def test_just_under_lifetime_is_revoked_or_invalid():
    assert classify_token_failure(401, {}, ISSUED, hours_later(3.9), 4) == "REVOKED_OR_INVALID"


def test_lockout_risk_when_retry_threshold_hit():
    assert classify_token_failure(401, {}, ISSUED, hours_later(5), 4, retry_count=1, retry_threshold=1) == "LOCKOUT_RISK"


def test_lockout_risk_takes_priority_over_expired():
    # Even though the token is old enough to look like a normal expiry, if the
    # retry threshold was already hit we must stop instead of refreshing again.
    assert classify_token_failure(401, {}, ISSUED, hours_later(10), 4, retry_count=2, retry_threshold=1) == "LOCKOUT_RISK"


def test_non_401_non_200_treated_as_revoked_or_invalid():
    assert classify_token_failure(500, {}, ISSUED, hours_later(1), 4) == "REVOKED_OR_INVALID"


def test_zero_age_with_401_is_revoked_or_invalid():
    assert classify_token_failure(401, {}, ISSUED, ISSUED, 4) == "REVOKED_OR_INVALID"
