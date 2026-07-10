# Order status wrong after partial or zero total refund

Magento derives order state and status largely from totals such as `total_refunded` and `total_paid`, via `Order::getIsInProcess()`, `Order::setState()`, and the creditmemo save observers, rather than recomputing status from a single authoritative rule each time a credit memo posts. A zero-total credit memo (store-credit-only refunds), a shipping-only refund, or a partial refund on a bundle/configurable item can make the totals comparison come out wrong, leaving a fully refunded order on Processing or Complete, or forcing an order to Closed after only a partial refund.

There is no safe REST write for `order.status` alone, so this reports by default. The only optional write is a status history comment, and only when `DRY_RUN` is false and a human is ready to act on it.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-status-wrong-after-refund/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export DRY_RUN="true"

python order-status-wrong-after-refund/python/flag_status_after_refund.py
node   order-status-wrong-after-refund/node/flag-status-after-refund.js
```

`expected_order_status` (Python) / `expectedOrderStatus` (Node) is a pure function: given an order's totals, its credit memos, and its current status, it returns the expected status and whether that disagrees with reality. Nothing invoiced yet means no refund-driven transition applies. A zero-total credit memo covering the remaining balance counts as fully refunded. A partial refund never forces an order to Closed on its own. The script never writes to `order.status` or `order.state` directly, only an optional status history comment. Start with `DRY_RUN=true` and treat every flagged order as a report for a human to review before triggering the real transition in Admin.

## Test

```bash
pytest order-status-wrong-after-refund/python
node --test order-status-wrong-after-refund/node
```
