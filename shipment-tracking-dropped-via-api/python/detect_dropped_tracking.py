"""Detect and safely repair Magento 2 shipments with a dropped tracking number.

POST /V1/order/{orderId}/ship with an inline tracks array routes through
ShipOrder, which calls shipment.setTracks(tracksData). setTracks() only
assigns plain data to the model and never populates the shipment's tracks
collection, so Relation::processRelation(), which persists tracks by
iterating that collection on save, writes nothing to sales_shipment_track.
The shipment still saves and returns a 200 with a new shipment ID, so the
drop is silent. This is a documented core defect (magento/magento2#13954,
#13248), not user error.

This script reports every shipment with items but no tracks by default, and
only repairs it when you separately supply the expected track data, using
the dedicated POST /rest/V1/shipment/track endpoint rather than retrying the
broken ship call. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/magento/shipment-tracking-dropped-via-api/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_dropped_tracking")

MAGENTO_URL = os.environ.get("MAGENTO_URL", "https://demo.example.com").rstrip("/")
TOKEN = os.environ.get("MAGENTO_ADMIN_TOKEN", "token_dummy")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def magento_get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def magento_post(path, payload):
    r = requests.post(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def shipments_for_order(order_id):
    params = {
        "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
        "searchCriteria[filterGroups][0][filters][0][value]": order_id,
        "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    }
    return magento_get("/shipments", params)["items"]


def shipment_detail(shipment_id):
    return magento_get(f"/shipment/{shipment_id}")


def add_shipment_track(order_id, shipment_id, expected_track):
    payload = {
        "entity": {
            "order_id": order_id,
            "parent_id": shipment_id,
            "track_number": expected_track["trackNumber"],
            "title": expected_track["title"],
            "carrier_code": expected_track["carrierCode"],
        }
    }
    return magento_post("/shipment/track", payload)


def decide_track_repair(shipment, expected_track):
    """Pure decision logic. No I/O.

    shipment: {id: number, items: list, tracks: list}
    expected_track: {trackNumber: str, title: str, carrierCode: str} or None

    Returns {"action": one of skip_no_items | skip_has_tracks |
             flag_missing_track | repair_add_track, "reason": str}
    """
    if len(shipment.get("items") or []) == 0:
        return {"action": "skip_no_items", "reason": "shipment has no line items, not a real shipment"}

    if len(shipment.get("tracks") or []) > 0:
        return {"action": "skip_has_tracks", "reason": "shipment already has tracking, nothing to do"}

    if expected_track is None:
        return {"action": "flag_missing_track", "reason": "no source of truth track data available, report only"}

    return {"action": "repair_add_track", "reason": "safe to POST /V1/shipment/track with the expected track"}


def to_plain_shipment(raw):
    return {
        "id": raw["entity_id"],
        "orderId": raw.get("order_id"),
        "items": raw.get("items") or [],
        "tracks": raw.get("tracks") or [],
    }


def run(order_id=None, expected_tracks_by_shipment_id=None):
    """expected_tracks_by_shipment_id maps shipment id -> {trackNumber, title, carrierCode},
    typically loaded from a log of the original ship request or a carrier confirmation.
    """
    order_id = order_id if order_id is not None else os.environ.get("ORDER_ID", "")
    expected_tracks_by_shipment_id = expected_tracks_by_shipment_id or {}
    flagged = 0
    repaired = 0

    for raw in shipments_for_order(order_id):
        detail = shipment_detail(raw["entity_id"])
        shipment = to_plain_shipment(detail)
        expected_track = expected_tracks_by_shipment_id.get(shipment["id"])

        result = decide_track_repair(shipment, expected_track)

        if result["action"] in ("skip_no_items", "skip_has_tracks"):
            continue

        if result["action"] == "flag_missing_track":
            flagged += 1
            log.warning("Shipment %s has items but no tracking, and no expected track data. %s",
                        shipment["id"], result["reason"])
            continue

        flagged += 1
        log.warning("Shipment %s has items but no tracking. %s",
                     shipment["id"], "would add track" if DRY_RUN else "adding track")
        if not DRY_RUN:
            add_shipment_track(shipment["orderId"], shipment["id"], expected_track)
            verified = to_plain_shipment(shipment_detail(shipment["id"]))
            if len(verified["tracks"]) > 0:
                repaired += 1
                log.info("Shipment %s verified: tracks now non-empty.", shipment["id"])
            else:
                log.error("Shipment %s still has no tracks after POST /V1/shipment/track.", shipment["id"])

    log.info("Done. %d shipment(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run()
