"""Flag Magento 2 indexers stuck at Reindex required or Processing, safely.

Update on Schedule indexers hold indexer_state.status = 'working' while a cron
job processes the changelog tables, then flip it back to 'valid' when done. If
that cron process is killed (an OOM, a deploy restarting PHP-FPM, a fatal
error), the row never flips back, and Magento believes the indexer is stuck
running forever. There is no public REST resource for indexer control, so
this reports by default and only gates a real reset behind DRY_RUN=false plus
a confirmed-dead process. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/indexer-stuck-reindex-required/
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_indexers")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
STUCK_THRESHOLD_MINUTES = float(os.environ.get("STUCK_THRESHOLD_MINUTES", "60"))
CHANGELOG_BACKLOG_MAX = int(os.environ.get("CHANGELOG_BACKLOG_MAX", "5000"))
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


def classify_indexer_row(row, now, thresholds, changelog_row_count=None):
    """Pure decision logic, no I/O.

    row: {"status": "valid"|"invalid"|"working", "updatedAt": datetime}
    now: datetime (pass the current time in explicitly so this stays testable)
    thresholds: {"stuckWorkingMinutes": number, "changelogBacklogMax": number (optional)}
    changelog_row_count: optional int, the backlog size of the matching *_cl table

    Returns {"action": "ok"|"flag_backlog"|"reset_candidate", "reason": str}
    """
    if row["status"] != "working":
        return {"action": "ok", "reason": "not currently working"}

    age_minutes = (now - row["updatedAt"]).total_seconds() / 60

    if age_minutes <= thresholds["stuckWorkingMinutes"]:
        return {"action": "ok", "reason": "still within expected run time"}

    backlog_max = thresholds.get("changelogBacklogMax")
    if changelog_row_count is not None and backlog_max is not None and changelog_row_count > backlog_max:
        return {"action": "flag_backlog", "reason": "changelog backlog exceeds threshold, indexer likely starved"}

    return {"action": "reset_candidate", "reason": "working status stale beyond threshold, indicates crashed process holding lock"}


def recently_updated_products(since_iso):
    """Cross check the storefront-facing catalog against the changelog claim.

    Uses GET /rest/V1/products with searchCriteria filtering on updated_at >= since_iso.
    """
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
        "searchCriteria[filterGroups][0][filters][0][value]": since_iso,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[pageSize]": 100,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/products", params)["items"]


def fetch_indexer_rows(db):
    """db is a caller-supplied read-only handle to indexer_state (and mview_state).

    There is no public REST resource for indexer control, so this needs direct
    database access, wired to whatever your deploy exposes (a read replica, an
    internal endpoint, and so on). Kept out of run() so tests never need it.
    """
    return db.query(
        "SELECT indexer_id, view_id, status, updated_at FROM indexer_state"
    )


def fetch_changelog_backlog(db, changelog_table):
    rows = db.query(f"SELECT COUNT(*) AS n FROM {changelog_table}")
    return rows[0]["n"]


def run(db=None, changelog_tables=None):
    """Wire the pieces together. db and changelog_tables are optional so this
    module imports cleanly without any database or network access; only the
    caller that actually wants to run the check supplies them.
    """
    changelog_tables = changelog_tables or {}
    now = datetime.datetime.now(datetime.timezone.utc)
    thresholds = {
        "stuckWorkingMinutes": STUCK_THRESHOLD_MINUTES,
        "changelogBacklogMax": CHANGELOG_BACKLOG_MAX,
    }

    if db is None:
        log.warning("No database handle supplied. Nothing to check, exiting.")
        return

    flagged = 0
    for row in fetch_indexer_rows(db):
        changelog_table = changelog_tables.get(row["indexer_id"])
        backlog = fetch_changelog_backlog(db, changelog_table) if changelog_table else None

        classified_row = {"status": row["status"], "updatedAt": row["updated_at"]}
        result = classify_indexer_row(classified_row, now, thresholds, backlog)

        if result["action"] == "ok":
            continue

        age_minutes = (now - row["updated_at"]).total_seconds() / 60
        log.warning(
            "Indexer %s: %s (stuck %.0f min, backlog=%s). %s",
            row["indexer_id"], result["action"], age_minutes, backlog,
            "would reset" if (result["action"] == "reset_candidate" and not DRY_RUN) else "reporting only",
        )
        flagged += 1

    log.info("Done. %d indexer(s) flagged.", flagged)


if __name__ == "__main__":
    run()
