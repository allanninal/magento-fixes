# Admin or integration tokens expire and silently break automation

A script or cron job that calls `POST /rest/V1/integration/admin/token` once and caches the bearer token works fine for a while, because that token behaves like a login session with a default four hour lifetime (Admin Token Lifetime under Stores, Configuration, Services, OAuth, Access Token Expiration). An hourly cron job purges expired rows from `admin_bearer_token`, so once the clock runs out every REST call gets rejected with a plain HTTP 401, which automation can easily log and swallow instead of alerting anyone.

This script probes a cheap, side-effect-free endpoint (`GET /V1/store/storeConfigs`), classifies any failure with a pure function, and re-authenticates exactly once when the token has genuinely expired. If the token is rejected while still within its configured lifetime, or the same failure recurs after a refresh, the script stops and reports instead of retrying, since repeatedly hammering the token endpoint with bad credentials risks tripping Magento's admin account lockout.

**Full guide with diagrams:** https://www.allanninal.dev/magento/admin-token-expiry-breaks-automation/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export MAGENTO_ADMIN_USER="automation-user"
export MAGENTO_ADMIN_PASS="change-me"
export ADMIN_TOKEN_LIFETIME_HOURS="4"
export DRY_RUN="true"

python admin-token-expiry-breaks-automation/python/detect_token_expiry.py
node   admin-token-expiry-breaks-automation/node/detect-token-expiry.js
```

`classify_token_failure` (Python) and `classifyTokenFailure` (Node) are pure functions: given the HTTP status, response body, when the token was issued, the current time, and the configured lifetime, they return `"OK"`, `"EXPIRED_REAUTH"`, `"REVOKED_OR_INVALID"`, or `"LOCKOUT_RISK"`. Only `"EXPIRED_REAUTH"` triggers an automatic re-authentication, and only once per run. Everything else stops the script so a human can look at it. The durable long term fix is a permanent Integration token created under System, Extensions, Integrations with explicit API resource ACLs, since it removes the expiry clock entirely.

## Test

```bash
pytest admin-token-expiry-breaks-automation/python
node --test admin-token-expiry-breaks-automation/node
```
