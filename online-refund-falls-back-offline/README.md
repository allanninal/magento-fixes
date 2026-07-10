# Online refund silently falls back to offline

The admin credit memo form in Magento 2 only offers an online refund when the payment method's gateway adapter reports `canRefund` or `canRefundPartialPerInvoice` as true for that invoice's capture transaction. If the capture cannot be found, or the gateway call fails, Magento quietly narrows the form to offline only, with no visible error. If a human submits that form, Magento creates a normal looking credit memo and marks the order refunded, but the payment gateway was never called and the customer's money never moved. This job lists recent credit memos over the REST API, checks each order's transactions for a matching refund, and reports every credit memo on a gateway backed method that has none.

**Full guide with diagrams:** https://www.allanninal.dev/magento/online-refund-falls-back-offline/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export LOOKBACK_DAYS="7"
export GATEWAY_METHODS="stripe_payments,braintree,authorizenet_acceptjs,adyen_cc"
export DRY_RUN="true"

python online-refund-falls-back-offline/python/flag_offline_refund_fallback.py
node   online-refund-falls-back-offline/node/flag-offline-refund-fallback.js
```

`evaluate_refund_fallback` is a pure function: it checks whether the credit memo's payment method is one of your configured gateway backed methods, and if so whether the order's transaction list contains any transaction of type `refund`. A gateway method with no refund transaction is reported as a silent offline fallback. Offline only methods, such as `checkmo` or `banktransfer`, are never flagged, since offline is the correct and only path there. By default the script only reports flagged credit memos. There is no supported endpoint that converts an existing offline credit memo into a real gateway refund, so this script never calls a payment gateway and never creates a new credit memo. `DRY_RUN` only changes log verbosity here. The actual fix, refunding the customer for real, has to happen in the payment gateway's own dashboard or API, confirmed by a human against the amount already recorded in Magento.

## Test

```bash
pytest online-refund-falls-back-offline/python
node --test online-refund-falls-back-offline/node
```
