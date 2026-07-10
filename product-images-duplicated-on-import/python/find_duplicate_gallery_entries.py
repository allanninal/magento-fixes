"""Find and safely remove duplicate Magento product gallery images caused by
repeated import or Save and Duplicate.

Magento's catalog importer (Magento\\CatalogImportExport\\Model\\Import\\Product)
and the product Copier (Magento\\Catalog\\Model\\Product\\Copier::copy) both
append to catalog_product_entity_media_gallery instead of checking whether an
identical image is already attached to the SKU. Re-running an import, or
duplicating a product, saves a renamed copy of the same file (image_1.jpg,
image_2.jpg, ...) and inserts a fresh gallery row for it every time.

This script reads media_gallery_entries per SKU over REST, hashes the bytes
each entry's file resolves to, and groups entries by that hash. Only entries
that share a hash within the same SKU are treated as true duplicates. It
reports by default. Repair only runs with DRY_RUN=false, only removes ids
confirmed as byte-identical duplicates, always keeps the lowest id (first
imported), and never removes a product's only image or an unmatched
base/small_image/thumbnail role.

Guide: https://www.allanninal.dev/magento/product-images-duplicated-on-import/
"""
import os
import re
import hashlib
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_gallery_entries")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
SKUS = [s.strip() for s in os.environ.get("SKUS", "").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ROLE_TYPES = {"base", "small_image", "thumbnail"}
SUFFIX_RE = re.compile(r"^(.*?)(_\d+)?(\.[A-Za-z0-9]+)$")


def api_get(path, params=None):
    r = requests.get(f"{MAGENTO_URL}/rest/V1{path}", headers=HEADERS, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, payload):
    r = requests.put(f"{MAGENTO_URL}/rest/V1{path}", headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_product(sku):
    return api_get(f"/products/{sku}")


def hash_media_file(file_path):
    url = f"{MAGENTO_URL}/media/catalog/product{file_path}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return hashlib.md5(r.content).hexdigest()


def entries_with_hash(product):
    entries = product.get("media_gallery_entries", [])
    for entry in entries:
        entry["hash"] = hash_media_file(entry["file"])
    return entries


def normalized_stem(file_name):
    base = file_name.rsplit("/", 1)[-1]
    m = SUFFIX_RE.match(base)
    if not m:
        return base
    return f"{m.group(1)}{m.group(3)}"


def group_key(entry):
    if entry.get("hash"):
        return f"hash:{entry['hash']}"
    return f"name:{normalized_stem(entry['file'])}"


def find_duplicate_gallery_entries(media_gallery_entries):
    """Pure function. Groups entries by content hash (preferred) falling back
    to normalized base filename (stripping Magento's trailing "_1", "_2"...
    disambiguator and extension) when a hash is unavailable. Within each
    group, sorts by id ascending and keeps the lowest id (the original,
    first-imported entry) as canonical; every other id in the group is
    reported as a duplicate candidate. Returns [] when every group has size 1
    (no duplicates). No I/O: caller supplies pre-fetched entries (and
    pre-computed hash/size if available).
    """
    groups = {}
    for entry in media_gallery_entries:
        groups.setdefault(group_key(entry), []).append(entry)

    results = []
    for key, group in groups.items():
        if len(group) < 2:
            continue
        ids_sorted = sorted(e["id"] for e in group)
        keep_id = ids_sorted[0]
        duplicate_ids = ids_sorted[1:]
        reason = "identical file content" if key.startswith("hash:") else "identical normalized filename"
        results.append({"keepId": keep_id, "duplicateIds": duplicate_ids, "reason": reason})
    return results


def safe_duplicate_ids(all_entries, duplicate_group):
    """Pure function. Filters a duplicate group's duplicateIds down to the
    ones safe to remove: never the product's only image, and never an entry
    covering a base/small_image/thumbnail role unless the kept entry already
    covers that same role. No I/O.
    """
    if len(all_entries) <= 1:
        return []
    by_id = {e["id"]: e for e in all_entries}
    keep_entry = by_id.get(duplicate_group["keepId"], {})
    keep_roles = set(keep_entry.get("types") or [])
    safe = []
    for dup_id in duplicate_group["duplicateIds"]:
        entry = by_id.get(dup_id)
        if not entry:
            continue
        roles = set(entry.get("types") or []) & ROLE_TYPES
        if roles and not roles.issubset(keep_roles):
            continue
        safe.append(dup_id)
    return safe


def remove_entries(sku, product, remove_ids):
    remaining = [e for e in product["media_gallery_entries"] if e["id"] not in remove_ids]
    payload = {"product": {"sku": sku, "media_gallery_entries": remaining}}
    return api_put(f"/products/{sku}", payload)


def run():
    total_removed = 0
    for sku in SKUS:
        product = fetch_product(sku)
        entries = entries_with_hash(product)
        groups = find_duplicate_gallery_entries(entries)
        if not groups:
            log.info("SKU %s: no duplicate gallery entries found.", sku)
            continue

        remove_ids = set()
        for group in groups:
            safe_ids = safe_duplicate_ids(entries, group)
            for entry in entries:
                if entry["id"] in group["duplicateIds"]:
                    log.warning(
                        "SKU %s: entry id=%s file=%s is a duplicate of id=%s (%s)%s",
                        sku, entry["id"], entry["file"], group["keepId"], group["reason"],
                        "" if entry["id"] in safe_ids else " -- skipped, no safe sibling for its role",
                    )
            remove_ids.update(safe_ids)

        if remove_ids:
            log.info("SKU %s: %s %d entr%s.", sku,
                      "would remove" if DRY_RUN else "removing",
                      len(remove_ids), "y" if len(remove_ids) == 1 else "ies")
            if not DRY_RUN:
                remove_entries(sku, product, remove_ids)
        total_removed += len(remove_ids)

    log.info("Done. %d duplicate entr%s %s across %d SKU(s).",
              total_removed, "y" if total_removed == 1 else "ies",
              "to remove" if DRY_RUN else "removed", len(SKUS))


if __name__ == "__main__":
    run()
