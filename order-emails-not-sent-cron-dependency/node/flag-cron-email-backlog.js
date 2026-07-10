/**
 * Flag a Magento 2 order confirmation email backlog caused by a dead cron scheduler.
 *
 * Magento sends sales emails (order, invoice, shipment, credit memo) through an
 * asynchronous queue by default. An order only sets send_email=1 and
 * email_sent=null when it completes; the actual send happens later, when the
 * sales_send_order_emails cron job runs. cron_schedule has no REST endpoint and
 * the real send_email/email_sent flags are not on the default order DTO, so this
 * uses "order created more than N minutes ago and still open" as the detectable
 * proxy for a stuck email queue. This never sends an email or writes to an
 * order, it only reports. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-emails-not-sent-cron-dependency/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 30);
const BACKLOG_ALERT_COUNT = Number(process.env.BACKLOG_ALERT_COUNT || 5);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const TERMINAL_STATUSES = new Set(["canceled"]);

/**
 * Pure decision logic. No network or DB calls.
 * orders: array of {entityId, incrementId, createdAt, status}
 * nowIso: ISO 8601 timestamp string treated as UTC
 * Returns {staleOrders, cronLikelyDown}
 */
export function classifyCronEmailBacklog(orders, nowIso, staleMinutes = 30, backlogAlertCount = 5) {
  const now = new Date(nowIso).getTime();
  const staleOrders = [];

  for (const o of orders) {
    if (TERMINAL_STATUSES.has(o.status)) continue;
    const created = new Date(o.createdAt).getTime();
    const minutesOverdue = (now - created) / 60000;
    if (minutesOverdue > staleMinutes) {
      staleOrders.push({ entityId: o.entityId, incrementId: o.incrementId, minutesOverdue });
    }
  }

  staleOrders.sort((a, b) => b.minutesOverdue - a.minutesOverdue);

  const maxOverdue = staleOrders.length ? Math.max(...staleOrders.map((o) => o.minutesOverdue)) : 0;
  const cronLikelyDown =
    staleOrders.length >= backlogAlertCount ||
    (staleOrders.length > 0 && maxOverdue > staleMinutes * 4);

  return { staleOrders, cronLikelyDown };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function ordersOlderThan(thresholdIso, pageSize = 100, currentPage = 1) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
    "searchCriteria[filterGroups][0][filters][0][value]": thresholdIso,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "lteq",
    "searchCriteria[filterGroups][1][filters][0][field]": "status",
    "searchCriteria[filterGroups][1][filters][0][value]": "canceled",
    "searchCriteria[filterGroups][1][filters][0][conditionType]": "neq",
    "searchCriteria[filterGroups][2][filters][0][field]": "status",
    "searchCriteria[filterGroups][2][filters][0][value]": "closed",
    "searchCriteria[filterGroups][2][filters][0][conditionType]": "neq",
    "searchCriteria[sortOrders][0][field]": "created_at",
    "searchCriteria[sortOrders][0][direction]": "ASC",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

function normalizeOrder(item) {
  return {
    entityId: item.entity_id,
    incrementId: item.increment_id,
    createdAt: item.created_at,
    status: item.status,
  };
}

export async function run() {
  const now = new Date();
  const threshold = new Date(now.getTime() - STALE_MINUTES * 60000);
  const thresholdIso = threshold.toISOString().slice(0, 19).replace("T", " ");

  const rawItems = await ordersOlderThan(thresholdIso);
  const orders = rawItems.map(normalizeOrder);

  const result = classifyCronEmailBacklog(orders, now.toISOString(), STALE_MINUTES, BACKLOG_ALERT_COUNT);

  for (const stale of result.staleOrders) {
    console.warn(
      `Order ${stale.incrementId} (id ${stale.entityId}) is ${stale.minutesOverdue.toFixed(0)} minute(s) overdue for its confirmation email.`
    );
  }

  if (result.cronLikelyDown) {
    console.error(
      `CRON_LIKELY_DOWN: ${result.staleOrders.length} stale order(s) found past the ${STALE_MINUTES} minute threshold. ` +
      `Run bin/magento cron:run, check bin/magento cron:install and the system crontab, or clear a stuck cron_schedule row.`
    );
  } else {
    console.log(`Done. ${result.staleOrders.length} stale order(s), cron appears healthy.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
