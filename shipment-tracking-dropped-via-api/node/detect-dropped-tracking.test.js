import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrackRepair } from "./detect-dropped-tracking.js";

const shipment = (over = {}) => ({
  id: "77",
  items: [{ sku: "ABC-1", qty: 1 }],
  tracks: [],
  ...over,
});

const EXPECTED_TRACK = { trackNumber: "1Z999AA10123456784", title: "UPS", carrierCode: "ups" };

test("skip no items when shipment has no line items", () => {
  const result = decideTrackRepair(shipment({ items: [] }), EXPECTED_TRACK);
  assert.equal(result.action, "skip_no_items");
});

test("skip has tracks when tracks already present", () => {
  const result = decideTrackRepair(shipment({ tracks: [{ trackNumber: "123" }] }), EXPECTED_TRACK);
  assert.equal(result.action, "skip_has_tracks");
});

test("flag missing track when no expected track known", () => {
  const result = decideTrackRepair(shipment(), null);
  assert.equal(result.action, "flag_missing_track");
});

test("repair add track when items, no tracks, and expected known", () => {
  const result = decideTrackRepair(shipment(), EXPECTED_TRACK);
  assert.equal(result.action, "repair_add_track");
});

test("no items wins over missing expected track", () => {
  const result = decideTrackRepair(shipment({ items: [] }), null);
  assert.equal(result.action, "skip_no_items");
});

test("has tracks wins over missing expected track", () => {
  const result = decideTrackRepair(shipment({ tracks: [{ trackNumber: "123" }] }), null);
  assert.equal(result.action, "skip_has_tracks");
});

test("missing items key treated as no items", () => {
  const result = decideTrackRepair({ id: "88", tracks: [] }, EXPECTED_TRACK);
  assert.equal(result.action, "skip_no_items");
});

test("missing tracks key treated as no tracks", () => {
  const result = decideTrackRepair({ id: "88", items: [{ sku: "X" }] }, EXPECTED_TRACK);
  assert.equal(result.action, "repair_add_track");
});
