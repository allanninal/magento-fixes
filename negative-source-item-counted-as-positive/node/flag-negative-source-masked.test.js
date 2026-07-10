import { test } from "node:test";
import assert from "node:assert/strict";
import { isImpossibleStockTotal } from "./flag-negative-source-masked.js";

const row = (sourceCode, quantity, status = 1) => ({ sourceCode, quantity, status });

test("flagged when negative masked by healthy sources", () => {
  const rows = [row("S1", 2), row("S2", 3), row("S3", -29, 0)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.flagged, true);
  assert.equal(result.sum, -24);
  assert.ok(result.negativeSources.includes("S3"));
});

test("not flagged when no negative rows", () => {
  const rows = [row("S1", 2), row("S2", 3)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.flagged, false);
  assert.equal(result.sum, 5);
});

test("flagged when naive sum is non-negative with negative row", () => {
  const rows = [row("S1", 5), row("S2", -2, 0)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.flagged, true);
  assert.equal(result.sum, 3);
});

test("flagged when healthy source partially offsets out-of-stock negative", () => {
  // sum (-3) is still negative but greater than the culprit's own -5, so the
  // deficit was partially masked by S1 even though the total stayed negative.
  const rows = [row("S1", 2), row("S2", -5, 0)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.sum, -3);
  assert.equal(result.flagged, true);
});

test("not flagged when single out-of-stock negative source alone", () => {
  // No other source to mask the deficit: sum equals the culprit's own quantity,
  // so it is not masked, just a plain negative total from one source.
  const rows = [row("S1", -5, 0)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.sum, -5);
  assert.equal(result.flagged, false);
});

test("reason names the culprit source", () => {
  const rows = [row("S1", 2), row("S2", -2, 0)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.flagged, true);
  assert.match(result.reason, /S2/);
  assert.match(result.reason, /out_of_stock/);
});

test("negative in-stock source included in negativeSources", () => {
  const rows = [row("S1", 10), row("S2", -1, 1)];
  const result = isImpossibleStockTotal(rows);
  assert.ok(result.negativeSources.includes("S2"));
  assert.equal(result.sum, 9);
});

test("empty rows not flagged", () => {
  const result = isImpossibleStockTotal([]);
  assert.equal(result.flagged, false);
  assert.equal(result.sum, 0);
  assert.deepEqual(result.negativeSources, []);
});

test("multiple negative sources all listed", () => {
  const rows = [row("S1", 10), row("S2", -3, 0), row("S3", -4, 1)];
  const result = isImpossibleStockTotal(rows);
  assert.equal(result.sum, 3);
  assert.equal(result.flagged, true);
  assert.deepEqual(new Set(result.negativeSources), new Set(["S2", "S3"]));
});
