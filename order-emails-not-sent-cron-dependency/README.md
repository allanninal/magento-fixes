# Order confirmation emails silently stop sending

Magento 2 and Adobe Commerce send sales emails (order, invoice, shipment, credit memo) through an asynchronous queue when Asynchronous sending is enabled, which is the default in modern versions. Placing an order only writes `send_email=1` and `email_sent=null` on `sales_order`; the actual send happens later, when the `sales_send_order_emails` cron job runs. If the Magento cron scheduler is dead, no dropped crontab entry, a stuck `cron_schedule` row, a fatal error in another job, that job never fires, and the queue never drains. Checkout, payment, and inventory all still succeed, so nobody notices until a customer asks where their confirmation email is.

`cron_schedule` has no REST endpoint and the real `send_email`/`email_sent` flags are not on the default order DTO, so this job polls `GET /rest/V1/orders` for orders created more than a threshold ago and still open, and uses that backlog as the detectable proxy for a stuck email queue. It never sends an email or writes to an order. It only reports, per stale order, `entity_id`, `increment_id`, `created_at`, and `minutes_overdue`, plus a `CRON_LIKELY_DOWN` flag once the backlog is large or old enough, so an operator can go run the real fix.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-emails-not-sent-cron-dependency/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export STALE_MINUTES="30"
export BACKLOG_ALERT_COUNT="5"
export DRY_RUN="true"

python order-emails-not-sent-cron-dependency/python/flag_cron_email_backlog.py
node   order-emails-not-sent-cron-dependency/node/flag-cron-email-backlog.js
```

`classify_cron_email_backlog` (Python) and `classifyCronEmailBacklog` (Node) are pure functions that take a plain list of orders and a fixed clock string and decide which orders are stale and whether the backlog signals `CRON_LIKELY_DOWN`, so the decision is fully testable without a network call. This script never sends an email or modifies an order; `DRY_RUN` only affects log verbosity, since there is no unsafe write path to gate. When it reports `CRON_LIKELY_DOWN`, the real fix is to run `bin/magento cron:run`, check `bin/magento cron:install` and the system crontab, or query `cron_schedule` directly to clear a stuck row.

## Test

```bash
pytest order-emails-not-sent-cron-dependency/python
node --test order-emails-not-sent-cron-dependency/node
```
