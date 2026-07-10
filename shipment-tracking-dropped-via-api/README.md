# Shipment tracking number dropped when created via API

When you call `POST /V1/order/{orderId}/ship` with a `tracks` array, Magento's `ShipOrder` service calls `shipment.setTracks(tracksData)`, which only assigns plain track data to the model and never populates the shipment's internal tracks collection. `Magento\Sales\Model\ResourceModel\Order\Shipment\Relation::processRelation()` persists tracks by iterating that collection on save, so the track rows are silently never written to `sales_shipment_track`, even though the shipment itself saves and returns a 200 with a new shipment ID. It is a documented core defect (`magento/magento2#13954`, `#13248`), not user error.

This script reports every shipment that has line items but no tracks by default. It only repairs a shipment when you separately supply the expected track data (for example from a log of the original ship request, or a carrier confirmation), using the dedicated `POST /rest/V1/shipment/track` endpoint rather than retrying the broken ship call, and it re-verifies the fix afterward.

**Full guide with diagrams:** https://www.allanninal.dev/magento/shipment-tracking-dropped-via-api/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export ORDER_ID="123"
export DRY_RUN="true"   # start safe, change to false to allow the repair path

python python/detect_dropped_tracking.py
node   node/detect-dropped-tracking.js
```

`decide_track_repair` (Python) / `decideTrackRepair` (Node) is a pure function with no I/O: it takes a shipment's `items` and `tracks` plus an optional expected track and returns one of four actions.

- `skip_no_items`: the shipment has no line items, so it is not a real shipment to worry about.
- `skip_has_tracks`: the shipment already has tracking, nothing to do.
- `flag_missing_track`: the shipment has items but no tracks, and no source of truth track data is known, so it is only reported for a human to check.
- `repair_add_track`: the shipment has items, no tracks, and an expected track is known, so it is safe to POST to `/rest/V1/shipment/track`.

Only `repair_add_track` ever leads to a write, and only when `DRY_RUN=false`. The write goes through the dedicated track-add endpoint, not the broken ship call, and the script re-fetches the shipment afterward to confirm `tracks` is now non-empty before counting it as repaired.

## Test

```bash
pytest python
node --test node
```
