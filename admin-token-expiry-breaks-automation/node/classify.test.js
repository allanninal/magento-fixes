import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTokenFailure } from "./detect-token-expiry.js";

const ISSUED = Date.parse("2026-07-10T08:00:00Z");
const hoursLater = (h) => ISSUED + h * 3600000;

test("OK on 200", () => {
  assert.equal(classifyTokenFailure(200, {}, ISSUED, hoursLater(1), 4), "OK");
});

test("EXPIRED_REAUTH after lifetime", () => {
  const body = { message: "Unauthorized" };
  assert.equal(classifyTokenFailure(401, body, ISSUED, hoursLater(5), 4), "EXPIRED_REAUTH");
});

test("REVOKED_OR_INVALID when within lifetime", () => {
  const body = { message: "The consumer isn't authorized to access %resources" };
  assert.equal(classifyTokenFailure(401, body, ISSUED, hoursLater(1), 4), "REVOKED_OR_INVALID");
});

test("exactly at lifetime is expired", () => {
  assert.equal(classifyTokenFailure(401, {}, ISSUED, hoursLater(4), 4), "EXPIRED_REAUTH");
});

test("just under lifetime is revoked or invalid", () => {
  assert.equal(classifyTokenFailure(401, {}, ISSUED, hoursLater(3.9), 4), "REVOKED_OR_INVALID");
});

test("LOCKOUT_RISK when retry threshold hit", () => {
  assert.equal(classifyTokenFailure(401, {}, ISSUED, hoursLater(5), 4, 1, 1), "LOCKOUT_RISK");
});

test("LOCKOUT_RISK takes priority over expired", () => {
  assert.equal(classifyTokenFailure(401, {}, ISSUED, hoursLater(10), 4, 2, 1), "LOCKOUT_RISK");
});

test("non 401 non 200 treated as revoked or invalid", () => {
  assert.equal(classifyTokenFailure(500, {}, ISSUED, hoursLater(1), 4), "REVOKED_OR_INVALID");
});

test("zero age with 401 is revoked or invalid", () => {
  assert.equal(classifyTokenFailure(401, {}, ISSUED, ISSUED, 4), "REVOKED_OR_INVALID");
});
