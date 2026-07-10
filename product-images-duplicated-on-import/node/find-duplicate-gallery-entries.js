/**
 * Find and safely remove duplicate Magento product gallery images caused by
 * repeated import or Save and Duplicate.
 *
 * Magento's catalog importer (Magento\CatalogImportExport\Model\Import\Product)
 * and the product Copier (Magento\Catalog\Model\Product\Copier::copy) both
 * append to catalog_product_entity_media_gallery instead of checking whether
 * an identical image is already attached to the SKU. Re-running an import, or
 * duplicating a product, saves a renamed copy of the same file (image_1.jpg,
 * image_2.jpg, ...) and inserts a fresh gallery row for it every time.
 *
 * This script reads media_gallery_entries per SKU over REST, hashes the bytes
 * each entry's file resolves to, and groups entries by that hash. Only
 * entries that share a hash within the same SKU are treated as true
 * duplicates. It reports by default. Repair only runs with DRY_RUN=false,
 * only removes ids confirmed as byte-identical duplicates, always keeps the
 * lowest id (first imported), and never removes a product's only image or an
 * unmatched base/small_image/thumbnail role.
 *
 * Guide: https://www.allanninal.dev/magento/product-images-duplicated-on-import/
 */
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const SKUS = (process.env.SKUS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ROLE_TYPES = new Set(["base", "small_image", "thumbnail"]);
const SUFFIX_RE = /^(.*?)(_\d+)?(\.[A-Za-z0-9]+)$/;

export function normalizedStem(fileName) {
  const base = fileName.split("/").pop();
  const m = SUFFIX_RE.exec(base);
  if (!m) return base;
  return `${m[1]}${m[3]}`;
}

function groupKey(entry) {
  if (entry.hash) return `hash:${entry.hash}`;
  return `name:${normalizedStem(entry.file)}`;
}

/**
 * Pure function. Groups entries by content hash (preferred) falling back to
 * normalized base filename (stripping Magento's trailing "_1", "_2"...
 * disambiguator and extension) when a hash is unavailable. Within each
 * group, sorts by id ascending and keeps the lowest id (the original,
 * first-imported entry) as canonical; every other id in the group is
 * reported as a duplicate candidate. Returns [] when every group has size 1
 * (no duplicates). No I/O: caller supplies pre-fetched entries (and
 * pre-computed hash/size if available).
 */
export function findDuplicateGalleryEntries(mediaGalleryEntries) {
  const groups = new Map();
  for (const entry of mediaGalleryEntries) {
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const results = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const idsSorted = group.map((e) => e.id).sort((a, b) => a - b);
    const keepId = idsSorted[0];
    const duplicateIds = idsSorted.slice(1);
    const reason = key.startsWith("hash:") ? "identical file content" : "identical normalized filename";
    results.push({ keepId, duplicateIds, reason });
  }
  return results;
}

/**
 * Pure function. Filters a duplicate group's duplicateIds down to the ones
 * safe to remove: never the product's only image, and never an entry
 * covering a base/small_image/thumbnail role unless the kept entry already
 * covers that same role. No I/O.
 */
export function safeDuplicateIds(allEntries, duplicateGroup) {
  if (allEntries.length <= 1) return [];
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const keepEntry = byId.get(duplicateGroup.keepId) || {};
  const keepRoles = new Set(keepEntry.types || []);
  const safe = [];
  for (const dupId of duplicateGroup.duplicateIds) {
    const entry = byId.get(dupId);
    if (!entry) continue;
    const roles = (entry.types || []).filter((t) => ROLE_TYPES.has(t));
    if (roles.length && !roles.every((r) => keepRoles.has(r))) continue;
    safe.push(dupId);
  }
  return safe;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function apiPut(path, payload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function fetchProduct(sku) {
  return apiGet(`/products/${sku}`);
}

async function hashMediaFile(filePath) {
  const url = `${MAGENTO_URL}/media/catalog/product${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Magento media ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash("md5").update(buf).digest("hex");
}

async function entriesWithHash(product) {
  const entries = product.media_gallery_entries || [];
  for (const entry of entries) {
    entry.hash = await hashMediaFile(entry.file);
  }
  return entries;
}

async function removeEntries(sku, product, removeIds) {
  const remaining = product.media_gallery_entries.filter((e) => !removeIds.has(e.id));
  const payload = { product: { sku, media_gallery_entries: remaining } };
  return apiPut(`/products/${sku}`, payload);
}

export async function run() {
  let totalRemoved = 0;
  for (const sku of SKUS) {
    const product = await fetchProduct(sku);
    const entries = await entriesWithHash(product);
    const groups = findDuplicateGalleryEntries(entries);
    if (!groups.length) {
      console.log(`SKU ${sku}: no duplicate gallery entries found.`);
      continue;
    }

    const removeIds = new Set();
    for (const group of groups) {
      const safeIds = new Set(safeDuplicateIds(entries, group));
      for (const entry of entries) {
        if (group.duplicateIds.includes(entry.id)) {
          const skipped = safeIds.has(entry.id) ? "" : " -- skipped, no safe sibling for its role";
          console.warn(
            `SKU ${sku}: entry id=${entry.id} file=${entry.file} is a duplicate of id=${group.keepId} (${group.reason})${skipped}`
          );
        }
      }
      for (const id of safeIds) removeIds.add(id);
    }

    if (removeIds.size) {
      console.log(`SKU ${sku}: ${DRY_RUN ? "would remove" : "removing"} ${removeIds.size} entr${removeIds.size === 1 ? "y" : "ies"}.`);
      if (!DRY_RUN) await removeEntries(sku, product, removeIds);
    }
    totalRemoved += removeIds.size;
  }

  console.log(
    `Done. ${totalRemoved} duplicate entr${totalRemoved === 1 ? "y" : "ies"} ${DRY_RUN ? "to remove" : "removed"} across ${SKUS.length} SKU(s).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
