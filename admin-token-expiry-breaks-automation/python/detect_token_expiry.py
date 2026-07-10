"""Detect a silently expired or revoked Magento admin token and recover safely.

POST /rest/V1/integration/admin/token returns a session style bearer token with a
default four hour lifetime (Admin Token Lifetime under Stores, Configuration,
Services, OAuth, Access Token Expiration), and an hourly cron purges expired rows
from admin_bearer_token. A script that caches the token once works fine until it
expires, then every call fails with a plain HTTP 401 that is easy to swallow silently.

This script probes a cheap, side-effect-free endpoint, classifies the result with a
pure function, and re-authenticates exactly once on a genuine expiry. Anything else,
including a repeated failure right after refreshing, stops the run and reports it
instead of looping, since repeated bad logins risk tripping the admin account lockout.

DRY_RUN defaults to true. Only the network calls inside run() touch a real store,
so classify_token_failure can be imported and tested with no store and no network.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_token_expiry")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USER = os.environ.get("MAGENTO_ADMIN_USER", "")
ADMIN_PASS = os.environ.get("MAGENTO_ADMIN_PASS", "")
LIFETIME_HOURS = float(os.environ.get("ADMIN_TOKEN_LIFETIME_HOURS", "4"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RETRY_THRESHOLD = 1


def classify_token_failure(http_status, response_body, token_issued_at, now, configured_lifetime_hours, retry_count=0, retry_threshold=RETRY_THRESHOLD):
    """Pure decision logic, no I/O.

    Returns one of "OK", "EXPIRED_REAUTH", "REVOKED_OR_INVALID", "LOCKOUT_RISK".
    """
    if http_status == 200:
        return "OK"
    if http_status == 401:
        age_hours = (now - token_issued_at).total_seconds() / 3600
        if retry_count >= retry_threshold:
            return "LOCKOUT_RISK"
        if age_hours >= configured_lifetime_hours:
            return "EXPIRED_REAUTH"
        return "REVOKED_OR_INVALID"
    return "REVOKED_OR_INVALID"


def get_with_status(path, token, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    try:
        body = r.json()
    except ValueError:
        body = {}
    return r.status_code, body


def probe_token(token):
    return get_with_status("/store/storeConfigs", token)


def get_new_admin_token(username, password):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/integration/admin/token",
        json={"username": username, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Re-authentication failed with status {r.status_code}")
    return r.json()


def run():
    token = os.environ.get("MAGENTO_ADMIN_TOKEN", "")
    token_issued_at = datetime.datetime.fromisoformat(
        os.environ.get("TOKEN_ISSUED_AT", datetime.datetime.now(datetime.timezone.utc).isoformat())
    )
    retry_count = 0

    while True:
        now = datetime.datetime.now(datetime.timezone.utc)
        status, body = probe_token(token)
        outcome = classify_token_failure(status, body, token_issued_at, now, LIFETIME_HOURS, retry_count, RETRY_THRESHOLD)

        if outcome == "OK":
            log.info("Token is valid. Automation can proceed.")
            return

        if outcome == "EXPIRED_REAUTH":
            log.warning("Token expired after its configured lifetime. %s",
                        "Would re-authenticate." if DRY_RUN else "Re-authenticating.")
            if DRY_RUN:
                return
            new_token = get_new_admin_token(ADMIN_USER, ADMIN_PASS)
            token = new_token if isinstance(new_token, str) else new_token.get("token", token)
            token_issued_at = now
            retry_count += 1
            continue

        if outcome == "REVOKED_OR_INVALID":
            log.error("Job admin-token-expiry-breaks-automation: token rejected while still within its "
                      "configured lifetime at %s. 401 payload: %s. Flagging for manual review, not retrying.",
                      now.isoformat(), body)
            return

        log.error("Job admin-token-expiry-breaks-automation: repeated failure at %s after a refresh attempt. "
                  "Stopping to avoid the admin account lockout. 401 payload: %s", now.isoformat(), body)
        return


if __name__ == "__main__":
    run()
