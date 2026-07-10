"""Find and flag duplicate or colliding order increment_id values in Magento 2.

Magento generates increment_id from the sales_sequence_meta and
sales_sequence_profile tables, which store a per-store prefix, pad length,
and step rather than one global counter. A Magento 1 migration, or a
multi-store-view reconfiguration, can leave two profiles pointing at the
same underlying sequence table, so two independent order streams end up
producing the same increment_id for two different entity_id rows. This
never rewrites increment_id. It pages every order, groups by increment_id
with a pure function, always reports collisions, and only when DRY_RUN is
explicitly false posts a non destructive status history comment flagging
the duplicate for manual sequence-table correction. Run on a schedule.
Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_increment_ids")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "200"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FIELDS = "items[entity_id,increment_id,store_id,created_at,status,customer_email],total_count"

FLAG_COMMENT = (
    "Duplicate increment_id detected - flagged for manual sequence-table correction."
)


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_post(path, payload):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_orders(page_size=200):
    current_page = 1
    while True:
        params = {
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": current_page,
            "searchCriteria[sortOrders][0][field]": "increment_id",
            "searchCriteria[sortOrders][0][direction]": "ASC",
            "fields": FIELDS,
        }
        data = magento_get("/orders", params)
        for item in data["items"]:
            yield item
        if current_page * page_size >= data["total_count"]:
            return
        current_page += 1


def normalize_order(item):
    return {
        "entityId": item.get("entity_id"),
        "incrementId": item.get("increment_id"),
        "storeId": item.get("store_id"),
        "createdAt": item.get("created_at"),
    }


def find_duplicate_increment_ids(orders):
    """Group orders by incrementId (pure map-reduce, no I/O).

    Returns groups with more than one distinct entityId, sorted by
    incrementId ascending, with each group's members sorted by createdAt
    ascending so the first-created order in the collision is always
    members[0].
    """
    groups = {}
    for o in orders:
        groups.setdefault(o["incrementId"], []).append({
            "entityId": o["entityId"],
            "storeId": o["storeId"],
            "createdAt": o["createdAt"],
        })

    duplicates = []
    for increment_id, members in groups.items():
        distinct_entity_ids = {m["entityId"] for m in members}
        if len(distinct_entity_ids) <= 1:
            continue
        sorted_members = sorted(members, key=lambda m: m["createdAt"])
        duplicates.append({"incrementId": increment_id, "members": sorted_members})

    duplicates.sort(key=lambda d: d["incrementId"])
    return duplicates


def flag_duplicate_order(entity_id):
    payload = {
        "statusHistory": {
            "comment": FLAG_COMMENT,
            "is_customer_notified": 0,
            "is_visible_on_front": 0,
        }
    }
    return magento_post(f"/orders/{entity_id}/comments", payload)


def run():
    raw_items = list(all_orders(PAGE_SIZE))
    orders = [normalize_order(item) for item in raw_items]

    duplicates = find_duplicate_increment_ids(orders)

    if not duplicates:
        log.info("Done. 0 duplicate increment_id group(s) found.")
        return

    flagged = 0
    for dup in duplicates:
        member_summary = ", ".join(
            f"entity_id={m['entityId']} store_id={m['storeId']} created_at={m['createdAt']}"
            for m in dup["members"]
        )
        log.warning("increment_id %s has %d order(s): %s", dup["incrementId"], len(dup["members"]), member_summary)

        for member in dup["members"][1:]:
            log.warning(
                "  -> %s entity_id %s.", "would flag" if DRY_RUN else "flagging", member["entityId"]
            )
            if not DRY_RUN:
                flag_duplicate_order(member["entityId"])
            flagged += 1

    log.info(
        "Done. %d duplicate increment_id group(s), %d order(s) %s.",
        len(duplicates), flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
