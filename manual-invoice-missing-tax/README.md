# Manual invoice missing tax leaves a false amount due

When an admin manually invoices an order in more than one pass, for example invoicing simple products separately from a virtual product via Sales, Orders, Invoice, Magento's invoice totals collectors are supposed to prorate tax across invoices by each item's invoiced quantity ratio. A documented core bug, [magento2 issue 38978](https://github.com/magento/magento2/issues/38978), reproduced on 2.4.3-p3, causes the tax portion belonging to items on a later invoice to be dropped instead of allocated. That invoice's `base_tax_amount` and `base_grand_total` come out short, so the order's `total_paid` ends up less than `base_grand_total` and `total_due` shows a balance that should not exist even though every item is invoiced.

This script never edits, voids, or cancels an invoice, since Magento has no supported REST write for that. It reads each order's own totals, sums what its invoices actually total, and writes a report row plus a non-zero exit code for every order it flags. A human reconciles flagged orders in the Admin, for example with a credit memo without invoice or by cancelling and reissuing the affected invoice.

**Full guide with diagrams:** https://www.allanninal.dev/magento/manual-invoice-missing-tax/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export ORDER_IDS="1001,1002,1003"
export AMOUNT_EPSILON="0.01"
export DRY_RUN="true"

python manual-invoice-missing-tax/python/detect_invoice_tax_shortfall.py
node   manual-invoice-missing-tax/node/detect-invoice-tax-shortfall.js
```

`detect_invoice_tax_shortfall` / `detectInvoiceTaxShortfall` is a pure function: it takes plain numeric structs for the order (`baseGrandTotal`, `baseTaxAmount`, `totalDue`) and its invoices (`baseGrandTotal`, `baseTaxAmount` each), and flags the order only when `totalDue` is real and both the grand total and the tax fall short by more than `epsilon`, the tell tale signature of a dropped tax slice rather than a legitimately un-invoiced item. The script only ever reads from Magento; it writes a CSV report and exits non-zero when it finds at least one shortfall, so CI or alerting notices even with `DRY_RUN=true`.

## Test

```bash
pytest manual-invoice-missing-tax/python
node --test manual-invoice-missing-tax/node
```
