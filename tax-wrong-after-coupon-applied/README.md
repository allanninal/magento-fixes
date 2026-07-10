# Tax recalculated incorrectly after coupon applied

Magento builds order totals through a chain of total collector models: Subtotal, then Discount, then Tax, then Grand Total. Whether that chain reconciles depends on Sales, Tax, Calculation Settings for Apply Customer Tax (Before Discount or After Discount) and Apply Discount on Prices (Excluding Tax or Including Tax). When those settings disagree with how catalog prices are entered, or a cart price rule coupon meets tax inclusive catalog prices, the discount collector reduces the row total using one base while the tax collector recomputes `tax_amount` from the pre discount unit price, so `discount_tax_compensation_amount` ends up wrong or zero and `base_row_total` minus `base_discount_amount` plus `base_tax_amount` no longer equals `base_grand_total`. This is a recurring defect class, seen across magento2 GitHub issues 8964, 19494, 29506, and 26597, and Adobe Commerce shipped Quality Patch ACSD-61200 for discount tax compensation specifically.

This script pages through every order that carries a coupon code, independently recomputes the expected tax and grand total from the order's own item data, and flags any order whose reported totals disagree beyond a small epsilon. It never edits an order, since there is no REST endpoint that rewrites a placed order's totals. It only reports, for manual finance review or reprocessing through a credit memo plus corrected re-invoice.

**Full guide with diagrams:** https://www.allanninal.dev/magento/tax-wrong-after-coupon-applied/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export TAX_EPSILON="0.01"
export PAGE_SIZE="100"
export DRY_RUN="true"

python python/reconcile_coupon_tax.py
node   node/reconcile-coupon-tax.js
```

`reconcile_order_tax` (Python) and `reconcileOrderTax` (Node) are pure functions: they take an order's baseSubtotal, baseDiscountAmount, baseTaxAmount, baseShippingAmount, baseShippingTaxAmount, baseShippingDiscountAmount, baseGrandTotal, and an items array of baseRowTotal, baseDiscountAmount, baseDiscountTaxCompensationAmount, and taxPercent, and return whether the order reconciles plus the expected tax, expected grand total, deltas, and per item deltas. No I/O, no Magento instance needed to test them. The script only ever reads and reports: it never writes to an order, since order totals are not a REST writable resource once the order is placed.

## Test

```bash
pytest tax-wrong-after-coupon-applied/python
node --test tax-wrong-after-coupon-applied/node
```
