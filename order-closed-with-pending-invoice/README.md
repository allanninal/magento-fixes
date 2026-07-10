# Order closed prematurely while invoice is still pending

Magento's `Sales/Model/ResourceModel/Order/Handler/State::check()` closes an order once it is not canceled, cannot be put on hold, `canInvoice()` is false, and `canShip()` is false, meaning every item is fully shipped. It never checks whether an existing invoice is still open (`state = 1`, "Pending"). An invoice created Not Capture, followed by a full shipment, closes the order even though `total_due` is still greater than zero.

There is no safe REST write for `order.state` or `order.status`, so this reports by default. The only allowed write is on the invoice itself, capture or void, and only when `DRY_RUN` is false and a human has confirmed the real payment status off platform.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-closed-with-pending-invoice/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export DRY_RUN="true"

python order-closed-with-pending-invoice/python/flag_premature_closure.py
node   order-closed-with-pending-invoice/node/flag-premature-closure.js
```

`classify_premature_closure` (Python) / `classifyPrematureClosure` (Node) is a pure function: an order is flagged only when its status is `closed`, a shipment exists for it, at least one of its invoices is still `state = 1` (open/Pending), and it still has an outstanding balance. The script never writes to `order.state` or `order.status`. Start with `DRY_RUN=true` and treat every flagged order as a report for a human to review before capturing or voiding the pending invoice.

## Test

```bash
pytest order-closed-with-pending-invoice/python
node --test order-closed-with-pending-invoice/node
```
