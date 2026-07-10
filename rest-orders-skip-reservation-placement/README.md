# REST created orders skip reservation placement

MSI reduces salable quantity only by writing an append only, negative row to `inventory_reservation`. That row is written by a plugin hooked to the `sales_order_place_after` event, which fires from the normal quote to order checkout pipeline, `OrderManagementInterface::place`. An order built and persisted directly through `POST /V1/orders`, the way ERPs and marketplaces inject historical or external orders, never runs that pipeline, so the reservation plugin never executes for those items. The order gets real `order_items` rows and a decremented product quantity, but zero matching `inventory_reservation` rows, so MSI's salable quantity calculation still reports the item as sellable when it is not.

This script lists recent open orders, sums `qty_ordered` per SKU, and cross checks that against source item quantity minus reported salable quantity for the same SKU. Any shortfall means a reservation was never written, and it is attributed back to the earliest under reserved order lines. There is no REST endpoint to create a reservation, so this script only reports by default. Only when an operator sets `DRY_RUN=false` and has confirmed a finding does it fall back to the one safe REST lever available, a guarded, idempotent adjustment of the legacy `stock_item.qty` through `PUT /rest/V1/products/{sku}`.

**Full guide with diagrams:** https://www.allanninal.dev/magento/rest-orders-skip-reservation-placement/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
export STOCK_ID="1"
export ORDER_STATUSES="processing,pending"
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python python/flag_unreserved_orders.py
node   node/flag-unreserved-orders.js
```

`find_unreserved_order_items` (Python) and `findUnreservedOrderItems` (Node) are pure functions: they take the already fetched open orders with their items, source quantity per SKU, and salable quantity per SKU, and return one finding per under-reserved order and SKU pair with the missing reservation quantity. No I/O, no Magento instance needed to test them. The script only ever reads and reports by default: it does not write an `inventory_reservation` row, since that is not a REST writable resource. The guarded stopgap correction only runs with `DRY_RUN=false` and tracks applied `increment_id` and SKU pairs in a small ledger file so it is never applied twice.

## Test

```bash
pytest rest-orders-skip-reservation-placement/python
node --test rest-orders-skip-reservation-placement/node
```
