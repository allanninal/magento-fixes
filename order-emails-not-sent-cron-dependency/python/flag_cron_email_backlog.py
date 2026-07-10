"""Flag a Magento 2 order confirmation email backlog caused by a dead cron scheduler.

Magento sends sales emails (order, invoice, shipment, credit memo) through an
asynchronous queue by default. An order only sets send_email=1 and
email_sent=null when it completes; the actual send happens later, when the
sales_send_order_emails cron job runs. cron_schedule has no REST endpoint and
the real send_email/email_sent flags are not on the default order DTO, so this
uses "order created more than N minutes ago and still open" as the detectable
proxy for a stuck email queue. This never sends an email or writes to an
order, it only reports. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_cron_email_backlog")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://demo.example.com").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "token_dummy")
STALE_MINUTES = float(os.environ.get("STALE_MINUTES", "30"))
BACKLOG_ALERT_COUNT = int(os.environ.get("BACKLOG_ALERT_COUNT", "5"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

TERMINAL_STATUSES = {"canceled"}


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def orders_older_than(threshold_iso, page_size=100, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
        "searchCriteria[filterGroups][0][filters][0][value]": threshold_iso,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "lteq",
        "searchCriteria[filterGroups][1][filters][0][field]": "status",
        "searchCriteria[filterGroups][1][filters][0][value]": "canceled",
        "searchCriteria[filterGroups][1][filters][0][conditionType]": "neq",
        "searchCriteria[filterGroups][2][filters][0][field]": "status",
        "searchCriteria[filterGroups][2][filters][0][value]": "closed",
        "searchCriteria[filterGroups][2][filters][0][conditionType]": "neq",
        "searchCriteria[sortOrders][0][field]": "created_at",
        "searchCriteria[sortOrders][0][direction]": "ASC",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/orders", params)["items"]


def classify_cron_email_backlog(orders, now_iso, stale_minutes=30, backlog_alert_count=5):
    """Pure decision logic. No network or DB calls.

    orders: list of {entityId, incrementId, createdAt, status}
    now_iso: ISO 8601 timestamp string treated as UTC
    Returns {"staleOrders": [...], "cronLikelyDown": bool}
    """
    now = datetime.datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    stale_orders = []

    for o in orders:
        if o.get("status") in TERMINAL_STATUSES:
            continue
        created = datetime.datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00"))
        minutes_overdue = (now - created).total_seconds() / 60
        if minutes_overdue > stale_minutes:
            stale_orders.append({
                "entityId": o["entityId"],
                "incrementId": o["incrementId"],
                "minutesOverdue": minutes_overdue,
            })

    stale_orders.sort(key=lambda o: o["minutesOverdue"], reverse=True)

    cron_likely_down = len(stale_orders) >= backlog_alert_count or (
        len(stale_orders) > 0
        and max(o["minutesOverdue"] for o in stale_orders) > stale_minutes * 4
    )

    return {"staleOrders": stale_orders, "cronLikelyDown": cron_likely_down}


def normalize_order(item):
    return {
        "entityId": item.get("entity_id"),
        "incrementId": item.get("increment_id"),
        "createdAt": item.get("created_at"),
        "status": item.get("status"),
    }


def run():
    now = datetime.datetime.now(datetime.timezone.utc)
    threshold = now - datetime.timedelta(minutes=STALE_MINUTES)
    threshold_iso = threshold.strftime("%Y-%m-%d %H:%M:%S")

    raw_items = orders_older_than(threshold_iso)
    orders = [normalize_order(item) for item in raw_items]

    result = classify_cron_email_backlog(
        orders, now.isoformat(), STALE_MINUTES, BACKLOG_ALERT_COUNT
    )

    for stale in result["staleOrders"]:
        log.warning(
            "Order %s (id %s) is %.0f minute(s) overdue for its confirmation email.",
            stale["incrementId"], stale["entityId"], stale["minutesOverdue"],
        )

    if result["cronLikelyDown"]:
        log.error(
            "CRON_LIKELY_DOWN: %d stale order(s) found past the %s minute threshold. "
            "Run bin/magento cron:run, check bin/magento cron:install and the system "
            "crontab, or clear a stuck cron_schedule row.",
            len(result["staleOrders"]), STALE_MINUTES,
        )
    else:
        log.info("Done. %d stale order(s), cron appears healthy.", len(result["staleOrders"]))


if __name__ == "__main__":
    run()
