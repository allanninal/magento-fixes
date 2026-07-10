import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDuplicateEmailClusters } from "./find-duplicate-email-clusters.js";

test("single website has no cluster", () => {
  const customers = [
    { id: 1, email: "a@example.com", website_id: 1 },
    { id: 2, email: "b@example.com", website_id: 1 },
  ];
  assert.deepEqual(groupDuplicateEmailClusters(customers), []);
});

test("same email two websites is a cluster", () => {
  const customers = [
    { id: 1, email: "a@example.com", website_id: 1 },
    { id: 2, email: "a@example.com", website_id: 2 },
  ];
  const result = groupDuplicateEmailClusters(customers);
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "a@example.com");
  assert.deepEqual(result[0].websiteIds, [1, 2]);
  assert.deepEqual(result[0].customerIds.sort(), [1, 2]);
});

test("same email same website twice is a data integrity cluster", () => {
  const customers = [
    { id: 1, email: "a@example.com", website_id: 1 },
    { id: 2, email: "a@example.com", website_id: 1 },
  ];
  const result = groupDuplicateEmailClusters(customers);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].websiteIds, [1]);
  assert.deepEqual(result[0].customerIds.sort(), [1, 2]);
});

test("mixed case and whitespace email still clusters", () => {
  const customers = [
    { id: 1, email: "  A@Example.com", website_id: 1 },
    { id: 2, email: "a@example.com  ", website_id: 2 },
  ];
  const result = groupDuplicateEmailClusters(customers);
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "a@example.com");
  assert.deepEqual(result[0].websiteIds, [1, 2]);
});

test("no cluster when every email is unique per website", () => {
  const customers = [
    { id: 1, email: "a@example.com", website_id: 1 },
    { id: 2, email: "b@example.com", website_id: 2 },
    { id: 3, email: "c@example.com", website_id: 1 },
  ];
  assert.deepEqual(groupDuplicateEmailClusters(customers), []);
});

test("empty email is ignored", () => {
  const customers = [
    { id: 1, email: "", website_id: 1 },
    { id: 2, email: null, website_id: 2 },
  ];
  assert.deepEqual(groupDuplicateEmailClusters(customers), []);
});

test("three websites same email reports all ids", () => {
  const customers = [
    { id: 1, email: "a@example.com", website_id: 3 },
    { id: 2, email: "a@example.com", website_id: 1 },
    { id: 3, email: "a@example.com", website_id: 2 },
  ];
  const result = groupDuplicateEmailClusters(customers);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].websiteIds, [1, 2, 3]);
  assert.deepEqual(result[0].customerIds.sort(), [1, 2, 3]);
});
