# Credit memo total wrong on multi invoice orders

Magento's credit memo total collectors (`Magento\Sales\Model\Order\Creditmemo\Total\Tax` and the related shipping and discount collectors) compute refundable tax and totals mainly from the parent order's aggregate `tax_amount` rather than proportionally from the specific invoice being refunded. When an order was split into two or more invoices, each invoice and credit memo pair needs to prorate tax and shipping by the items actually invoiced and refunded, and the collectors do not consistently subtract tax already refunded by prior credit memos tied to earlier invoices on the same order (`allowedTax` and `allowedBaseTax` are not scoped per invoice). A credit memo on the second or later invoice can end up double counting or omitting tax and shipping.

A credit memo is an immutable financial record with no supported REST endpoint to mutate its totals, so this job only reports the discrepancy. For every order with more than one invoice, it pulls each credit memo alongside its parent invoice, prorates the invoice's own per-item tax and row totals by the refunded quantity to get an expected tax and grand total, and flags every credit memo whose actual totals drift past a cent of tolerance, or whose refunds against one invoice in total exceed what that invoice ever carried.

**Full guide with diagrams:** https://www.allanninal.dev/magento/credit-memo-total-wrong-multi-invoice/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export TOLERANCE_CENTS="0.01"
export DRY_RUN="true"

python credit-memo-total-wrong-multi-invoice/python/flag_creditmemo_discrepancy.py
node   credit-memo-total-wrong-multi-invoice/node/flag-creditmemo-discrepancy.js
```

`decide_credit_memo_discrepancy` (Python) and `decideCreditMemoDiscrepancy` (Node) are pure functions that take a credit memo, its parent invoice, and any prior credit memos already issued against that same invoice, and return the expected totals, the deltas, and a reason: `tax_mismatch`, `grand_total_mismatch`, `over_refund`, or `ok`. The decision is fully testable without a network call. `DRY_RUN` defaults to true and gates the only unsafe path: an explicit, opt-in compensating refund that creates a **new** offsetting credit memo via `POST /rest/V1/order/{orderId}/refund` with `arguments.adjustment_positive` for order increment ids in `REFUND_ALLOWLIST`. It never edits the original discrepant record. Without both `DRY_RUN=false` and an allowlist, the script only reports and never writes anything.

## Test

```bash
pytest credit-memo-total-wrong-multi-invoice/python
node --test credit-memo-total-wrong-multi-invoice/node
```
