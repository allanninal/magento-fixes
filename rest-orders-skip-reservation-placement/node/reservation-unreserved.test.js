import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnreservedOrderItems } from "./flag-unreserved-orders.js";

test("fully reserved SKU is not flagged", () => {
  const orders = [{ incrementId: "100000001", items: [{ sku: "SKU-1", qtyOrdered: 5 }] }];
  const findings = findUnreservedOrderItems(orders, { "SKU-1": 100 }, { "SKU-1": 95 });
  assert.deepEqual(findings, []);
});

test("completely skipped reservation is flagged", () => {
  const orders = [{ incrementId: "100000002", items: [{ sku: "SKU-2", qtyOrdered: 5 }] }];
  const findings = findUnreservedOrderItems(orders, { "SKU-2": 100 }, { "SKU-2": 100 });
  assert.deepEqual(findings, [
    { incrementId: "100000002", sku: "SKU-2", qtyOrdered: 5, missingReservationQty: 5 },
  ]);
});

test("partially reserved SKU reports only the shortfall", () => {
  const orders = [{ incrementId: "100000003", items: [{ sku: "SKU-3", qtyOrdered: 10 }] }];
  const findings = findUnreservedOrderItems(orders, { "SKU-3": 100 }, { "SKU-3": 96 });
  assert.deepEqual(findings, [
    { incrementId: "100000003", sku: "SKU-3", qtyOrdered: 10, missingReservationQty: 6 },
  ]);
});

test("shortfall attributed to earliest orders first", () => {
  const orders = [
    { incrementId: "100000004", items: [{ sku: "SKU-4", qtyOrdered: 3 }] },
    { incrementId: "100000005", items: [{ sku: "SKU-4", qtyOrdered: 4 }] },
  ];
  const findings = findUnreservedOrderItems(orders, { "SKU-4": 100 }, { "SKU-4": 100 });
  assert.deepEqual(findings, [
    { incrementId: "100000004", sku: "SKU-4", qtyOrdered: 3, missingReservationQty: 3 },
    { incrementId: "100000005", sku: "SKU-4", qtyOrdered: 4, missingReservationQty: 4 },
  ]);
});

test("shortfall smaller than first order only flags that order", () => {
  const orders = [
    { incrementId: "100000006", items: [{ sku: "SKU-5", qtyOrdered: 5 }] },
    { incrementId: "100000007", items: [{ sku: "SKU-5", qtyOrdered: 5 }] },
  ];
  const findings = findUnreservedOrderItems(orders, { "SKU-5": 100 }, { "SKU-5": 97 });
  assert.deepEqual(findings, [
    { incrementId: "100000006", sku: "SKU-5", qtyOrdered: 5, missingReservationQty: 5 },
    { incrementId: "100000007", sku: "SKU-5", qtyOrdered: 5, missingReservationQty: 2 },
  ]);
});

test("multiple SKUs are evaluated independently", () => {
  const orders = [
    { incrementId: "100000008", items: [
      { sku: "SKU-6", qtyOrdered: 2 },
      { sku: "SKU-7", qtyOrdered: 3 },
    ] },
  ];
  const findings = findUnreservedOrderItems(
    orders,
    { "SKU-6": 50, "SKU-7": 50 },
    { "SKU-6": 48, "SKU-7": 50 }
  );
  assert.deepEqual(findings, [
    { incrementId: "100000008", sku: "SKU-7", qtyOrdered: 3, missingReservationQty: 3 },
  ]);
});

test("no orders produces no findings", () => {
  const findings = findUnreservedOrderItems([], {}, {});
  assert.deepEqual(findings, []);
});

test("over reserved SKU is not flagged", () => {
  const orders = [{ incrementId: "100000009", items: [{ sku: "SKU-8", qtyOrdered: 5 }] }];
  const findings = findUnreservedOrderItems(orders, { "SKU-8": 100 }, { "SKU-8": 80 });
  assert.deepEqual(findings, []);
});
