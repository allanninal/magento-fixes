"""Flag Magento 2 or Adobe Commerce SKUs where the storefront price index is stale.

Magento precomputes storefront prices into catalog_product_price and
catalog_product_index_price. Under Update by Schedule, an admin price edit or
catalog rule change sits as a pending changelog row until the price indexer
cron actually runs. If cron is stalled or an indexer is stuck, the storefront
keeps serving the last indexed price. This script diffs the admin price
against the store scoped price for recently edited SKUs and reports the
mismatches. It never runs a reindex or touches cron: that is CLI and operator
only (bin/magento indexer:reindex catalog_product_price).

Guide: https://www.allanninal.dev/magento/stale-price-index-wrong-prices/

Safe to run again and again. DRY_RUN defaults to true.
"""
import os
import csv
import datetime
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stale_price_index")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://example.test").rstrip("/")
ADMIN_USERNAME = os.environ.get("MAGENTO_ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("MAGENTO_ADMIN_PASSWORD")
ADMIN_TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN")
STORE_CODE = os.environ.get("STORE_CODE", "default")
SINCE = os.environ.get("SINCE", "1970-01-01 00:00:00")
LAST_REINDEX_AT = os.environ.get("LAST_REINDEX_AT") or None
PRICE_EPSILON = float(os.environ.get("PRICE_EPSILON", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "stale_price_index.csv")
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "200"))


def _parse(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def decide_price_index_action(admin_price, storefront_price, updated_at, last_reindex_at, epsilon=PRICE_EPSILON):
    """Pure. No I/O.

    Takes an already-fetched admin price, storefront-scoped price, the
    product's updated_at, and the last known reindex timestamp, and decides
    whether the mismatch is explained by a pending reindex (safe to flag for
    the normal reindex job) versus an unexplained mismatch (for example a rule
    misconfiguration) that should only be flagged for a human, never
    auto-written.
    """
    diff = abs(admin_price - storefront_price)
    if diff <= epsilon:
        return {"stale": False, "action": "none"}
    edited_after_reindex = (
        last_reindex_at is None
        or _parse(updated_at) > _parse(last_reindex_at)
    )
    if edited_after_reindex:
        return {"stale": True, "action": "flag_reindex"}
    return {"stale": True, "action": "flag_investigate"}


def get_token():
    import requests
    if ADMIN_TOKEN:
        return ADMIN_TOKEN
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1/integration/admin/token",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def recent_products(token, since, page_size=PAGE_SIZE):
    import requests
    page = 1
    while True:
        params = {
            "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
            "searchCriteria[filterGroups][0][filters][0][value]": since,
            "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
            "searchCriteria[pageSize]": page_size,
            "searchCriteria[currentPage]": page,
        }
        r = requests.get(
            f"{MAGENTO_URL}/rest/V1/products",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        items = body.get("items", [])
        for item in items:
            yield item
        if len(items) < page_size:
            return
        page += 1


def storefront_price(token, store_code, sku):
    import requests
    r = requests.get(
        f"{MAGENTO_URL}/rest/{store_code}/V1/products/{sku}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["price"]


def nudge_changelog(token, sku, admin_price):
    """The only REST-safe corrective action: a no-op re-save of the price
    attribute. This enqueues the SKU in the catalog_product_price changelog
    so the next scheduled/cron reindex (or an operator-run
    bin/magento indexer:reindex catalog_product_price) picks it up. It does
    not force an immediate reindex.
    """
    import requests
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1/products/{sku}",
        json={"product": {"sku": sku, "price": admin_price}},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    import requests

    token = get_token()
    flagged = []
    for product in recent_products(token, SINCE):
        sku = product.get("sku")
        admin_price = product.get("price")
        updated_at = product.get("updated_at")
        if sku is None or admin_price is None or updated_at is None:
            continue
        try:
            store_price = storefront_price(token, STORE_CODE, sku)
        except requests.HTTPError as exc:
            log.warning("Could not read storefront price for %s: %s", sku, exc)
            continue

        verdict = decide_price_index_action(admin_price, store_price, updated_at, LAST_REINDEX_AT)
        if not verdict["stale"]:
            continue

        row = {
            "sku": sku,
            "adminPrice": admin_price,
            "storefrontPrice": store_price,
            "diff": round(abs(admin_price - store_price), 2),
            "updated_at": updated_at,
            "action": verdict["action"],
        }
        flagged.append(row)
        log.info(
            "SKU %s: admin=%s storefront=%s diff=%s action=%s",
            row["sku"], row["adminPrice"], row["storefrontPrice"], row["diff"], row["action"],
        )

        if not DRY_RUN and verdict["action"] == "flag_reindex":
            nudge_changelog(token, sku, admin_price)
            log.info("Nudged %s back into the price changelog.", sku)

    if flagged:
        with open(OUTPUT_CSV, "w", newline="") as fh:
            writer = csv.DictWriter(
                fh, fieldnames=["sku", "adminPrice", "storefrontPrice", "diff", "updated_at", "action"]
            )
            writer.writeheader()
            writer.writerows(flagged)

    log.info(
        "Done. %d SKU(s) flagged, %s.",
        len(flagged),
        "dry run, nothing written" if DRY_RUN else "nudge applied where safe",
    )
    return flagged


if __name__ == "__main__":
    run()
