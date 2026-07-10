"""Flag a Magento 2 sales_order_grid (and invoice/shipment/creditmemo grid)
sync backlog caused by the refreshBySchedule batch size cap, safely.

Magento's Update by Schedule grid sync asks a provider for not-yet-synced
entity ids, and that provider's own SQL select carries a LIMIT equal to
Grid::BATCH_SIZE (100). When more than 100 rows fall out of sync between
cron ticks (bulk import, a busy sale, a grid rebuild), each scheduled run
only ever drains 100 rows, and the backlog can grow faster than it shrinks.
The grid tables are database-internal and are not exposed over REST, so
this script infers the backlog from the REST-visible order updated_at
stream: it polls how many orders changed since the last checkpoint and
looks for a streak of consecutive polls at or above the batch size, which
is the signature of the batch cap rather than a merely busy cron.

This script never writes to Magento. There is no REST endpoint that forces
a grid resync or removes the batch cap, and touching orders through PUT
just to force a resync is not a safe workaround. It only reports. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/grid-refresh-batch-size-backlog/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_grid_sync_backlog")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
GRID_BATCH_SIZE = int(os.environ.get("GRID_BATCH_SIZE", "100"))
CONSECUTIVE_THRESHOLD = int(os.environ.get("CONSECUTIVE_THRESHOLD", "2"))
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


def orders_updated_since(since_iso, page_size=200, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
        "searchCriteria[filterGroups][0][filters][0][value]": since_iso,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/orders", params)


def newest_order_updated_at():
    params = {
        "searchCriteria[pageSize]": 1,
        "searchCriteria[currentPage]": 1,
        "searchCriteria[sortOrders][0][field]": "updated_at",
        "searchCriteria[sortOrders][0][direction]": "DESC",
    }
    items = magento_get("/orders", params)["items"]
    return items[0]["updated_at"] if items else None


def classify_grid_sync_backlog(poll_history, batch_size=100, consecutive_threshold=2):
    """Pure decision logic, no I/O.

    Walks a chronological list of poll samples, each recording how many
    orders had updated_at newer than the previous poll's checkpoint, and
    counts consecutive samples where updatedSinceLastPollCount >= batch_size.
    A healthy cron drains the full delta each run, so the observed count
    should fall below batch_size once caught up. A capped refreshBySchedule
    leaves count >= batch_size run after run, so a streak reaching
    consecutive_threshold flags a suspected backlog.

    estimated_backlog_rows sums (count - batch_size) for every sample in
    the best (longest) streak, giving a lower-bound estimate of unsynced
    rows still pending grid insertion or update.
    """
    consecutive = 0
    best_streak = 0
    streak_excess = 0
    best_excess = 0

    for sample in poll_history:
        count = sample["updatedSinceLastPollCount"]
        if count >= batch_size:
            consecutive += 1
            streak_excess += count - batch_size
        else:
            consecutive = 0
            streak_excess = 0
        if consecutive >= best_streak:
            best_streak = consecutive
            best_excess = streak_excess

    return {
        "backlogSuspected": best_streak >= consecutive_threshold,
        "consecutiveOverBatchRuns": best_streak,
        "estimatedBacklogRows": best_excess if best_streak >= consecutive_threshold else 0,
    }


def poll_once(since_iso, page_size=200):
    data = orders_updated_since(since_iso, page_size=page_size)
    increment_ids = [o.get("increment_id") for o in data.get("items", [])]
    return {
        "count": data.get("total_count", len(data.get("items", []))),
        "incrementIds": increment_ids,
    }


def run(checkpoint_iso=None, poll_history=None):
    poll_history = poll_history if poll_history is not None else []

    checkpoint = checkpoint_iso or newest_order_updated_at()
    if not checkpoint:
        log.info("No orders found. Nothing to poll yet.")
        return poll_history

    sample = poll_once(checkpoint)
    poll_history.append({"timestampMs": 0, "updatedSinceLastPollCount": sample["count"]})

    result = classify_grid_sync_backlog(poll_history, GRID_BATCH_SIZE, CONSECUTIVE_THRESHOLD)

    if result["backlogSuspected"]:
        log.warning(
            "Suspected grid sync backlog: %d consecutive poll(s) at or above batch size %d, "
            "estimated %d row(s) behind. Sample increment_ids: %s. %s",
            result["consecutiveOverBatchRuns"], GRID_BATCH_SIZE,
            result["estimatedBacklogRows"], sample["incrementIds"][:20],
            "DRY_RUN, reporting only" if DRY_RUN else "reporting only, no auto-repair available over REST",
        )
    else:
        log.info("Grid sync looks healthy. %d order(s) updated since checkpoint.", sample["count"])

    return poll_history


if __name__ == "__main__":
    run()
