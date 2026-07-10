"""Flag Magento 2 job codes whose cron generation halted after a crash, safely.

Before scheduling a new run for a job code, Magento's cron scheduler checks
whether an existing cron_schedule row for that job code is still status
running. If that job's process was killed mid-execution (an OOM, a PHP
fatal, a container restart), the row never flips to success or error, and
Magento quietly stops generating new runs for that job code forever, while
every other job code keeps working. There is no REST resource for
cron_schedule, so this reports by default and never writes. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/cron-generation-halts-after-crash/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stalled_cron")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
STALE_MULTIPLIER = float(os.environ.get("STALE_MULTIPLIER", "3.0"))
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


def is_job_stalled(job_code, last_status, executed_at, expected_interval_minutes, now, stale_multiplier=3.0):
    """Pure decision function. No I/O, no clock reads.

    Returns True only when last_status is "running", executed_at is known,
    and the elapsed time since executed_at exceeds the job's own expected
    cadence multiplied by stale_multiplier. A job in that state is blocking
    all future generation for job_code, because Magento's scheduler will not
    write a new cron_schedule row while an existing row for the same job
    code still reports running.

    Any other last_status (success, error, missed, pending) never blocks
    generation, so this always returns False for those.
    """
    if last_status != "running":
        return False
    if executed_at is None:
        return False
    threshold = datetime.timedelta(minutes=expected_interval_minutes * stale_multiplier)
    return (now - executed_at) > threshold


def fetch_running_rows(db):
    """db is a caller-supplied read-only handle to cron_schedule.
    Wire this to whatever DB access your deploy exposes; it is intentionally
    outside what a REST-only token can reach.
    """
    return db.query(
        "SELECT job_code, status, created_at, scheduled_at, executed_at, finished_at "
        "FROM cron_schedule WHERE status = 'running'"
    )


def recently_updated_products(since_iso):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
        "searchCriteria[filterGroups][0][filters][0][value]": since_iso,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[pageSize]": 100,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/products", params)["items"]


def salable_quantity(sku, stock_id):
    return magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}")


def run(db=None, job_intervals_minutes=None):
    """Reads cron_schedule rows through the caller-supplied db handle, flags
    any job_code whose running row is stalled, and logs a report. Never
    issues an UPDATE or DELETE; there is no cron_schedule REST endpoint to
    write through safely, so repair stays a manual or CLI step.
    """
    job_intervals_minutes = job_intervals_minutes or {}
    now = datetime.datetime.now(datetime.timezone.utc)

    if db is None:
        log.warning("No database handle supplied. Nothing to check, exiting.")
        return

    flagged = 0
    for row in fetch_running_rows(db):
        interval = job_intervals_minutes.get(row["job_code"], 60)
        stalled = is_job_stalled(
            row["job_code"], row["status"], row["executed_at"], interval, now, STALE_MULTIPLIER
        )
        if not stalled:
            continue

        age_minutes = (now - row["executed_at"]).total_seconds() / 60 if row["executed_at"] else None
        log.warning(
            "Job code %s stalled. status=%s, stuck %.0f min (expected interval %d min). "
            "Recommended: mark this cron_schedule row missed, then verify cron:run resumes %s.",
            row["job_code"], row["status"], age_minutes or -1, interval, row["job_code"],
        )
        flagged += 1

    log.info("Done. %d job code(s) flagged. Dry run=%s (report only, no writes issued).", flagged, DRY_RUN)


if __name__ == "__main__":
    run()
