# Credit memo grand total not refreshed after adjustment edit

In the admin credit memo creation form, the grand total shown and saved is only recalculated by the `Update Qty's` JavaScript handler, which fires on item quantity changes. It is never wired to the Refund Shipping, Adjustment Refund (`adjustment_positive`), or Adjustment Fee (`adjustment_negative`) input fields, so editing those alone can leave `grand_total` stale in both the UI and the persisted record unless a qty update or the actual refund submission forces Magento's server side total collectors to run. The same drift is reachable through `POST /V1/creditmemo`, since the API does not independently re-validate the total. This job lists recent credit memos over the REST API, recomputes the expected `grand_total` from each one's own fields, and reports every record that drifts.

**Full guide with diagrams:** https://www.allanninal.dev/magento/credit-memo-total-not-refreshed/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export LOOKBACK_DAYS="7"
export EPSILON="0.01"
export DRY_RUN="true"

python credit-memo-total-not-refreshed/python/flag_creditmemo_total_drift.py
node   credit-memo-total-not-refreshed/node/flag-creditmemo-total-drift.js
```

`evaluate_creditmemo_total_drift` is a pure function: it recomputes `expected_grand_total` as `subtotal - discount_amount + shipping_amount + tax_amount + adjustment_positive - adjustment_negative`, rounds to two decimal places, and flags drift when the absolute delta against the stored `grand_total` exceeds a small epsilon (default one cent). By default the script only reports flagged credit memos. There is no supported `PUT` or `PATCH` endpoint to overwrite a posted creditmemo's `grand_total`, since creditmemos are treated as immutable financial records, so this script never writes to an existing one. `DRY_RUN` only changes log verbosity here. A real correction has to run through Magento's own total collectors, reviewed and approved by a human, in the admin or a separate guarded script.

## Test

```bash
pytest credit-memo-total-not-refreshed/python
node --test credit-memo-total-not-refreshed/node
```
