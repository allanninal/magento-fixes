# Tax rate wrong when shipping address differs from customer default

Magento resolves the applicable tax zone using the address selected by the store's `Tax Calculation Based On` setting (Billing Address, Shipping Address, or Shipping Origin). For a logged-in customer with more than one saved address, quote and order totals collection can resolve the tax class against the customer's *default* address record instead of re-resolving it against the shipping address actually selected at checkout, especially across multi-address customers or multi-country carts. Confirmed in [magento2 issue 38232](https://github.com/magento/magento2/issues/38232), a French address was taxed at 0% because the customer's default Belgium address was used instead. The tax rule engine itself is deterministic; the defect is an address resolution problem upstream of rule matching, not a rule configuration error.

This script never rewrites `tax_amount` on a placed order, since there is no supported REST endpoint for that. It independently computes the expected rate for the address the store's `based_on` setting points at, compares it to what the order actually applied, and separately flags any order whose shipping address `customer_address_id` differs from the customer's own `default_shipping` or `default_billing` id, the highest risk signature of this leak. It writes a report row plus a non-zero exit code for every order it flags. A human reconciles a confirmed mismatch with a credit memo to refund the wrong tax line, followed by a corrected invoice.

**Full guide with diagrams:** https://www.allanninal.dev/magento/tax-rate-wrong-for-shipping-address/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export ORDER_IDS="1001,1002,1003"
export RATE_EPSILON="0.05"
export DRY_RUN="true"
export REPAIR_CONFIRM="false"   # only meaningful together with DRY_RUN=false

python tax-rate-wrong-for-shipping-address/python/detect_tax_address_mismatch.py
node   tax-rate-wrong-for-shipping-address/node/detect-tax-address-mismatch.js
```

`expected_tax_rate` / `expectedTaxRate` is a pure function: given a resolved address (`country_id`, `region_id`, `postcode`), a customer tax class id, a product tax class id, and fixture tax rule/rate tables, it returns the expected percentage and the winning rule id, mirroring Magento's own rule-priority matching. `detect_tax_mismatch` compares that expected rate to the order's actual applied rate within a rounding `epsilon`, and `is_default_address_leak` flags any order whose shipping address id does not match the customer's own default ids. The script only ever reads from Magento, writes a CSV report, and exits non-zero when it finds at least one mismatch, so CI or alerting notices even with `DRY_RUN=true`. With `DRY_RUN=false` and `REPAIR_CONFIRM=true` it will also post a documentation comment on the order via `/rest/V1/orders/{id}/comments`; it never mutates tax or money on its own.

## Test

```bash
pytest tax-rate-wrong-for-shipping-address/python
node --test tax-rate-wrong-for-shipping-address/node
```
