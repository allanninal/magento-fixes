# Duplicate or colliding order increment id

Magento 2 and Adobe Commerce generate `increment_id` from the `sales_sequence_meta` and `sales_sequence_profile` tables, which store a per-store prefix, pad length, and step rather than one global counter. A Magento 1 to Magento 2 migration through the `data-migration-tool`, or a later multi-store-view reconfiguration, can leave a sequence profile's prefix keyed to the wrong scope, or leave two profiles pointing at the same underlying sequence table and start value. Two independent order streams then generate the same padded `increment_id` for two different `entity_id` rows in `sales_order`, even though `entity_id` itself stays unique, which breaks increment_id based lookups: payment gateway return URLs, ERP sync keys, and customer-facing order lookup.

`sales_sequence_meta` and `sales_sequence_profile` have no REST endpoint, so this job pages `GET /rest/V1/orders`, requesting only `entity_id`, `increment_id`, `store_id`, `created_at`, `status`, and `customer_email` through the `fields` query parameter, and groups every order by `increment_id`. Any group with more than one distinct `entity_id` is a collision. It never renumbers `increment_id`, since that value is already referenced by payment gateway return URLs, invoices and shipments, and ERP records. It always reports every collision, and only when `DRY_RUN=false` is explicitly set does it post a non destructive status history comment on the duplicate orders via `POST /rest/V1/orders/{id}/comments`, so support and ERP staff see a visible marker while a human corrects the actual `sales_sequence_profile` row through CLI or a database migration script.

**Full guide with diagrams:** https://www.allanninal.dev/magento/duplicate-order-increment-id/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export PAGE_SIZE="200"
export DRY_RUN="true"

python duplicate-order-increment-id/python/find_duplicate_increment_ids.py
node   duplicate-order-increment-id/node/find-duplicate-increment-ids.js
```

`find_duplicate_increment_ids` (Python) and `findDuplicateIncrementIds` (Node) are pure functions that take a plain list of orders and group them by `incrementId` with no I/O, keeping only groups where more than one distinct `entityId` shares an `incrementId`. Groups come back sorted by `incrementId` ascending, and each group's members are sorted by `createdAt` ascending so the first-created order is always `members[0]`. With `DRY_RUN=true`, the default, the script only prints the collision report. With `DRY_RUN=false`, it additionally posts a status history comment on every duplicate after `members[0]`, never a write to `increment_id` itself. The real fix, correcting `sales_sequence_profile.prefix` and pad length or reseeding the `sales_sequence_XXX` table, has to be done through CLI or a database migration script.

## Test

```bash
pytest duplicate-order-increment-id/python
node --test duplicate-order-increment-id/node
```
