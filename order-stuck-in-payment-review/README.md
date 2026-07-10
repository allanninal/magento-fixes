# Order stuck in payment review with no way out

Magento sets an order's state to `payment_review` when an asynchronous gateway (PayPal fraud and risk filters, Adyen, Braintree, or a custom payment adapter) flags a transaction for manual review before authorizing it. Orders in this state have no invoice yet, and the admin UI hides the Cancel action whenever the payment method reports the order as gateway-held. The order can only be released by the gateway's own async callback (IPN or webhook) calling acceptPayment or denyPayment. If that callback never arrives, the order sits in `payment_review` indefinitely with no cancel path in the admin grid or the default REST API, silently soft-locking inventory reservations tied to it.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-stuck-in-payment-review/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export THRESHOLD_HOURS="48"
export DRY_RUN="true"

python order-stuck-in-payment-review/python/reconcile_payment_review.py
node   order-stuck-in-payment-review/node/reconcile-payment-review.js
```

`decide_stuck_order_action` (Python) / `decideStuckOrderAction` (Node) is a pure function: given an order's state, status, created_at, total_invoiced, and status_histories, plus the current time and an age threshold, it returns `skip`, `flag`, or `cancel`. It skips anything not in `payment_review`, anything younger than the threshold, and anything whose status history shows a change after creation (proof a gateway callback already fired, so cron will catch up). If the threshold is passed with no callback, it flags orders with a captured payment (`total_invoiced > 0`) for manual Accept Payment or Deny Payment review, and only cancels the ones with nothing captured yet. Start with `DRY_RUN=true` and review the list before letting it write.

## Test

```bash
pytest order-stuck-in-payment-review/python
node --test order-stuck-in-payment-review/node
```
