# Salable quantity goes negative or allows oversell

MSI computes salable quantity as `sum(in-stock source_items quantities) - sum(outstanding reservations)`, and reservations are an append-only ledger, not a live decrement of one qty column. If the compensating reservation for a cancelled or failed order is lost, the ledger keeps an orphaned negative entry forever, so the computed salable quantity drifts below zero even though physical stock is fine. Backorders set to allow qty below zero can make salable quantity negative on purpose, which is expected, unless the magnitude no longer matches real open order demand.

This job cross-checks the computed salable quantity, the physical quantity from `source_items`, open order demand, and the backorder config for each SKU. It never rewrites the reservation ledger. It reports every SKU where the invariant is broken, and only ever takes the reversible step of pausing further sales (`is_in_stock=false`) on a confirmed critical oversell. The real ledger repair, `bin/magento inventory:reservation:list-inconsistencies` followed by `inventory:reservation:create-compensations`, stays a CLI-only operation for an admin to run.

**Full guide with diagrams:** https://www.allanninal.dev/magento/salable-quantity-negative-oversell/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export STOCK_ID="1"
export CHECK_SKUS="SKU-1,SKU-2,SKU-3"
export DRY_RUN="true"

python salable-quantity-negative-oversell/python/flag_salable_qty_oversell.py
node   salable-quantity-negative-oversell/node/flag-salable-qty-oversell.js
```

`decide_salable_qty_action` is a pure function: given the salable quantity, the physical quantity, the open order quantity total, and the stock item config (manage stock, backorders), it returns a deterministic `{flag, severity, reason}` verdict without touching the network, the database, or the CLI. Start with `DRY_RUN=true` to review the flagged SKUs first; even with `DRY_RUN=false`, the only write is pausing sales on a confirmed critical oversell.

## Test

```bash
pytest salable-quantity-negative-oversell/python
node --test salable-quantity-negative-oversell/node
```
