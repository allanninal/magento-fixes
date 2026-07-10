# Shared stock not synced across websites

MSI computes salable quantity per stock_id, source item quantity assigned to that stock minus every outstanding reservation keyed by SKU and stock_id. Two websites only share one pool of stock when their sales channels both resolve to the same stock_id. "Not synced" oversell almost always means that mapping drifted, a website's sales channel was reassigned to a different stock, or some legacy or third party code wrote quantity directly into the deprecated `cataloginventory_stock_item` table instead of creating a reservation, bypassing the reservation ledger entirely.

This script resolves each website's actual stock_id, reads its salable quantity for a SKU, and flags any drift or mismatch: a website whose stock_id does not match the expected shared stock, or a quantity disagreement between websites that do share a stock_id. It never reassigns a stock or writes product data, since that stays a deliberate admin decision made in Stores, Configuration, Sales Channels, plus a CLI reindex and manual reservation reconciliation for legacy write paths.

**Full guide with diagrams:** https://www.allanninal.dev/magento/shared-stock-not-synced-across-websites/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export SKU="SKU-1001"
export EXPECTED_SHARED_STOCK_ID="1"
export WEBSITE_CODES="base,eu_website"
export DRY_RUN="true"

python python/detect_stock_desync.py
node   node/detect-stock-desync.js
```

`detect_stock_desync` (Python) and `detectStockDesync` (Node) are pure functions: they take the already fetched per-website reports (website code, resolved stock_id, salable quantity) and the expected shared stock_id, and return whether the group is in sync, which websites drifted onto a different stock_id, and which websites disagree on quantity despite sharing a stock_id. No I/O, no Magento instance needed to test them. The script only ever reads and reports: it does not call any endpoint that reassigns a stock or edits product data, and it exits non-zero when a desync is found so a human can correct the sales channel mapping or investigate a legacy write path.

## Test

```bash
pytest shared-stock-not-synced-across-websites/python
node --test shared-stock-not-synced-across-websites/node
```
