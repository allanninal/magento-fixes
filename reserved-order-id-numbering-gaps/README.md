# Reserved order ids create unexplained numbering gaps

Magento 2 and Adobe Commerce reserve an order `increment_id` on the quote, through `reserved_order_id` backed by the `sales_sequence` tables, the moment checkout begins, before payment succeeds or the order actually saves. If checkout is abandoned, the gateway declines, or the order-place transaction rolls back, that reserved id is never attached to a real order and the sequence never reuses it. It is a permanent, intentional gap, not a deleted or corrupted order.

This job pages inactive quotes carrying a reserved order id, confirms against the Orders REST API that no order ever claimed that id, classifies each with a pure function, and always reports orphaned gaps. It never rewrites `sales_sequence` or reissues a number. Only when `DRY_RUN` is explicitly set to `false` does it mark the originating quote's `is_active` to `0` over `PUT /rest/V1/carts/{cartId}` so it is excluded from future scans.

**Full guide with diagrams:** https://www.allanninal.dev/magento/reserved-order-id-numbering-gaps/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export PAGE_SIZE="200"
export DRY_RUN="true"

python reserved-order-id-numbering-gaps/python/reconcile_reserved_order_ids.py
node   reserved-order-id-numbering-gaps/node/reconcile-reserved-order-ids.js
```

`classify_reserved_order_gap` is a pure function (already-fetched quote and matching-order arrays go in, no I/O): a quote is `consumed` when a matching order's `incrementId` equals its `reservedOrderId`, `pending_checkout` when it is still active and unmatched, and `orphaned_gap` when it is inactive and unmatched. The only write, gated behind `DRY_RUN=false`, sets `is_active=0` on the quote; nothing ever mutates `sales_sequence` or order numbering. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest reserved-order-id-numbering-gaps/python
node --test reserved-order-id-numbering-gaps/node
```
