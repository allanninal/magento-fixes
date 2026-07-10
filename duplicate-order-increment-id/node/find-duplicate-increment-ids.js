/**
 * Find and flag duplicate or colliding order increment_id values in Magento 2.
 *
 * Magento generates increment_id from the sales_sequence_meta and
 * sales_sequence_profile tables, which store a per-store prefix, pad length,
 * and step rather than one global counter. A Magento 1 migration, or a
 * multi-store-view reconfiguration, can leave two profiles pointing at the
 * same underlying sequence table, so two independent order streams end up
 * producing the same increment_id for two different entity_id rows. This
 * never rewrites increment_id. It pages every order, groups by increment_id
 * with a pure function, always reports collisions, and only when DRY_RUN is
 * explicitly false posts a non destructive status history comment flagging
 * the duplicate for manual sequence-table correction. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/magento/duplicate-order-increment-id/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FIELDS = "items[entity_id,increment_id,store_id,created_at,status,customer_email],total_count";

const FLAG_COMMENT =
  "Duplicate increment_id detected - flagged for manual sequence-table correction.";

/**
 * Group orders by incrementId (pure map-reduce, no I/O).
 *
 * Returns groups with more than one distinct entityId, sorted by
 * incrementId ascending, with each group's members sorted by createdAt
 * ascending so the first-created order in the collision is always
 * members[0].
 */
export function findDuplicateIncrementIds(orders) {
  const groups = new Map();
  for (const o of orders) {
    const list = groups.get(o.incrementId) || [];
    list.push({ entityId: o.entityId, storeId: o.storeId, createdAt: o.createdAt });
    groups.set(o.incrementId, list);
  }

  const duplicates = [];
  for (const [incrementId, members] of groups) {
    const distinctEntityIds = new Set(members.map((m) => m.entityId));
    if (distinctEntityIds.size <= 1) continue;
    const sortedMembers = [...members].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    );
    duplicates.push({ incrementId, members: sortedMembers });
  }

  duplicates.sort((a, b) => (a.incrementId < b.incrementId ? -1 : a.incrementId > b.incrementId ? 1 : 0));
  return duplicates;
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

async function* allOrders(pageSize = 200) {
  let currentPage = 1;
  while (true) {
    const params = {
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": currentPage,
      "searchCriteria[sortOrders][0][field]": "increment_id",
      "searchCriteria[sortOrders][0][direction]": "ASC",
      fields: FIELDS,
    };
    const data = await magentoGet("/orders", params);
    for (const item of data.items) yield item;
    if (currentPage * pageSize >= data.total_count) return;
    currentPage += 1;
  }
}

function normalizeOrder(item) {
  return {
    entityId: item.entity_id,
    incrementId: item.increment_id,
    storeId: item.store_id,
    createdAt: item.created_at,
  };
}

async function flagDuplicateOrder(entityId) {
  const payload = {
    statusHistory: {
      comment: FLAG_COMMENT,
      is_customer_notified: 0,
      is_visible_on_front: 0,
    },
  };
  return magentoPost(`/orders/${entityId}/comments`, payload);
}

export async function run() {
  const rawItems = [];
  for await (const item of allOrders(PAGE_SIZE)) rawItems.push(item);
  const orders = rawItems.map(normalizeOrder);

  const duplicates = findDuplicateIncrementIds(orders);

  if (duplicates.length === 0) {
    console.log("Done. 0 duplicate increment_id group(s) found.");
    return;
  }

  let flagged = 0;
  for (const dup of duplicates) {
    const memberSummary = dup.members
      .map((m) => `entity_id=${m.entityId} store_id=${m.storeId} created_at=${m.createdAt}`)
      .join(", ");
    console.warn(`increment_id ${dup.incrementId} has ${dup.members.length} order(s): ${memberSummary}`);

    for (const member of dup.members.slice(1)) {
      console.warn(`  -> ${DRY_RUN ? "would flag" : "flagging"} entity_id ${member.entityId}.`);
      if (!DRY_RUN) await flagDuplicateOrder(member.entityId);
      flagged++;
    }
  }

  console.log(
    `Done. ${duplicates.length} duplicate increment_id group(s), ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
