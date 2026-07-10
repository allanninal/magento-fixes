"""Flag Magento 2 credit memos that appear to be duplicates from a single
refund action.

Magento does not guard credit memo creation with an idempotency key. The
admin Refund controller, the REST refund endpoints, and payment gateway
async notifications such as a PayPal Payflow IPN all call
CreditmemoService::refund() independently. If the same refund fires twice in
close succession, two sales_creditmemo records can land against the same
invoice before the first transaction commits. There is no supported endpoint
to delete a creditmemo, so this only reports the duplicate, it never cancels
or mutates one. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_duplicate_creditmemos")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
LOOKBACK_DAYS = float(os.environ.get("LOOKBACK_DAYS", "7"))
TOLERANCE_SECONDS = float(os.environ.get("TOLERANCE_SECONDS", "60"))
AMOUNT_EPSILON = float(os.environ.get("AMOUNT_EPSILON", "0.01"))
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


def since_iso(lookback_days):
    since = datetime.datetime.utcnow() - datetime.timedelta(days=lookback_days)
    return since.strftime("%Y-%m-%d %H:%M:%S")


def recent_creditmemos(since, page_size=100, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "created_at",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
        "searchCriteria[filterGroups][0][filters][0][value]": since,
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/creditmemos", params)["items"]


def iso_to_epoch(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def normalize_creditmemo(raw):
    return {
        "entityId": raw.get("entity_id"),
        "incrementId": raw.get("increment_id"),
        "orderId": raw.get("order_id"),
        "grandTotal": float(raw.get("grand_total") or 0),
        "createdAtEpoch": iso_to_epoch(raw["created_at"]),
    }


def detect_duplicate_credit_memos(creditmemos, tolerance_seconds=60, amount_epsilon=0.01):
    """Pure decision logic, no I/O.

    Groups input records by order_id, sorts each group by created_at, and
    walks pairwise clustering records whose grand_total differs by no more
    than amount_epsilon AND whose created_at differs by no more than
    tolerance_seconds. Any order_id with more than one record in a cluster
    is returned with its duplicate entity_ids and the excess amount (sum of
    cluster grand_total minus one representative grand_total). Returns an
    empty list if no clusters are found.
    """
    by_order = {}
    for cm in creditmemos:
        by_order.setdefault(cm["orderId"], []).append(cm)

    results = []
    for order_id, records in by_order.items():
        ordered = sorted(records, key=lambda r: r["createdAtEpoch"])
        clusters = []
        for record in ordered:
            placed = False
            for cluster in clusters:
                last = cluster[-1]
                if (abs(record["grandTotal"] - last["grandTotal"]) <= amount_epsilon
                        and abs(record["createdAtEpoch"] - last["createdAtEpoch"]) <= tolerance_seconds):
                    cluster.append(record)
                    placed = True
                    break
            if not placed:
                clusters.append([record])

        for cluster in clusters:
            if len(cluster) > 1:
                total_over_refund = round(
                    sum(r["grandTotal"] for r in cluster) - cluster[0]["grandTotal"], 2
                )
                results.append({
                    "orderId": order_id,
                    "duplicateGroup": [r["entityId"] for r in cluster],
                    "totalOverRefund": total_over_refund,
                })
    return results


def run():
    since = since_iso(LOOKBACK_DAYS)
    normalized = []
    page = 1
    while True:
        raw_items = recent_creditmemos(since, current_page=page)
        if not raw_items:
            break
        normalized.extend(normalize_creditmemo(raw) for raw in raw_items)
        if len(raw_items) < 100:
            break
        page += 1

    duplicates = detect_duplicate_credit_memos(normalized, TOLERANCE_SECONDS, AMOUNT_EPSILON)

    for row in duplicates:
        log.warning(
            "Order %s has duplicate credit memos %s. Excess refunded: %.2f",
            row["orderId"], row["duplicateGroup"], row["totalOverRefund"],
        )

    if duplicates:
        log.error("%d order(s) with duplicate credit memos. This script never cancels or deletes them.", len(duplicates))
    else:
        log.info("Done. No duplicate credit memos found.")


if __name__ == "__main__":
    run()
