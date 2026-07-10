"""Flag Magento 2 credit memos whose grand_total was never refreshed after an
adjustment edit.

In the admin credit memo creation form, the grand total shown and saved is
only recalculated by the Update Qty's JavaScript handler, which fires on item
quantity changes. It is never wired to the Refund Shipping, Adjustment Refund
(adjustment_positive), or Adjustment Fee (adjustment_negative) input fields,
so editing those alone can leave grand_total stale in both the UI and the
persisted record unless a qty update or the actual submission forces
Magento's server side total collectors to run. The same drift is reachable
through POST /V1/creditmemo, since the API does not independently re-validate
the total. There is no supported endpoint to fix a posted creditmemo's
grand_total, so this only reports the drift. Run on a schedule. Safe to run
again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_creditmemo_total_drift")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
LOOKBACK_DAYS = float(os.environ.get("LOOKBACK_DAYS", "7"))
EPSILON = float(os.environ.get("EPSILON", "0.01"))
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


def normalize_creditmemo(raw):
    return {
        "entityId": raw.get("entity_id"),
        "incrementId": raw.get("increment_id"),
        "orderId": raw.get("order_id"),
        "subtotal": float(raw.get("subtotal") or 0),
        "discountAmount": float(raw.get("discount_amount") or 0),
        "shippingAmount": float(raw.get("shipping_amount") or 0),
        "taxAmount": float(raw.get("tax_amount") or 0),
        "adjustmentPositive": float(raw.get("adjustment_positive") or 0),
        "adjustmentNegative": float(raw.get("adjustment_negative") or 0),
        "grandTotal": float(raw.get("grand_total") or 0),
    }


def evaluate_creditmemo_total_drift(creditmemo, epsilon=0.01):
    expected_grand_total = round(
        creditmemo["subtotal"]
        - creditmemo["discountAmount"]
        + creditmemo["shippingAmount"]
        + creditmemo["taxAmount"]
        + creditmemo["adjustmentPositive"]
        - creditmemo["adjustmentNegative"],
        2,
    )
    delta = round(creditmemo["grandTotal"] - expected_grand_total, 2)
    is_drifted = abs(delta) > epsilon
    return {
        "expectedGrandTotal": expected_grand_total,
        "delta": delta,
        "isDrifted": is_drifted,
    }


def run():
    since = since_iso(LOOKBACK_DAYS)
    flagged = []
    page = 1
    while True:
        raw_items = recent_creditmemos(since, current_page=page)
        if not raw_items:
            break
        for raw in raw_items:
            creditmemo = normalize_creditmemo(raw)
            result = evaluate_creditmemo_total_drift(creditmemo, EPSILON)
            if result["isDrifted"]:
                flagged.append({**creditmemo, **result})
        if len(raw_items) < 100:
            break
        page += 1

    for row in flagged:
        log.warning(
            "Creditmemo %s (order %s) grand_total drifted. stored=%.2f expected=%.2f delta=%.2f",
            row["incrementId"], row["orderId"], row["grandTotal"], row["expectedGrandTotal"], row["delta"],
        )

    if flagged:
        log.error("%d credit memo(s) drifted. This script never edits them directly.", len(flagged))
    else:
        log.info("Done. No credit memo total drift found.")


if __name__ == "__main__":
    run()
