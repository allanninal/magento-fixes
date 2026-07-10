/**
 * Detect and safely repair Magento 2 shipments with a dropped tracking number.
 *
 * POST /V1/order/{orderId}/ship with an inline tracks array routes through
 * ShipOrder, which calls shipment.setTracks(tracksData). setTracks() only
 * assigns plain data to the model and never populates the shipment's tracks
 * collection, so Relation::processRelation(), which persists tracks by
 * iterating that collection on save, writes nothing to sales_shipment_track.
 * The shipment still saves and returns a 200 with a new shipment ID, so the
 * drop is silent. This is a documented core defect (magento/magento2#13954,
 * #13248), not user error.
 *
 * This script reports every shipment with items but no tracks by default,
 * and only repairs it when you separately supply the expected track data,
 * using the dedicated POST /rest/V1/shipment/track endpoint rather than
 * retrying the broken ship call. Run on a schedule. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/magento/shipment-tracking-dropped-via-api/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic. No I/O.
 *
 * shipment: {id: number, items: Array, tracks: Array}
 * expectedTrack: {trackNumber: string, title: string, carrierCode: string} | null
 *
 * Returns {action: "skip_no_items" | "skip_has_tracks" | "flag_missing_track"
 *          | "repair_add_track", reason: string}
 */
export function decideTrackRepair(shipment, expectedTrack) {
  if ((shipment.items || []).length === 0) {
    return { action: "skip_no_items", reason: "shipment has no line items, not a real shipment" };
  }

  if ((shipment.tracks || []).length > 0) {
    return { action: "skip_has_tracks", reason: "shipment already has tracking, nothing to do" };
  }

  if (expectedTrack === null || expectedTrack === undefined) {
    return { action: "flag_missing_track", reason: "no source of truth track data available, report only" };
  }

  return { action: "repair_add_track", reason: "safe to POST /V1/shipment/track with the expected track" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPost(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function shipmentsForOrder(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/shipments", params);
  return data.items;
}

async function shipmentDetail(shipmentId) {
  return magentoGet(`/shipment/${shipmentId}`);
}

async function addShipmentTrack(orderId, shipmentId, expectedTrack) {
  const payload = {
    entity: {
      order_id: orderId,
      parent_id: shipmentId,
      track_number: expectedTrack.trackNumber,
      title: expectedTrack.title,
      carrier_code: expectedTrack.carrierCode,
    },
  };
  return magentoPost("/shipment/track", payload);
}

function toPlainShipment(raw) {
  return {
    id: raw.entity_id,
    orderId: raw.order_id,
    items: raw.items || [],
    tracks: raw.tracks || [],
  };
}

/**
 * expectedTracksByShipmentId maps shipment id -> {trackNumber, title, carrierCode},
 * typically loaded from a log of the original ship request or a carrier confirmation.
 */
export async function run(orderId = process.env.ORDER_ID || "", expectedTracksByShipmentId = {}) {
  let flagged = 0;
  let repaired = 0;

  const rawShipments = await shipmentsForOrder(orderId);

  for (const raw of rawShipments) {
    const detail = await shipmentDetail(raw.entity_id);
    const shipment = toPlainShipment(detail);
    const expectedTrack = expectedTracksByShipmentId[shipment.id];

    const result = decideTrackRepair(shipment, expectedTrack);

    if (result.action === "skip_no_items" || result.action === "skip_has_tracks") continue;

    if (result.action === "flag_missing_track") {
      flagged++;
      console.warn(`Shipment ${shipment.id} has items but no tracking, and no expected track data. ${result.reason}`);
      continue;
    }

    flagged++;
    console.warn(`Shipment ${shipment.id} has items but no tracking. ${DRY_RUN ? "would add track" : "adding track"}`);
    if (!DRY_RUN) {
      await addShipmentTrack(shipment.orderId, shipment.id, expectedTrack);
      const verified = toPlainShipment(await shipmentDetail(shipment.id));
      if (verified.tracks.length > 0) {
        repaired++;
        console.log(`Shipment ${shipment.id} verified: tracks now non-empty.`);
      } else {
        console.error(`Shipment ${shipment.id} still has no tracks after POST /V1/shipment/track.`);
      }
    }
  }

  console.log(`Done. ${flagged} shipment(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
