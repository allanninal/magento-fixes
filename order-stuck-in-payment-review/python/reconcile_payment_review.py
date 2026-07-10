"""Detect and repair Magento 2 orders stuck in payment_review with no gateway callback.

Magento sets an order's state to payment_review
(Magento\\Sales\\Model\\Order::STATE_PAYMENT_REVIEW) when an asynchronous
gateway (PayPal fraud and risk filters, Adyen, Braintree, or a custom payment
adapter) flags a transaction for manual review before authorizing it. Orders
in this state have no invoice yet, and the admin UI hides the Cancel action
whenever a payment method's isGatewayOrPaymentReviewSufficient / canCancel
logic reports the order as gateway-held. The order can only be released by
the gateway's own async callback (IPN or webhook) calling acceptPayment or
denyPayment. If that callback never arrives, the order sits in
payment_review indefinitely with no cancel path in the admin grid or the
default REST API, silently soft-locking inventory reservations tied to it.

If DRY_RUN=true (default), this only reports each stuck order. If
DRY_RUN=false and the order has total_invoiced == 0, it force-cancels the
order via POST /orders/{id}/cancel and leaves a status history comment.
If total_invoiced > 0, it only posts a flagging comment recommending manual
Accept Payment or Deny Payment review, since a captured payment must go
through the creditmemo and refund flow, not order cancel.
Run on a schedule. Safe to run again and again.
"""
import os
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_payment_review")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
THRESHOLD_HOURS = float(os.environ.get("THRESHOLD_HOURS", "48"))

AUTO_CANCEL_COMMENT = (
    "Auto-cancelled: stuck in payment_review beyond threshold, "
    "no gateway callback received"
)
FLAG_COMMENT = (
    "Flagged: stuck in payment_review beyond threshold with a captured payment. "
    "Needs manual Accept Payment or Deny Payment review in Admin."
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


def magento_post(path, payload=None):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload or {},
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def iso_to_epoch(value):
    text = value.replace(" ", "T", 1)
    return datetime.datetime.fromisoformat(text).replace(
        tzinfo=datetime.timezone.utc
    ).timestamp()


def decide_stuck_order_action(order, now, threshold_hours):
    """Pure decision over fields already fetched from REST. No I/O.

    order: {state, status, createdAt, totalInvoiced, statusHistories}
    statusHistories: list of {createdAt}
    now: datetime (UTC)
    threshold_hours: float
    returns {"action": "skip" | "flag" | "cancel", "reason": str}
    """
    if order.get("state") != "payment_review":
        return {"action": "skip", "reason": "not_in_payment_review"}

    created_at = order.get("createdAt")
    if not created_at:
        return {"action": "skip", "reason": "missing_created_at"}

    age_hours = (now.timestamp() - iso_to_epoch(created_at)) / 3600.0
    if age_hours < threshold_hours:
        return {"action": "skip", "reason": "below_age_threshold"}

    for entry in order.get("statusHistories") or []:
        entry_created = entry.get("createdAt")
        if entry_created and iso_to_epoch(entry_created) > iso_to_epoch(created_at):
            return {"action": "skip", "reason": "gateway_callback_already_progressed"}

    if (order.get("totalInvoiced") or 0) > 0:
        return {"action": "flag", "reason": "payment_captured_needs_manual_review"}

    return {"action": "cancel", "reason": "no_gateway_callback_within_threshold"}


def stuck_payment_review_orders(threshold_hours, page_size=100):
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = (now - datetime.timedelta(hours=threshold_hours)).strftime("%Y-%m-%d %H:%M:%S")
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "state",
        "searchCriteria[filterGroups][0][filters][0][value]": "payment_review",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[filterGroups][1][filters][0][field]": "created_at",
        "searchCriteria[filterGroups][1][filters][0][value]": cutoff,
        "searchCriteria[filterGroups][1][filters][0][conditionType]": "lteq",
        "searchCriteria[sortOrders][0][field]": "created_at",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": 1,
    }
    return magento_get("/orders", params)["items"]


def order_detail(order_id):
    return magento_get(f"/orders/{order_id}")


def cancel_order(order_id):
    return magento_post(f"/orders/{order_id}/cancel")


def add_comment(order_id, comment):
    payload = {
        "statusHistory": {
            "comment": comment,
            "is_customer_notified": 0,
            "is_visible_on_front": 0,
        }
    }
    return magento_post(f"/orders/{order_id}/comments", payload)


def run():
    now = datetime.datetime.now(datetime.timezone.utc)
    cancelled = 0
    flagged = 0
    for summary in stuck_payment_review_orders(THRESHOLD_HOURS):
        order_id = summary.get("entity_id")
        detail = order_detail(order_id)

        order = {
            "state": detail.get("state"),
            "status": detail.get("status"),
            "createdAt": detail.get("created_at"),
            "totalInvoiced": detail.get("total_invoiced"),
            "statusHistories": [
                {"createdAt": h.get("created_at")}
                for h in (detail.get("status_histories") or [])
            ],
        }

        decision = decide_stuck_order_action(order, now, THRESHOLD_HOURS)
        increment_id = detail.get("increment_id")
        payment_method = (detail.get("payment") or {}).get("method")

        if decision["action"] == "skip":
            continue

        if decision["action"] == "flag":
            log.warning(
                "Order %s payment_review with captured payment (method=%s). %s",
                increment_id, payment_method,
                "would flag" if DRY_RUN else "flagging",
            )
            if not DRY_RUN:
                add_comment(order_id, FLAG_COMMENT)
            flagged += 1
            continue

        log.warning(
            "Order %s stuck in payment_review beyond %sh (method=%s). %s",
            increment_id, THRESHOLD_HOURS, payment_method,
            "would cancel" if DRY_RUN else "cancelling",
        )
        if not DRY_RUN:
            cancel_order(order_id)
            add_comment(order_id, AUTO_CANCEL_COMMENT)
        cancelled += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) %s.",
        cancelled, "to cancel" if DRY_RUN else "cancelled",
        flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
