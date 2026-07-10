"""Flag Magento 2 SKUs where a negative source_item quantity is masked as positive stock.

MSI legitimately allows a source_item to carry a negative quantity, for a drop-ship
or oversell tracking source signalling a deficit. Magento's indexer, SelectBuilder::execute,
only forces a source's contribution to 0 in the SUM() when that source's is_in_stock flag
is 0 (via getCheckSql()). When a negative-quantity source is left marked in-stock, or the
zeroing branch never fires for how sources combine into a stock, the raw negative number is
summed as is, and a depleted source can cancel out or invert the sign of healthy sources,
producing an impossible positive salable total. Tracked upstream as magento/inventory#3346
and #3165, both open. This script never rewrites source_items automatically. It reports the
impossible-total signature per SKU and stock, and only performs the guarded zero-out write
after DRY_RUN is explicitly set to false, which an operator should only do once they have
confirmed the negative row is bad data. Safe to run again and again in report mode.

Guide: https://www.allanninal.dev/magento/negative-source-item-counted-as-positive/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_negative_source_masked")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
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
    return r.json() if r.content else None


def get_stock_source_links():
    data = magento_get("/inventory/stock-source-links", {"searchCriteria[pageSize]": 200})
    return data["items"]


def get_source_items_for_sku(sku):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "sku",
        "searchCriteria[filterGroups][0][filters][0][value]": sku,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/inventory/source-items", params)["items"]


def group_rows_by_stock(source_items, stock_source_links):
    code_to_stocks = {}
    for link in stock_source_links:
        code_to_stocks.setdefault(link["source_code"], []).append(link["stock_id"])

    grouped = {}
    for item in source_items:
        for stock_id in code_to_stocks.get(item["source_code"], []):
            grouped.setdefault(stock_id, []).append({
                "sourceCode": item["source_code"],
                "quantity": item["quantity"],
                "status": item["status"],
            })
    return grouped


def is_impossible_stock_total(source_rows):
    """Pure decision function. No network/DB calls.

    Given the source rows feeding one stock, returns whether the naive combined
    sum is an impossible total: at least one negative-quantity row exists but the
    sum is non-negative, or otherwise fails to propagate that source's deficit.
    """
    total = sum(row["quantity"] for row in source_rows)
    negative_sources = [row["sourceCode"] for row in source_rows if row["quantity"] < 0]

    if not negative_sources:
        return {"flagged": False, "sum": total, "negativeSources": [], "reason": None}

    masked = total >= 0 or any(
        row["quantity"] < 0 and row["status"] == 0 and total > row["quantity"]
        for row in source_rows
    )

    if not masked:
        return {"flagged": False, "sum": total, "negativeSources": negative_sources, "reason": None}

    culprit = next(row for row in source_rows if row["quantity"] < 0)
    status_label = "out_of_stock" if culprit["status"] == 0 else "in_stock"
    reason = (
        f"source {culprit['sourceCode']} qty={culprit['quantity']} status={status_label} "
        f"masked, sum={total} treated as salable"
    )
    return {"flagged": True, "sum": total, "negativeSources": negative_sources, "reason": reason}


def get_salable_quantity(sku, stock_id):
    return float(magento_get(f"/inventory/get-product-salable-quantity/{sku}/{stock_id}"))


def zero_out_source_item(sku, source_code):
    payload = {"sourceItems": [{"sku": sku, "source_code": source_code, "quantity": 0, "status": 0}]}
    if DRY_RUN:
        log.info("DRY_RUN: would PUT /inventory/source-items with %s", payload)
        return
    magento_put("/inventory/source-items", payload)
    log.warning("Zeroed %s at source %s. Re-check salable qty, then run a CLI reindex.", sku, source_code)


def run(skus=None, fix_source_codes=None):
    """skus: list of SKUs to check.
    fix_source_codes: optional {sku: source_code} map naming a source an operator
    has confirmed is bad data. Only that source, on that SKU, gets zeroed, and
    only when DRY_RUN=false.
    """
    skus = skus or []
    fix_source_codes = fix_source_codes or {}
    stock_source_links = get_stock_source_links()
    flagged = 0

    for sku in skus:
        source_items = get_source_items_for_sku(sku)
        grouped = group_rows_by_stock(source_items, stock_source_links)

        for stock_id, rows in grouped.items():
            result = is_impossible_stock_total(rows)
            if not result["flagged"]:
                continue

            salable_qty = get_salable_quantity(sku, stock_id)
            log.warning(
                "SKU %s stock %s: %s naive_sum=%s live_salable=%s",
                sku, stock_id, result["reason"], result["sum"], salable_qty,
            )
            flagged += 1

            confirmed_bad_source = fix_source_codes.get(sku)
            if confirmed_bad_source and confirmed_bad_source in result["negativeSources"]:
                zero_out_source_item(sku, confirmed_bad_source)
                new_salable_qty = get_salable_quantity(sku, stock_id)
                log.info("SKU %s stock %s salable qty after write: %s", sku, stock_id, new_salable_qty)

    log.info("Done. %d SKU/stock pair(s) flagged.", flagged)


if __name__ == "__main__":
    run(skus=os.environ.get("CHECK_SKUS", "").split(",") if os.environ.get("CHECK_SKUS") else [])
