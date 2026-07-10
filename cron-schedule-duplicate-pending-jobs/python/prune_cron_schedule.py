"""Find and prune duplicate pending jobs in Magento 2 or Adobe Commerce cron_schedule.

Magento's cron generator, ProcessCronQueueObserver::_generate(), only checks
rows already in pending status when it decides what is already scheduled. It
ignores rows stuck in running status. If a job's previous run is still
executing, whether long running, stuck, or crashed without flipping to
success or error, the generator keeps inserting a fresh pending row for the
same job_code on every cron:run pass. cron_schedule has no webapi.xml route,
so this script queries and prunes the table directly. It only ever deletes
surplus pending rows, always keeping the single earliest pending row per
job_code so the job still fires. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/cron-schedule-duplicate-pending-jobs/
"""
import os
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("prune_cron_schedule")

DB_HOST = os.environ.get("MAGENTO_DB_HOST", "127.0.0.1")
DB_NAME = os.environ.get("MAGENTO_DB_NAME", "magento")
DB_USER = os.environ.get("MAGENTO_DB_USER", "magento")
DB_PASSWORD = os.environ.get("MAGENTO_DB_PASSWORD", "")
MAX_PENDING_PER_JOB = int(os.environ.get("MAX_PENDING_PER_JOB", "20"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def decide_pending_schedules_to_prune(rows, max_pending_per_job):
    """Pure function. Decides which pending cron_schedule rows to prune per job_code.

    rows: list of dicts with schedule_id, job_code, status, scheduled_at, created_at
    max_pending_per_job: int, the max number of pending rows to keep per job_code
      once true duplicates (same job_code + scheduled_at) are collapsed.

    Returns a list of {"job_code", "prune_ids", "keep_ids"} dicts. Always keeps
    at least one row (the soonest scheduled) per job_code. No I/O.
    """
    by_job = {}
    for row in rows:
        by_job.setdefault(row["job_code"], []).append(row)

    results = []
    for job_code, job_rows in by_job.items():
        by_time = {}
        for row in job_rows:
            by_time.setdefault(row["scheduled_at"], []).append(row)

        deduped = []
        prune_ids = []
        for scheduled_at, group in by_time.items():
            group_sorted = sorted(group, key=lambda r: r["schedule_id"])
            keeper = group_sorted[0]
            deduped.append(keeper)
            prune_ids.extend(r["schedule_id"] for r in group_sorted[1:])

        deduped.sort(key=lambda r: (r["created_at"], r["schedule_id"]))
        keep_ids = [r["schedule_id"] for r in deduped]

        # Never prune the last remaining pending row for a job_code, even if
        # max_pending_per_job is 0: the job still needs to fire at least once.
        effective_max = max(max_pending_per_job, 1)
        if len(deduped) > effective_max:
            excess = deduped[: len(deduped) - effective_max]
            prune_ids.extend(r["schedule_id"] for r in excess)
            keep_ids = [r["schedule_id"] for r in deduped[len(deduped) - effective_max:]]

        results.append({
            "job_code": job_code,
            "prune_ids": sorted(prune_ids),
            "keep_ids": sorted(keep_ids),
        })
    return results


def get_connection():
    import mysql.connector
    return mysql.connector.connect(
        host=DB_HOST, database=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


def fetch_pending_rows(conn):
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT schedule_id, job_code, status, scheduled_at, created_at "
        "FROM cron_schedule WHERE status = 'pending'"
    )
    rows = cur.fetchall()
    cur.close()
    return rows


def prune_schedules(conn, schedule_ids):
    if not schedule_ids:
        return 0
    placeholders = ",".join(["%s"] * len(schedule_ids))
    cur = conn.cursor()
    cur.execute(
        f"DELETE FROM cron_schedule WHERE schedule_id IN ({placeholders})",
        schedule_ids,
    )
    conn.commit()
    deleted = cur.rowcount
    cur.close()
    return deleted


def run():
    conn = get_connection()
    try:
        rows = fetch_pending_rows(conn)
        plans = decide_pending_schedules_to_prune(rows, MAX_PENDING_PER_JOB)
        total_pruned = 0
        for plan in plans:
            if not plan["prune_ids"]:
                continue
            log.info(
                "job_code=%s would prune %d row(s): %s",
                plan["job_code"], len(plan["prune_ids"]), plan["prune_ids"],
            )
            if not DRY_RUN:
                deleted = prune_schedules(conn, plan["prune_ids"])
                total_pruned += deleted
                log.info("job_code=%s pruned %d row(s)", plan["job_code"], deleted)
            else:
                total_pruned += len(plan["prune_ids"])
        log.info(
            "Done. %d row(s) %s.", total_pruned,
            "would be pruned (dry run)" if DRY_RUN else "pruned",
        )
    finally:
        conn.close()


if __name__ == "__main__":
    run()
