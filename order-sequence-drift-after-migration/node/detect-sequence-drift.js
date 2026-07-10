/**
 * Flag Magento 2 order sequence drift after a data migration or DB restore.
 *
 * Magento 2 numbers orders from dedicated sequence_order_<store> tables, tracked
 * via sales_sequence_meta and sales_sequence_profile, completely separate from
 * the sales_order table's own entity_id auto increment column. A migration from
 * Magento 1, or a manual DB import or restore, commonly copies sales_order rows
 * without correctly re-seeding the sequence table's last issued value, so the
 * next order minted from it can collide with an existing increment_id or skip a
 * huge range. There is no REST endpoint to rewrite sequence state, so this only
 * reports the drift and the recommended AUTO_INCREMENT reset value. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-sequence-drift-after-migration/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const GAP_THRESHOLD = Number(process.env.GAP_THRESHOLD || 1000);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function stripPrefix(incrementId, prefix) {
  const value = prefix && incrementId.startsWith(prefix) ? incrementId.slice(prefix.length) : incrementId;
  const stripped = value.replace(/^0+/, "");
  return stripped === "" ? 0 : parseInt(stripped, 10);
}

/**
 * Pure decision function. No DB/HTTP calls, fully testable on synthetic
 * order arrays.
 *
 * orders: Array<{entityId, storeId, incrementId, createdAt}>
 * prefixByStore: Record<storeId, prefix> used to strip a known prefix/suffix
 *   from incrementId before parsing it as a number.
 *
 * Returns {duplicates, gaps, maxNumericByStore}:
 *   - duplicates: same numeric value, more than one distinct entityId
 *   - gaps: consecutive numeric deltas beyond gapThreshold
 *   - maxNumericByStore: per-store max numeric value, the recommended next
 *     AUTO_INCREMENT seed is max + 1
 */
export function detectSequenceDrift(orders, prefixByStore, gapThreshold = 1000) {
  const byStore = new Map();
  for (const o of orders) {
    if (!byStore.has(o.storeId)) byStore.set(o.storeId, []);
    byStore.get(o.storeId).push(o);
  }

  const duplicates = [];
  const gaps = [];
  const maxNumericByStore = {};

  for (const [storeId, storeOrders] of byStore) {
    const prefix = prefixByStore[storeId] || "";
    const rows = storeOrders
      .map((o) => ({
        entityId: o.entityId,
        numeric: stripPrefix(o.incrementId, prefix),
        incrementId: o.incrementId,
      }))
      .sort((a, b) => a.numeric - b.numeric);

    const seen = new Map();
    for (const r of rows) {
      if (!seen.has(r.numeric)) seen.set(r.numeric, []);
      seen.get(r.numeric).push(r.entityId);
    }
    for (const [numeric, entityIds] of seen) {
      const distinct = [...new Set(entityIds)].sort((a, b) => a - b);
      if (distinct.length > 1) {
        const match = rows.find((r) => r.numeric === numeric);
        duplicates.push({ storeId, incrementId: match.incrementId, entityIds: distinct });
      }
    }

    for (let i = 0; i < rows.length - 1; i++) {
      const gapSize = rows[i + 1].numeric - rows[i].numeric;
      if (gapSize > gapThreshold) {
        gaps.push({ storeId, fromIncrement: rows[i].numeric, toIncrement: rows[i + 1].numeric, gapSize });
      }
    }

    maxNumericByStore[storeId] = rows.length ? Math.max(...rows.map((r) => r.numeric)) : 0;
  }

  return { duplicates, gaps, maxNumericByStore };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function ordersSortedByIncrement(pageSize = 200, currentPage = 1) {
  const params = {
    "searchCriteria[sortOrders][0][field]": "increment_id",
    "searchCriteria[sortOrders][0][direction]": "ASC",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function* allOrdersSortedByIncrement(pageSize = 200) {
  let page = 1;
  while (true) {
    const items = await ordersSortedByIncrement(pageSize, page);
    if (!items.length) return;
    for (const item of items) yield item;
    if (items.length < pageSize) return;
    page += 1;
  }
}

function normalizeOrder(item) {
  return {
    entityId: item.entity_id,
    storeId: item.store_id,
    incrementId: item.increment_id,
    createdAt: item.created_at,
  };
}

function parsePrefixByStore(raw) {
  const map = {};
  for (const pair of (raw || "").split(",")) {
    if (pair.includes(":")) {
      const [storeId, prefix] = pair.split(":");
      map[Number(storeId.trim())] = prefix.trim();
    }
  }
  return map;
}

export async function run() {
  const rawOrders = [];
  for await (const item of allOrdersSortedByIncrement(PAGE_SIZE)) rawOrders.push(item);
  const orders = rawOrders.map(normalizeOrder);

  const prefixByStore = parsePrefixByStore(process.env.PREFIX_BY_STORE);
  const result = detectSequenceDrift(orders, prefixByStore, GAP_THRESHOLD);

  for (const d of result.duplicates) {
    console.warn(`Store ${d.storeId}: increment_id ${d.incrementId} is duplicated across entity_id ${JSON.stringify(d.entityIds)}.`);
  }
  for (const g of result.gaps) {
    console.warn(`Store ${g.storeId}: gap of ${g.gapSize} between increment ${g.fromIncrement} and ${g.toIncrement}.`);
  }

  const affectedStores = new Set([
    ...result.duplicates.map((d) => d.storeId),
    ...result.gaps.map((g) => g.storeId),
  ]);

  if (affectedStores.size) {
    for (const storeId of [...affectedStores].sort()) {
      const resetValue = (result.maxNumericByStore[storeId] || 0) + 1;
      console.error(
        `Store ${storeId} sequence drift detected. Recommended repair: ` +
        `ALTER TABLE sequence_order_${storeId} AUTO_INCREMENT = ${resetValue} (run by a DBA, not this script).`
      );
    }
    console.error(`${affectedStores.size} store(s) affected. Exiting non-zero. No sequence table was written.`);
    process.exit(1);
  } else {
    console.log(`Done. No sequence drift found across ${orders.length} order(s).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
