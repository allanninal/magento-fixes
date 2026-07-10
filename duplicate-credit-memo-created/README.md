# Duplicate credit memo created for one refund action

Magento does not guard credit memo creation with an idempotency key. The admin Refund controller, the REST `POST /V1/order/{id}/refund` and `POST /V1/creditmemo` endpoints, and payment gateway async notifications such as a PayPal Payflow IPN all call `CreditmemoService::refund()` independently. If the same refund fires twice in close succession, two `sales_creditmemo` records can land against the same invoice before the first transaction commits. This job lists credit memos over the REST API, groups them by order, clusters records whose amount and timestamp are close enough to be the same refund fired twice, and reports every duplicate group it finds.

**Full guide with diagrams:** https://www.allanninal.dev/magento/duplicate-credit-memo-created/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export LOOKBACK_DAYS="7"
export TOLERANCE_SECONDS="60"
export AMOUNT_EPSILON="0.01"
export DRY_RUN="true"

python duplicate-credit-memo-created/python/flag_duplicate_creditmemos.py
node   duplicate-credit-memo-created/node/flag-duplicate-creditmemos.js
```

`detect_duplicate_credit_memos` is a pure function: it groups input records by `order_id`, sorts each group by `created_at`, and clusters records whose `grand_total` differs by no more than `amount_epsilon` (default one cent) and whose `created_at` differs by no more than `tolerance_seconds` (default 60). Any order with more than one record in a cluster is reported with its duplicate entity ids and the excess amount refunded. By default the script only reports flagged duplicates. There is no supported REST endpoint to delete a creditmemo, and cancelling one that already triggered a real gateway refund would desynchronize the books without reversing the money, so this script never cancels, deletes, or creates a creditmemo. `DRY_RUN` only changes log verbosity here. Any real correction, such as leaving a review comment through `PUT /rest/V1/creditmemo/{id}/comments`, belongs behind its own separate guard and a human sign-off.

## Test

```bash
pytest duplicate-credit-memo-created/python
node --test duplicate-credit-memo-created/node
```
