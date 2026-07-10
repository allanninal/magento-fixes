"""Find and report duplicate SKUs created through concurrent API or import saves.

Magento 2 and Adobe Commerce enforce SKU uniqueness with a unique index on
catalog_product_entity.sku, but ProductRepository::save() and the import
and bulk API code paths first do an application-level lookup to decide
insert versus update, before that index ever runs. When two saves race,
two REST POST /V1/products calls, or a concurrent import bunch and an
async bulk save, both can see "SKU not found" in the same window and both
proceed to insert, leaving two entity_ids that resolve to the same SKU.
This never merges or deletes a product entity. It pages recently touched
products, groups by normalized sku with a pure function, confirms every
collision against the single-SKU lookup, always reports it, and only when
DRY_RUN is explicitly false and exactly one entity has zero orders does it
disable that one entity with status 2 as a reversible step. Run on a
schedule. Safe to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_sku_collisions")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
LOOKBACK_HOURS = float(os.environ.get("LOOKBACK_HOURS", "24"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "200"))
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


def magento_put(path, payload):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def lookback_iso(hours):
    dt = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def recent_products(lookback, page_size=200):
    current_page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
            "searchCriteria[filterGroups][0][filters][0][value]": lookback,
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": current_page,
        }
        data = magento_get("/products", params)
        for item in data["items"]:
            yield item
        if current_page * page_size >= data["total_count"]:
            return
        current_page += 1


def find_sku_collisions(products):
    """Pure. Groups products by normalized sku (trim + lowercase) and returns
    one collision record per sku that resolves to more than one distinct id.
    entity_ids and created_at are sorted ascending, so index 0 is the
    presumed original and later entries are the race-created duplicates.
    """
    groups = {}
    for p in products:
        normalized = p["sku"].strip().lower()
        groups.setdefault(normalized, []).append(p)

    collisions = []
    for normalized_sku, members in groups.items():
        distinct_ids = {m["id"] for m in members}
        if len(distinct_ids) <= 1:
            continue
        ordered = sorted(members, key=lambda m: m["created_at"])
        collisions.append({
            "sku": normalized_sku,
            "entity_ids": [m["id"] for m in ordered],
            "created_at": [m["created_at"] for m in ordered],
        })

    collisions.sort(key=lambda c: c["sku"])
    return collisions


def confirm_collision(sku):
    """GET /products/{sku} resolves only one entity_id for an exact sku string."""
    data = magento_get(f"/products/{sku}")
    return data.get("id")


def has_zero_orders(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[pageSize]": 1,
    }
    data = magento_get("/orders", params)
    return data.get("total_count", 0) == 0


def disable_orphan(sku):
    payload = {"product": {"sku": sku, "status": 2}}
    return magento_put(f"/products/{sku}", payload)


def run():
    raw_items = list(recent_products(lookback_iso(LOOKBACK_HOURS), PAGE_SIZE))
    products = [{"id": item["id"], "sku": item["sku"], "created_at": item.get("created_at", "")} for item in raw_items]

    collisions = find_sku_collisions(products)

    if not collisions:
        log.info("Done. 0 duplicate SKU group(s) found.")
        return

    disabled = 0
    for col in collisions:
        member_summary = ", ".join(
            f"entity_id={eid} created_at={ts}" for eid, ts in zip(col["entity_ids"], col["created_at"])
        )
        log.warning("sku %s has %d entity_id(s): %s", col["sku"], len(col["entity_ids"]), member_summary)

        resolved_id = confirm_collision(col["sku"])
        if resolved_id in col["entity_ids"] and len(col["entity_ids"]) == 2:
            candidates = [eid for eid in col["entity_ids"] if eid != resolved_id]
            orphan_id = candidates[0] if candidates else None
        else:
            orphan_id = None

        if orphan_id is None:
            log.warning("  -> could not confirm a single safe orphan for sku %s, skipping.", col["sku"])
            continue

        if not has_zero_orders(col["sku"]):
            log.warning("  -> sku %s has orders on file, leaving both entities alone.", col["sku"])
            continue

        log.warning("  -> %s entity_id %s (status=2, Disabled).", "would disable" if DRY_RUN else "disabling", orphan_id)
        if not DRY_RUN:
            disable_orphan(col["sku"])
        disabled += 1

    log.info(
        "Done. %d duplicate SKU group(s), %d orphan(s) %s.",
        len(collisions), disabled, "to disable" if DRY_RUN else "disabled",
    )


if __name__ == "__main__":
    run()
