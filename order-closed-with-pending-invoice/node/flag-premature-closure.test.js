import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPrematureClosure } from "./flag-premature-closure.js";

const order = (over = {}) => ({
  status: "closed",
  total_paid: 100.0,
  total_due: 0.0,
  grand_total: 100.0,
  ...over,
});

test("closed and paid and no due is not premature", () => {
  const result = classifyPrematureClosure(order(), [{ state: 2 }], true);
  assert.equal(result.isPrematureClosure, false);
});

test("closed with open invoice and due and shipment is premature", () => {
  const o = order({ total_paid: 40.0, total_due: 60.0 });
  const result = classifyPrematureClosure(o, [{ state: 1 }], true);
  assert.equal(result.isPrematureClosure, true);
});

test("not closed yet is not premature", () => {
  const o = order({ status: "processing", total_paid: 40.0, total_due: 60.0 });
  const result = classifyPrematureClosure(o, [{ state: 1 }], true);
  assert.equal(result.isPrematureClosure, false);
});

test("open invoice but rounding zero due is not premature", () => {
  const o = order({ total_paid: 100.0, total_due: 0.00001 });
  const result = classifyPrematureClosure(o, [{ state: 1 }], true);
  assert.equal(result.isPrematureClosure, false);
});

test("no shipment is not premature", () => {
  const o = order({ total_paid: 40.0, total_due: 60.0 });
  const result = classifyPrematureClosure(o, [{ state: 1 }], false);
  assert.equal(result.isPrematureClosure, false);
});

test("no open invoice is not premature even with due", () => {
  const o = order({ total_paid: 40.0, total_due: 60.0 });
  const result = classifyPrematureClosure(o, [{ state: 2 }], true);
  assert.equal(result.isPrematureClosure, false);
});
