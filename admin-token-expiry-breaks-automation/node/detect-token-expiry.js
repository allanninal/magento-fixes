/**
 * Detect a silently expired or revoked Magento admin token and recover safely.
 *
 * POST /rest/V1/integration/admin/token returns a session style bearer token with a
 * default four hour lifetime (Admin Token Lifetime under Stores, Configuration,
 * Services, OAuth, Access Token Expiration), and an hourly cron purges expired rows
 * from admin_bearer_token. A script that caches the token once works fine until it
 * expires, then every call fails with a plain HTTP 401 that is easy to swallow silently.
 *
 * This script probes a cheap, side-effect-free endpoint, classifies the result with a
 * pure function, and re-authenticates exactly once on a genuine expiry. Anything else
 * stops the run and reports it instead of looping, since repeated bad logins risk
 * tripping the admin account lockout.
 *
 * Guide: https://www.allanninal.dev/magento/admin-token-expiry-breaks-automation/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USER = process.env.MAGENTO_ADMIN_USER || "";
const ADMIN_PASS = process.env.MAGENTO_ADMIN_PASS || "";
const LIFETIME_HOURS = Number(process.env.ADMIN_TOKEN_LIFETIME_HOURS || 4);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RETRY_THRESHOLD = 1;

/**
 * Pure decision logic, no I/O.
 * Returns one of "OK", "EXPIRED_REAUTH", "REVOKED_OR_INVALID", "LOCKOUT_RISK".
 */
export function classifyTokenFailure(httpStatus, responseBody, tokenIssuedAt, now, configuredLifetimeHours, retryCount = 0, retryThreshold = RETRY_THRESHOLD) {
  if (httpStatus === 200) return "OK";
  if (httpStatus === 401) {
    const ageHours = (now - tokenIssuedAt) / 3600000;
    if (retryCount >= retryThreshold) return "LOCKOUT_RISK";
    if (ageHours >= configuredLifetimeHours) return "EXPIRED_REAUTH";
    return "REVOKED_OR_INVALID";
  }
  return "REVOKED_OR_INVALID";
}

async function getWithStatus(path, token, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function probeToken(token) {
  return getWithStatus("/store/storeConfigs", token);
}

async function getNewAdminToken(username, password) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/integration/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`Re-authentication failed with status ${res.status}`);
  return res.json();
}

export async function run() {
  let token = process.env.MAGENTO_ADMIN_TOKEN || "";
  let tokenIssuedAt = process.env.TOKEN_ISSUED_AT ? Date.parse(process.env.TOKEN_ISSUED_AT) : Date.now();
  let retryCount = 0;

  while (true) {
    const now = Date.now();
    const { status, body } = await probeToken(token);
    const outcome = classifyTokenFailure(status, body, tokenIssuedAt, now, LIFETIME_HOURS, retryCount, RETRY_THRESHOLD);

    if (outcome === "OK") {
      console.log("Token is valid. Automation can proceed.");
      return;
    }

    if (outcome === "EXPIRED_REAUTH") {
      console.warn(`Token expired after its configured lifetime. ${DRY_RUN ? "Would re-authenticate." : "Re-authenticating."}`);
      if (DRY_RUN) return;
      const newToken = await getNewAdminToken(ADMIN_USER, ADMIN_PASS);
      token = typeof newToken === "string" ? newToken : newToken.token || token;
      tokenIssuedAt = now;
      retryCount += 1;
      continue;
    }

    if (outcome === "REVOKED_OR_INVALID") {
      console.error(
        `Job admin-token-expiry-breaks-automation: token rejected while still within its configured lifetime at ${new Date(now).toISOString()}. 401 payload: ${JSON.stringify(body)}. Flagging for manual review, not retrying.`
      );
      return;
    }

    console.error(
      `Job admin-token-expiry-breaks-automation: repeated failure at ${new Date(now).toISOString()} after a refresh attempt. Stopping to avoid the admin account lockout. 401 payload: ${JSON.stringify(body)}`
    );
    return;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
