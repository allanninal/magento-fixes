# Duplicate SKU created through concurrent API or import saves

Magento 2 and Adobe Commerce enforce SKU uniqueness with a unique index on `catalog_product_entity.sku`, but `ProductRepository::save()` and the import and bulk API code paths first do an application-level lookup, an in-memory instance cache or a SELECT by sku, to decide insert versus update, before that index ever runs. When two saves race, two REST `POST /V1/products` calls, or a concurrent import bunch and an async bulk `/rest/async/bulk/V1/products` call, both can see "SKU not found" in the same window and both proceed to insert. One of the two either hits the unique key error, which shows up as bulk operation status 3, or in older or inconsistent code paths actually commits a second `entity_id` under the same SKU string.

This job pages `GET /rest/V1/products` filtered by `updated_at` with a `gteq` lookback window, groups every product by a normalized SKU (trimmed and lowercased, since Magento allows whitespace variants of the same visible SKU), and flags any group with more than one distinct `id`. It never merges or deletes a product entity, since either could already be referenced by an order line item, a CMS block link, or an inventory reservation. It always reports every collision, confirmed against the single-SKU `GET /rest/V1/products/{sku}` lookup, and only when `DRY_RUN=false` is explicitly set and exactly one of the duplicate entities has zero orders against it does it disable that one entity with `{"product":{"status":2}}`, a reversible first step. A DELETE is never part of the same run.

**Full guide with diagrams:** https://www.allanninal.dev/magento/duplicate-sku-race-condition/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export LOOKBACK_HOURS="24"
export PAGE_SIZE="200"
export DRY_RUN="true"

python duplicate-sku-race-condition/python/find_sku_collisions.py
node   duplicate-sku-race-condition/node/find-sku-collisions.js
```

`find_sku_collisions` (Python) and `findSkuCollisions` (Node) are pure functions that take a plain list of products and group them by normalized SKU with no I/O, keeping only groups where more than one distinct `id` shares a SKU. Groups come back sorted by SKU ascending, and each group's `entity_ids` and `created_at` timestamps are sorted ascending, so the first-created entity is always index 0 and later entries are the race-created duplicates. With `DRY_RUN=true`, the default, the script only prints the collision report. With `DRY_RUN=false`, it additionally disables one entity, and only when exactly one of the pair has zero orders on file, never a merge or a delete.

## Test

```bash
pytest duplicate-sku-race-condition/python
node --test duplicate-sku-race-condition/node
```
