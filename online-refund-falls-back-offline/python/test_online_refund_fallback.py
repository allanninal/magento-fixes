from flag_offline_refund_fallback import evaluate_refund_fallback

GATEWAY_METHODS = ["stripe_payments", "braintree", "authorizenet_acceptjs", "adyen_cc"]


def creditmemo(**over):
    base = {
        "entityId": 501,
        "incrementId": "300000501",
        "orderId": 900,
        "paymentMethod": "stripe_payments",
        "grandTotal": 49.99,
    }
    base.update(over)
    return base


def txn(txn_type, parent_id=None):
    return {"txnType": txn_type, "parentId": parent_id}


def test_flags_gateway_method_with_no_refund_transaction():
    transactions = [txn("order"), txn("capture")]
    result = evaluate_refund_fallback(creditmemo(), transactions, GATEWAY_METHODS)
    assert result["isGatewayMethod"] is True
    assert result["hasRefundTxn"] is False
    assert result["fellBackOffline"] is True


def test_not_flagged_when_refund_transaction_exists():
    transactions = [txn("order"), txn("capture"), txn("refund")]
    result = evaluate_refund_fallback(creditmemo(), transactions, GATEWAY_METHODS)
    assert result["fellBackOffline"] is False


def test_not_flagged_for_offline_payment_method():
    cm = creditmemo(paymentMethod="checkmo")
    result = evaluate_refund_fallback(cm, [], GATEWAY_METHODS)
    assert result["isGatewayMethod"] is False
    assert result["fellBackOffline"] is False


def test_not_flagged_for_unlisted_custom_method():
    cm = creditmemo(paymentMethod="some_custom_offline_method")
    result = evaluate_refund_fallback(cm, [], GATEWAY_METHODS)
    assert result["fellBackOffline"] is False


def test_flags_when_transactions_list_is_empty():
    result = evaluate_refund_fallback(creditmemo(), [], GATEWAY_METHODS)
    assert result["fellBackOffline"] is True


def test_not_flagged_when_only_authorize_and_refund_exist():
    transactions = [txn("authorization"), txn("refund")]
    result = evaluate_refund_fallback(creditmemo(), transactions, GATEWAY_METHODS)
    assert result["fellBackOffline"] is False
