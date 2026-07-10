"""Flag Magento 2 credit memos where an online refund silently fell back to
offline.

The admin credit memo form only offers an online refund when the payment
method's gateway adapter reports canRefund or canRefundPartialPerInvoice as
true for that invoice's capture transaction. If the capture cannot be found,
or the gateway call fails, Magento quietly narrows the form to offline only,
with no visible error. If a human submits that form, Magento creates a
normal looking credit memo and marks the order refunded, but the payment
gateway was never called and the customer's money never moved. There is no
supported endpoint that converts an existing offline credit memo into a real
gateway refund, so this only reports the mismatch. Run on a schedule. Safe
to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_offline_refund_fallback")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
LOOKBACK_DAYS = float(os.environ.get("LOOKBACK_DAYS", "7"))
GATEWAY_METHODS = [
    m.strip()
    for m in os.environ.get(
        "GATEWAY_METHODS", "stripe_payments,braintree,authorizenet_acceptjs,adyen_cc"
    ).split(",")
    if m.strip()
]
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


def order_transactions(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[pageSize]": 50,
    }
    return magento_get("/transactions", params)["items"]


def normalize_creditmemo(raw):
    return {
        "entityId": raw.get("entity_id"),
        "incrementId": raw.get("increment_id"),
        "orderId": raw.get("order_id"),
        "paymentMethod": (raw.get("extension_attributes") or {}).get("payment_method")
        or raw.get("payment_method"),
        "grandTotal": float(raw.get("grand_total") or 0),
    }


def normalize_transaction(raw):
    return {"txnType": raw.get("txn_type"), "parentId": raw.get("parent_id")}


def evaluate_refund_fallback(creditmemo, transactions, gateway_methods):
    """Decide whether a credit memo's online refund silently fell back to offline.

    Returns whether the payment method is a known gateway backed method, whether
    a refund transaction exists on the order, and whether that combination looks
    like a silent fallback (gateway method with no refund transaction recorded).
    """
    method = creditmemo.get("paymentMethod")
    if method not in gateway_methods:
        return {"isGatewayMethod": False, "hasRefundTxn": None, "fellBackOffline": False}

    has_refund_txn = any(t.get("txnType") == "refund" for t in transactions)
    return {
        "isGatewayMethod": True,
        "hasRefundTxn": has_refund_txn,
        "fellBackOffline": not has_refund_txn,
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
            if not creditmemo["orderId"]:
                continue
            raw_txns = order_transactions(creditmemo["orderId"])
            transactions = [normalize_transaction(t) for t in raw_txns]
            result = evaluate_refund_fallback(creditmemo, transactions, GATEWAY_METHODS)
            if result["fellBackOffline"]:
                flagged.append({**creditmemo, **result})
        if len(raw_items) < 100:
            break
        page += 1

    for row in flagged:
        log.warning(
            "Creditmemo %s (order %s, method %s) has no refund transaction. Customer may still be owed %.2f.",
            row["incrementId"], row["orderId"], row["paymentMethod"], row["grandTotal"],
        )

    if flagged:
        log.error(
            "%d credit memo(s) look like a silent offline fallback. This script never issues a refund itself.",
            len(flagged),
        )
    else:
        log.info("Done. No offline refund fallback found.")


if __name__ == "__main__":
    run()
