"""Flag Magento 2 cron_schedule rows stuck on running, safely.

Magento's cron runner writes a cron_schedule row with status 'running' and
executed_at set to now before it invokes the job callback, then updates that
row to 'success' or 'error' only after the callback returns. If that process
is killed (an OOM, a deploy restarting PHP-FPM, a server crash, an infinite
loop), the row never flips back, and Magento believes the job is stuck
running forever. There is no public REST resource for cron_schedule, so this
reports by default and only gates a real unlock behind DRY_RUN=false. Run on
a schedule. Safe to run again and again.
"""
import os
import time
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_cron")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
CRON_STALE_TIMEOUT_SECONDS = float(os.environ.get("CRON_STALE_TIMEOUT_SECONDS", "7200"))
CRON_UNSTARTED_GRACE_SECONDS = float(os.environ.get("CRON_UNSTARTED_GRACE_SECONDS", "300"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def classify_stale_cron_row(row, timeout_seconds):
    """Pure decision logic, no I/O.

    row: {"status": str, "executedAt": float|None, "createdAt": float|None, "now": float}
    Returns 'ok', 'stale_running', or 'stale_unstarted'.
    """
    if row["status"] != "running":
        return "ok"

    now = row["now"]
    executed_at = row.get("executedAt")

    if not executed_at:
        created_at = row.get("createdAt")
        age_seconds = (now - created_at) if created_at else 0
        return "stale_unstarted" if age_seconds > CRON_UNSTARTED_GRACE_SECONDS else "ok"

    age_seconds = now - executed_at
    return "stale_running" if age_seconds > timeout_seconds else "ok"


def unprocessed_orders_since(since_iso):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
        "searchCriteria[filterGroups][0][filters][0][value]": since_iso,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[filterGroups][1][filters][0][field]": "status",
        "searchCriteria[filterGroups][1][filters][0][value]": "processing",
        "searchCriteria[filterGroups][1][filters][0][conditionType]": "eq",
        "searchCriteria[pageSize]": 100,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/orders", params)["items"]


def fetch_running_rows(db):
    """db is a caller-supplied read-only handle to cron_schedule.
    Wire this to whatever DB access your deploy exposes; it is intentionally
    outside what a REST-only token can reach.
    """
    return db.query(
        "SELECT schedule_id, job_code, status, created_at, scheduled_at, "
        "executed_at, finished_at, messages FROM cron_schedule "
        "WHERE status = 'running'"
    )


def run(db=None):
    if db is None:
        log.warning("No database handle supplied. Nothing to check, exiting.")
        return

    now_epoch = time.time()
    flagged = 0
    for row in fetch_running_rows(db):
        classified_row = {
            "status": row["status"],
            "executedAt": row["executed_at"].timestamp() if row.get("executed_at") else None,
            "createdAt": row["created_at"].timestamp() if row.get("created_at") else None,
            "now": now_epoch,
        }
        result = classify_stale_cron_row(classified_row, CRON_STALE_TIMEOUT_SECONDS)

        if result == "ok":
            continue

        age_seconds = now_epoch - (classified_row["executedAt"] or classified_row["createdAt"] or now_epoch)
        log.warning(
            "Schedule %s (job_code=%s): %s (stuck %.0f sec). %s",
            row["schedule_id"], row["job_code"], result, age_seconds,
            "would unlock" if not DRY_RUN else "reporting only",
        )
        flagged += 1

    log.info("Done. %d cron row(s) flagged.", flagged)


if __name__ == "__main__":
    run()
