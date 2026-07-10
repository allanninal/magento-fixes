# Salable quantity corrupted by bad reservation compensation

Magento's MSI never stores salable quantity. It computes it as source item quantity minus the sum of every `inventory_reservation` row for a SKU and stock. When one order event, place, invoice, ship, cancel, or credit memo, fails to write its compensating reservation, because a cron or async job failed, an upgrade left legacy orders without an initial reservation, or stock got reassigned to a different website mid flight, the running sum of reservations drifts away from the real committed quantity. The reported salable quantity ends up permanently offset, and it never self heals because every later order only stacks another delta on top of the already wrong baseline.

This script cross references source items, the MSI reported salable quantity, and open order items to independently derive the expected salable quantity, and flags any SKU where the two disagree beyond a tolerance. It never writes a reservation row, since there is no REST endpoint for that. The only supported fix is the CLI pair `bin/magento inventory:reservation:list-inconsistencies -r | bin/magento inventory:reservation:create-compensations`, and the script prints that exact command when it flags anything.

**Full guide with diagrams:** https://www.allanninal.dev/magento/salable-quantity-corrupted-by-reservations/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export STOCK_ID="1"
export SKUS="SKU-1001,SKU-1002,SKU-1003"
export RESERVATION_TOLERANCE="0.0001"
export DRY_RUN="true"

python python/flag_salable_qty_corruption.py
node   node/flag-salable-qty-corruption.js
```

`reconcile_salable_qty` (Python) and `reconcileSalableQty` (Node) are pure functions: they take the already fetched source quantity, reported salable quantity, and open order item quantity sum, and return whether the SKU is consistent, the expected salable quantity, and the delta. No I/O, no Magento instance needed to test them. The script only ever reads and reports: it does not write an `inventory_reservation` row, since that is not a REST writable resource. When it flags a SKU it prints the exact CLI command an operator should run.

## Test

```bash
pytest salable-quantity-corrupted-by-reservations/python
node --test salable-quantity-corrupted-by-reservations/node
```
