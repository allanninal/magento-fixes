# Order tax off by rounding between calculation methods

Magento lets a merchant choose `tax/calculation/algorithm` as `UNIT_BASE_CALCULATION` (round tax per unit, then sum), `ROW_BASE_CALCULATION` (round once per line row), or `TOTAL_BASE_CALCULATION` (round once on the grand total). Because each mode rounds at a different point in the arithmetic, the same catalog prices and tax rate can legitimately produce order totals that differ from a naive recomputation by a cent or a fraction of a cent. A script that always assumes one fixed method will produce false-positive "drift" unless it reads which algorithm was active and replicates the same rounding sequence.

This script reads the configured algorithm (environment fallback since `tax/calculation/algorithm` is not in the default `storeConfigs` DTO), pulls orders in an audit window, recomputes expected tax under that same algorithm, and writes a report for anything beyond tolerance. It never writes `tax_amount` on an order, invoice, or credit memo, since Magento has no supported REST write for that once a document exists. It only reports, for finance and tax-ops review.

**Full guide with diagrams:** https://www.allanninal.dev/magento/tax-rounding-drift/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export MAGENTO_TAX_ALGORITHM="ROW_BASE_CALCULATION"
export CREATED_FROM="2026-06-01 00:00:00"
export CREATED_TO="2026-07-01 00:00:00"
export TOLERANCE_CENTS="1"
export DRY_RUN="true"

python python/flag_tax_rounding_drift.py
node   node/flag-tax-rounding-drift.js
```

`decide_tax_drift` (Python) and `decideTaxDrift` (Node) are pure functions: given line items, shipping amount and rate, the configured algorithm, and the order's actual tax, they recompute expected tax with the branch of arithmetic matching that algorithm and return the delta. No I/O, no Magento instance needed to test them. Mixed tax rates make `TOTAL_BASE_CALCULATION` non-comparable, so that case is short-circuited and flagged rather than forced through a wrong single-rate total. The script only ever reads and reports: it never writes to an order's, invoice's, or credit memo's tax total, since Magento exposes no safe REST write for that once a document exists.

## Test

```bash
pytest tax-rounding-drift/python
node --test tax-rounding-drift/node
```
