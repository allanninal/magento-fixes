# Partial refund tax computed from the full order instead of the refunded items

Magento's credit memo tax totals collector is supposed to prorate tax per line item using the quantity being refunded versus the quantity invoiced. Long standing bugs, seen across magento2 GitHub issues 8797, 9929, 10982, 14713, 23938, 32222, and 34586, instead cause it to copy the order's full `tax_amount` and `base_tax_amount` onto the credit memo, notably when the credit memo is created from the admin order view, when multiple partial credit memos are issued against the same invoice, or when the display currency differs from the base currency. `CreditmemoItemInterface.tax_amount` is a snapshot stored at creation time, never re-derived later, so a wrong number stays wrong forever.

This script cross references each order's items against every credit memo issued for that order, independently recomputes the expected proportional tax, and flags any credit memo whose `base_tax_amount` disagrees beyond a small epsilon, especially the tell tale case where a partial refund carries a full order's worth of tax. It never edits a credit memo, since there is no REST endpoint for that. It only reports, and, only under an explicit `DRY_RUN=false`, optionally issues a brand new corrective refund call carrying an `adjustment_positive` or `adjustment_negative` argument, never a write to the original document.

**Full guide with diagrams:** https://www.allanninal.dev/magento/partial-refund-tax-miscalculated/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export ORDER_IDS="1001,1002,1003"
export TAX_EPSILON="0.01"
export DRY_RUN="true"

python python/flag_creditmemo_tax_mismatch.py
node   node/flag-creditmemo-tax-mismatch.js
```

`is_creditmemo_tax_mismatched` (Python) and `isCreditMemoTaxMismatched` (Node) are pure functions: they take the order item's tax amount and ordered quantity, the credit memo line's refunded quantity, and the credit memo's reported base tax amount, and return the expected proportional tax, the delta, and whether it is mismatched beyond the epsilon. No I/O, no Magento instance needed to test them. The script only ever reads and reports: it does not edit an existing credit memo, since that is not a REST writable resource. When `DRY_RUN=false` and a credit memo is flagged, it POSTs a new corrective refund call with an `adjustment_positive` or `adjustment_negative` argument; in dry run it only prints that payload.

## Test

```bash
pytest partial-refund-tax-miscalculated/python
node --test partial-refund-tax-miscalculated/node
```
