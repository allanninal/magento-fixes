# Coupon marked used despite the order never completing

CouponUsagesIncrement hooks beforeSubmit on Magento's QuoteManagement and commits usage counters to `salesrule_coupon`, `salesrule_coupon_usage`, and `salesrule_customer` before the nested submitQuote call actually validates the cart and creates the order. If that validation throws, for example a minimum order amount check fails, the order is never created but the usage increment already committed. This script reconciles each coupon's recorded `times_used` against the orders that actually carry its code and writes a JSON report of the orphaned rows for a human to review. It never writes to the database or calls a write endpoint.

**Full guide with diagrams:** https://www.allanninal.dev/magento/coupon-marked-used-without-order/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export COUPON_CODES="SAVE10,WELCOME20"
export DRY_RUN="true"

python coupon-marked-used-without-order/python/reconcile_coupon_usage.py
node   coupon-marked-used-without-order/node/reconcile-coupon-usage.js
```

`compute_orphaned_coupon_usages` (Python) and `computeOrphanedCouponUsages` (Node) are pure functions: for each coupon, they count the real, non-excluded-state orders that reference its code, subtract that from the recorded `timesUsed`, and flag any positive remainder as orphaned. The only output is a JSON report; there is no code path that decrements `salesrule_coupon`, `salesrule_coupon_usage`, or `salesrule_customer`. Correcting those counters is a separate, controlled database script an operator runs by hand after confirming no retried order is still in flight.

## Test

```bash
pytest coupon-marked-used-without-order/python
node --test coupon-marked-used-without-order/node
```
