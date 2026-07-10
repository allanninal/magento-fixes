# Coupon usage limit not enforced, allowing unlimited reuse

Since Magento 2.4.3, coupon usage bookkeeping (`salesrule_coupon.times_used`, `salesrule_customer.times_used`, and the `salesrule_coupon_usage` rows) is incremented asynchronously by the `sales.rule.update.coupon.usage` message queue consumer instead of during order placement. If that consumer is not running, lags under load, or the order placement fails after the coupon is applied but before the queue message is consumed, `times_used` never increments even though the coupon was used on a real order, so `uses_per_coupon` and `uses_per_customer` silently stop being enforced. This job lists active coupon rules and their coupons over the REST API, independently counts real usage from actual orders filtered by `coupon_code`, and reports every discrepancy. It never cancels, refunds, or holds an order on its own.

**Full guide with diagrams:** https://www.allanninal.dev/magento/coupon-usage-limit-not-enforced/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export DRY_RUN="true"

python coupon-usage-limit-not-enforced/python/evaluate_coupon_usage.py
node   coupon-usage-limit-not-enforced/node/evaluate-coupon-usage.js
```

`evaluate_coupon_usage` is a pure function: it filters out cancelled orders, counts real usage per coupon and per customer, and flags a violation when the real count exceeds `uses_per_coupon`, any customer's real count exceeds `uses_per_customer`, or the reported `times_used` is lower than the real count (evidence the async consumer under-counted). By default the script only reports flagged coupons with the offending order increment ids. It never places holds, cancels, or refunds those orders, since that is a business and legal decision for a human.

The only corrective action, gated behind `DRY_RUN=false` **and** an explicit `--apply` flag, recomputes and writes `times_used` on the coupon to match the true, real order count. After applying it, confirm the `sales.rule.update.coupon.usage` consumer is actually running (`bin/magento queue:consumers:start sales.rule.update.coupon.usage`, or check your consumer/cron process manager) so the counters do not drift again.

Start with `DRY_RUN=true` and without `--apply` to review the list first.

## Test

```bash
pytest coupon-usage-limit-not-enforced/python
node --test coupon-usage-limit-not-enforced/node
```
