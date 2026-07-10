"""Flag Magento 2 credit memos whose total or tax is wrong on a multi invoice order.

Magento's credit memo total collectors (Magento\\Sales\\Model\\Order\\Creditmemo\\Total\\Tax
and the related shipping and discount collectors) compute refundable tax and totals
mainly from the parent order's aggregate tax_amount rather than proportionally from
the specific invoice being refunded. When an order was split into two or more
invoices, each invoice and credit memo pair needs to prorate tax and shipping by the
items actually invoiced and refunded, and the collectors do not consistently subtract
tax already refunded by prior credit memos tied to earlier invoices on the same order.
A credit memo has no supported REST endpoint to mutate its totals after creation, so
this only reports the discrepancy. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/credit-memo-total-wrong-multi-invoice/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_creditmemo_discrepancy")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
TOLERANCE_CENTS = float(os.environ.get("TOLERANCE_CENTS", "0.01"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REFUND_ALLOWLIST = {
    s.strip() for s in os.environ.get("REFUND_ALLOWLIST", "").split(",") if s.strip()
}


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


def orders_complete_or_closed(page_size=200, current_page=1):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "status",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
        "searchCriteria[filterGroups][0][filters][0][value]": "complete,closed",
        "searchCriteria[pageSize]": page_size,
        "searchCriteria[currentPage]": current_page,
    }
    return magento_get("/orders", params)["items"]


def invoices_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
    }
    return magento_get("/invoices", params)["items"]


def creditmemos_for_invoice(invoice_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "invoice_id",
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
        "searchCriteria[filterGroups][0][filters][0][value]": invoice_id,
    }
    return magento_get("/creditmemo", params)["items"]


def normalize_invoice(raw):
    return {
        "entityId": raw.get("entity_id"),
        "baseGrandTotal": raw.get("base_grand_total") or 0.0,
        "baseTaxAmount": raw.get("base_tax_amount") or 0.0,
        "items": [
            {
                "itemId": item.get("item_id") or item.get("order_item_id"),
                "qtyInvoiced": item.get("qty") or 0.0,
                "baseTaxAmount": item.get("base_tax_amount") or 0.0,
                "baseRowTotal": item.get("base_row_total") or 0.0,
            }
            for item in raw.get("items", [])
        ],
    }


def normalize_creditmemo(raw):
    return {
        "entityId": raw.get("entity_id"),
        "incrementId": raw.get("increment_id"),
        "invoiceId": raw.get("invoice_id"),
        "baseGrandTotal": raw.get("base_grand_total") or 0.0,
        "baseTaxAmount": raw.get("base_tax_amount") or 0.0,
        "baseShippingAmount": raw.get("base_shipping_amount") or 0.0,
        "adjustmentPositive": raw.get("adjustment_positive") or 0.0,
        "adjustmentNegative": raw.get("adjustment_negative") or 0.0,
        "items": [
            {
                "itemId": item.get("order_item_id"),
                "qtyRefunded": item.get("qty") or 0.0,
                "baseRowTotal": item.get("base_row_total") or 0.0,
                "baseTaxAmount": item.get("base_tax_amount") or 0.0,
            }
            for item in raw.get("items", [])
        ],
    }


def decide_credit_memo_discrepancy(credit_memo, parent_invoice, prior_credit_memos_for_invoice,
                                    tolerance_cents=0.01):
    invoice_items_by_id = {item["itemId"]: item for item in parent_invoice["items"]}

    expected_tax_amount = 0.0
    expected_items_total = 0.0
    for item in credit_memo["items"]:
        invoice_item = invoice_items_by_id.get(item.get("itemId"))
        if invoice_item and invoice_item["qtyInvoiced"]:
            per_unit_tax = invoice_item["baseTaxAmount"] / invoice_item["qtyInvoiced"]
            per_unit_row = invoice_item["baseRowTotal"] / invoice_item["qtyInvoiced"]
        else:
            per_unit_tax = 0.0
            per_unit_row = item["baseRowTotal"] / item["qtyRefunded"] if item["qtyRefunded"] else 0.0
        expected_tax_amount += per_unit_tax * item["qtyRefunded"]
        expected_items_total += per_unit_row * item["qtyRefunded"]

    expected_grand_total = (
        expected_items_total
        + credit_memo["baseShippingAmount"]
        + expected_tax_amount
        - credit_memo["adjustmentNegative"]
        + credit_memo["adjustmentPositive"]
    )

    delta_grand_total = round(credit_memo["baseGrandTotal"] - expected_grand_total, 2)
    delta_tax_amount = round(credit_memo["baseTaxAmount"] - expected_tax_amount, 2)

    prior_total = sum(cm["baseGrandTotal"] for cm in prior_credit_memos_for_invoice)
    over_refund = (prior_total + credit_memo["baseGrandTotal"]) > (parent_invoice["baseGrandTotal"] + tolerance_cents)

    if over_refund:
        reason = "over_refund"
    elif abs(delta_tax_amount) > tolerance_cents:
        reason = "tax_mismatch"
    elif abs(delta_grand_total) > tolerance_cents:
        reason = "grand_total_mismatch"
    else:
        reason = "ok"

    return {
        "isDiscrepant": reason != "ok",
        "expectedGrandTotal": round(expected_grand_total, 2),
        "expectedTaxAmount": round(expected_tax_amount, 2),
        "deltaGrandTotal": delta_grand_total,
        "deltaTaxAmount": delta_tax_amount,
        "reason": reason,
    }


def compensating_refund(order_id, positive_adjustment):
    """Create a NEW offsetting credit memo. Never edits the flagged record."""
    payload = {
        "arguments": {
            "adjustment_positive": positive_adjustment,
            "adjustment_negative": 0,
        }
    }
    return magento_post(f"/order/{order_id}/refund", payload)


def run():
    flagged = []
    for raw_order in orders_complete_or_closed():
        order_id = raw_order["entity_id"]
        raw_invoices = invoices_for_order(order_id)
        if len(raw_invoices) < 2:
            continue

        for raw_invoice in raw_invoices:
            invoice = normalize_invoice(raw_invoice)
            raw_credit_memos = creditmemos_for_invoice(invoice["entityId"])
            credit_memos = [normalize_creditmemo(cm) for cm in raw_credit_memos]

            for i, credit_memo in enumerate(credit_memos):
                prior = credit_memos[:i]
                result = decide_credit_memo_discrepancy(credit_memo, invoice, prior, TOLERANCE_CENTS)
                if result["isDiscrepant"]:
                    flagged.append({
                        "orderIncrementId": raw_order.get("increment_id"),
                        "creditmemoIncrementId": credit_memo["incrementId"],
                        "invoiceId": invoice["entityId"],
                        "expectedGrandTotal": result["expectedGrandTotal"],
                        "actualGrandTotal": credit_memo["baseGrandTotal"],
                        "expectedTaxAmount": result["expectedTaxAmount"],
                        "actualTaxAmount": credit_memo["baseTaxAmount"],
                        "delta": result["deltaGrandTotal"],
                        "reason": result["reason"],
                    })

    for row in flagged:
        log.warning(
            "Order %s creditmemo %s (invoice %s) is %s. expected grand total %.2f, actual %.2f (delta %.2f).",
            row["orderIncrementId"], row["creditmemoIncrementId"], row["invoiceId"], row["reason"],
            row["expectedGrandTotal"], row["actualGrandTotal"], row["delta"],
        )

    if flagged:
        log.error("%d credit memo(s) discrepant. This script never edits them directly.", len(flagged))
    else:
        log.info("Done. No credit memo discrepancies found.")

    if not DRY_RUN and REFUND_ALLOWLIST:
        for row in flagged:
            if row["orderIncrementId"] in REFUND_ALLOWLIST and row["delta"] < 0:
                log.warning(
                    "Creating compensating refund for order %s (short by %.2f).",
                    row["orderIncrementId"], -row["delta"],
                )
                compensating_refund(row["orderIncrementId"], -row["delta"])


if __name__ == "__main__":
    run()
