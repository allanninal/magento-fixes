# Order stuck on pending payment after invoice is paid

Order state and invoice state are two separate write paths in Magento 2 and Adobe Commerce. When a payment gateway webhook, a custom payment module, or an out of process API call creates or updates an invoice and marks it paid without also calling `order.setState(processing).setStatus(...)` and saving the order, the invoice and `total_paid` reflect the successful payment while `order.state` and `status` stay on `new` or `pending_payment`. This job lists candidate orders over the REST API, cross checks each one against its invoices and totals, and reports every mismatch. It does not rewrite the order on its own, since the same symptom can also mean a partial capture, a currency mismatch, or a refund race.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-stuck-pending-payment-after-invoice/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export DRY_RUN="true"

python order-stuck-pending-payment-after-invoice/python/detect_pending_payment_mismatch.py
node   order-stuck-pending-payment-after-invoice/node/detect-pending-payment-mismatch.js
```

`detect_pending_payment_mismatch` is a pure function: an order is flagged only when its state is `new` or `pending_payment` and either a matched invoice reports `state === 2` (paid), or `total_paid` or `total_invoiced` already meets `grand_total`. By default the script only reports flagged orders. Only when `DRY_RUN=false`, and only once a human has confirmed the gateway actually captured the funds, does it send a narrowly scoped `PUT /rest/V1/orders` that sets just `state` and `status` to `processing`, never touching invoice or payment records. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-stuck-pending-payment-after-invoice/python
node --test order-stuck-pending-payment-after-invoice/node
```
