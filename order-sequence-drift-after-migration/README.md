# Order sequence drift after migration

Magento 2 numbers orders from dedicated `sequence_order_<store>` tables, tracked via `sales_sequence_meta` and `sales_sequence_profile`, completely separate from the `sales_order` table's own `entity_id` auto increment column. A migration from Magento 1 with the data-migration-tool, or a manual DB import or restore, commonly copies `sales_order` rows without correctly re-seeding the sequence table's last issued value, so the sequence reissues an `increment_id` that already exists (a collision) or jumps far past the last real order (a gap).

There is no REST endpoint that rewrites sequence state, so this job only detects and reports the drift, per `store_id`, with the recommended `AUTO_INCREMENT` reset value. The actual repair is a manual `ALTER TABLE sequence_order_<store>_<entity_type> AUTO_INCREMENT = <value>` run by a DBA directly against the database.

**Full guide with diagrams:** https://www.allanninal.dev/magento/order-sequence-drift-after-migration/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export GAP_THRESHOLD="1000"
export PAGE_SIZE="200"
export DRY_RUN="true"

python order-sequence-drift-after-migration/python/detect_sequence_drift.py
node   order-sequence-drift-after-migration/node/detect-sequence-drift.js
```

`detect_sequence_drift` is a pure function: it takes the full list of orders and a per-store prefix map, strips each store's known prefix from `increment_id` to get a numeric value, groups by `store_id`, and returns duplicates (same numeric value across more than one `entity_id`), gaps (consecutive numeric deltas beyond `GAP_THRESHOLD`), and the recommended `AUTO_INCREMENT` reset value per store (max numeric value plus one). The script never writes to a sequence table. When drift is found it logs a full report and exits non-zero, so it fails loudly in a cron job or CI check. A human runs the `ALTER TABLE` step and places a real test order to confirm before the flag is cleared.

## Test

```bash
pytest order-sequence-drift-after-migration/python
node --test order-sequence-drift-after-migration/node
```
