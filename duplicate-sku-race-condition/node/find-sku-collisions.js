/**
 * Find and report duplicate SKUs created through concurrent API or import saves.
 *
 * Magento 2 and Adobe Commerce enforce SKU uniqueness with a unique index on
 * catalog_product_entity.sku, but ProductRepository::save() and the import
 * and bulk API code paths first do an application-level lookup to decide
 * insert versus update, before that index ever runs. When two saves race,
 * two REST POST /V1/products calls, or a concurrent import bunch and an
 * async bulk save, both can see "SKU not found" in the same window and both
 * proceed to insert, leaving two entity_ids that resolve to the same SKU.
 * This never merges or deletes a product entity. It pages recently touched
 * products, groups by normalized sku with a pure function, confirms every
 * collision against the single-SKU lookup, always reports it, and only when
 * DRY_RUN is explicitly false and exactly one entity has zero orders does it
 * disable that one entity with status 2 as a reversible step. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/magento/duplicate-sku-race-condition/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure. Groups products by normalized sku (trim + lowercase) and returns one
 * collision record per sku that resolves to more than one distinct id.
 * entity_ids and created_at are sorted ascending, so index 0 is the
 * presumed original and later entries are the race-created duplicates.
 */
export function findSkuCollisions(products) {
  const groups = new Map();
  for (const p of products) {
    const normalized = p.sku.trim().toLowerCase();
    const list = groups.get(normalized) || [];
    list.push(p);
    groups.set(normalized, list);
  }

  const collisions = [];
  for (const [normalizedSku, members] of groups) {
    const distinctIds = new Set(members.map((m) => m.id));
    if (distinctIds.size <= 1) continue;
    const ordered = [...members].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    collisions.push({
      sku: normalizedSku,
      entity_ids: ordered.map((m) => m.id),
      created_at: ordered.map((m) => m.created_at),
    });
  }

  collisions.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return collisions;
}

function lookbackIso(hours) {
  const dt = new Date(Date.now() - hours * 3600 * 1000);
  return dt.toISOString().slice(0, 19).replace("T", " ");
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

async function* recentProducts(lookback, pageSize = 200) {
  let currentPage = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "updated_at",
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "gteq",
      "searchCriteria[filterGroups][0][filters][0][value]": lookback,
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": currentPage,
    };
    const data = await magentoGet("/products", params);
    for (const item of data.items) yield item;
    if (currentPage * pageSize >= data.total_count) return;
    currentPage += 1;
  }
}

async function confirmCollision(sku) {
  const data = await magentoGet(`/products/${encodeURIComponent(sku)}`);
  return data.id;
}

async function hasZeroOrders(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[pageSize]": 1,
  };
  const data = await magentoGet("/orders", params);
  return (data.total_count || 0) === 0;
}

async function disableOrphan(sku) {
  const payload = { product: { sku, status: 2 } };
  return magentoPut(`/products/${encodeURIComponent(sku)}`, payload);
}

export async function run() {
  const rawItems = [];
  for await (const item of recentProducts(lookbackIso(LOOKBACK_HOURS), PAGE_SIZE)) rawItems.push(item);
  const products = rawItems.map((item) => ({ id: item.id, sku: item.sku, created_at: item.created_at || "" }));

  const collisions = findSkuCollisions(products);

  if (collisions.length === 0) {
    console.log("Done. 0 duplicate SKU group(s) found.");
    return;
  }

  let disabled = 0;
  for (const col of collisions) {
    const memberSummary = col.entity_ids
      .map((eid, i) => `entity_id=${eid} created_at=${col.created_at[i]}`)
      .join(", ");
    console.warn(`sku ${col.sku} has ${col.entity_ids.length} entity_id(s): ${memberSummary}`);

    const resolvedId = await confirmCollision(col.sku);
    let orphanId = null;
    if (col.entity_ids.includes(resolvedId) && col.entity_ids.length === 2) {
      const candidates = col.entity_ids.filter((eid) => eid !== resolvedId);
      orphanId = candidates.length ? candidates[0] : null;
    }

    if (orphanId === null) {
      console.warn(`  -> could not confirm a single safe orphan for sku ${col.sku}, skipping.`);
      continue;
    }

    if (!(await hasZeroOrders(col.sku))) {
      console.warn(`  -> sku ${col.sku} has orders on file, leaving both entities alone.`);
      continue;
    }

    console.warn(`  -> ${DRY_RUN ? "would disable" : "disabling"} entity_id ${orphanId} (status=2, Disabled).`);
    if (!DRY_RUN) await disableOrphan(col.sku);
    disabled++;
  }

  console.log(
    `Done. ${collisions.length} duplicate SKU group(s), ${disabled} orphan(s) ${DRY_RUN ? "to disable" : "disabled"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
