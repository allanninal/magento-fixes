/**
 * Flag Magento 2 sales_order_grid rows that fell out of sync with sales_order.
 *
 * With asynchronous grid indexing (dev/grid/async_indexing=1), orders are written
 * to sales_order immediately but only copied into sales_order_grid by a scheduled
 * cron job bounded by a cached watermark on updated_at. A documented race
 * (magento/magento2 issue #40803) lets a cron run advance that watermark past an
 * order whose grid row write was still in flight or failed, permanently skipping
 * it. sales_order_grid has no REST endpoint and there is no public API to force a
 * single order's grid row rebuild, so this only reports the drift. Run on a
 * schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/sales-order-grid-out-of-sync/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const SYNC_SINCE = process.env.SYNC_SINCE || "2026-01-01 00:00:00";
const WATERMARK = process.env.WATERMARK || "2026-01-01 00:00:00";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const NUDGE_ALLOWLIST = new Set(
  (process.env.NUDGE_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean)
);

/**
 * Pure decision logic. entityRow / gridRow are plain objects (gridRow may be null).
 * Shape: {entityId, incrementId, status, grandTotal, updatedAt}
 * watermark: string, comparable ISO-ish timestamp.
 *
 * Returns {entityId, driftType, action} where driftType is one of
 * "OK" | "MISSING_FROM_GRID" | "STALE_STATUS" | "STALE_TOTAL"
 * and action is "NONE" | "FLAG_REINDEX".
 */
export function classifyOrderSync(entityRow, gridRow, watermark) {
  const entityId = entityRow.entityId;

  if (gridRow === null) {
    if (entityRow.updatedAt <= watermark) {
      return { entityId, driftType: "MISSING_FROM_GRID", action: "FLAG_REINDEX" };
    }
    return { entityId, driftType: "OK", action: "NONE" };
  }

  if (gridRow.status !== entityRow.status) {
    return { entityId, driftType: "STALE_STATUS", action: "FLAG_REINDEX" };
  }

  if (gridRow.grandTotal !== entityRow.grandTotal) {
    return { entityId, driftType: "STALE_TOTAL", action: "FLAG_REINDEX" };
  }

  return { entityId, driftType: "OK", action: "NONE" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPut(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function entityOrdersSince(since, pageSize = 200, currentPage = 1) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
    "searchCriteria[filterGroups][0][filters][0][value]": since,
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": currentPage,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function gridViewForId(entityId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "entity_id",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[filterGroups][0][filters][0][value]": entityId,
  };
  const data = await magentoGet("/orders", params);
  return data.items[0] || null;
}

function normalizeOrder(item) {
  return {
    entityId: item.entity_id,
    incrementId: item.increment_id,
    status: item.status,
    updatedAt: item.updated_at,
    grandTotal: item.grand_total,
  };
}

async function nudgeOrder(entityId) {
  const payload = {
    statusHistory: {
      comment: "Reconciler: no-op comment to refresh updated_at for grid re-sync.",
      isCustomerNotified: false,
      isVisibleOnFront: false,
    },
  };
  return magentoPut(`/orders/${entityId}/comments`, payload);
}

export async function run() {
  const rawEntities = await entityOrdersSince(SYNC_SINCE);
  const entities = rawEntities.map(normalizeOrder);

  const drifted = [];
  for (const entityRow of entities) {
    const rawGrid = await gridViewForId(entityRow.entityId);
    const gridRow = rawGrid ? normalizeOrder(rawGrid) : null;
    const result = classifyOrderSync(entityRow, gridRow, WATERMARK);
    if (result.action === "FLAG_REINDEX") {
      drifted.push({ ...result, incrementId: entityRow.incrementId, lastKnownGood: entityRow });
    }
  }

  for (const d of drifted) {
    console.warn(`Order ${d.incrementId} (id ${d.entityId}) drifted: ${d.driftType}.`);
  }

  if (drifted.length) {
    const ids = drifted.map((d) => d.entityId).join(",");
    console.error(
      `${drifted.length} order(s) out of sync with sales_order_grid. Run: ` +
      `bin/magento indexer:reindex sales_order_grid  (affected ids: ${ids})`
    );
  } else {
    console.log("Done. No drift found between sales_order and sales_order_grid.");
  }

  if (!DRY_RUN && NUDGE_ALLOWLIST.size) {
    for (const d of drifted) {
      if (NUDGE_ALLOWLIST.has(String(d.entityId))) {
        console.warn(`Nudging order ${d.entityId} to bump updated_at for re-sync.`);
        await nudgeOrder(d.entityId);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
