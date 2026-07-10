/**
 * Flag Magento 2 configurable products whose own media gallery is empty
 * while at least one simple child has images, safely.
 *
 * A configurable's catalog_product_entity_media_gallery_value_to_entity
 * linkage is entirely independent of its children's gallery entries.
 * Magento never auto-copies or inherits images from children to the parent
 * row. This commonly appears after CSV or API bulk imports, or product
 * creation flows, where images are attached only to the simple SKUs. The
 * storefront often masks this by falling back to a child's image through
 * ImageBuilder and the configurable JavaScript widget, so the gap only
 * surfaces when an API consumer requests the parent directly. This reports
 * the mismatch by default and only gates a narrow corrective upload behind
 * DRY_RUN=false. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/configurable-parent-missing-image/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 * parentGallery: array of media gallery entry objects for the parent SKU.
 * childGalleries: object mapping child SKU -> array of that child's entries.
 * Returns a verdict object, never mutates its inputs.
 */
export function decideMissingParentImage(parentGallery, childGalleries) {
  const parentImageCount = parentGallery.filter((e) => !e.disabled).length;

  const childrenWithImages = Object.entries(childGalleries)
    .filter(([, entries]) => entries.filter((e) => !e.disabled).length > 0)
    .map(([sku]) => sku);

  const flagged = parentImageCount === 0 && childrenWithImages.length > 0;

  const recommendedFixSku = flagged
    ? preferredChild(childrenWithImages, childGalleries)
    : null;

  return {
    flagged,
    parentImageCount,
    childrenWithImages,
    recommendedFixSku,
  };
}

function preferredChild(childrenWithImages, childGalleries) {
  for (const sku of childrenWithImages) {
    const entries = childGalleries[sku] || [];
    if (entries.some((e) => !e.disabled && (e.types || []).includes("image"))) {
      return sku;
    }
  }
  return childrenWithImages[0];
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

async function* configurableProducts(pageSize = 50) {
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[filterGroups][0][filters][0][field]": "type_id",
      "searchCriteria[filterGroups][0][filters][0][value]": "configurable",
      "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
      "searchCriteria[pageSize]": pageSize,
      "searchCriteria[currentPage]": page,
    };
    const data = await magentoGet("/products", params);
    const items = data.items || [];
    if (!items.length) return;
    for (const item of items) yield item;
    if (page * pageSize >= (data.total_count || 0)) return;
    page++;
  }
}

async function childrenFor(sku) {
  return magentoGet(`/configurable-products/${sku}/children`);
}

async function galleryFor(sku) {
  return magentoGet(`/products/${sku}/media`);
}

/** Create a new gallery entry on the parent SKU. Never edits the child. */
async function uploadEntryFromChild(parentSku, childSku, childEntry) {
  const payload = {
    entry: {
      media_type: "image",
      label: childEntry.label || `Copied from ${childSku}`,
      position: 1,
      disabled: false,
      types: ["image", "small_image", "thumbnail"],
      content: {
        base64_encoded_data: childEntry.base64_encoded_data || "",
        type: childEntry.content_type || "image/jpeg",
        name: childEntry.file || `${childSku}.jpg`,
      },
    },
  };
  console.log(`Uploading gallery entry to ${parentSku} from ${childSku}`);
  return magentoPost(`/products/${parentSku}/media`, payload);
}

export async function run() {
  let flagged = 0;

  for await (const parent of configurableProducts()) {
    const sku = parent.sku;
    const parentId = parent.id;
    const childrenRaw = await childrenFor(sku);
    if (!childrenRaw || !childrenRaw.length) continue;

    const parentGallery = parent.media_gallery_entries || (await galleryFor(sku));
    const childGalleries = {};
    for (const child of childrenRaw) {
      childGalleries[child.sku] = await galleryFor(child.sku);
    }

    const verdict = decideMissingParentImage(parentGallery, childGalleries);
    if (!verdict.flagged) continue;

    flagged++;
    console.warn(
      `parent_sku=${sku} parent_id=${parentId} affected_children=${verdict.childrenWithImages.length} recommended_fix_sku=${verdict.recommendedFixSku}`
    );

    if (!DRY_RUN) {
      console.log(
        `DRY_RUN is false, but this reference script still only reports. Fetch the ` +
        `recommended child's image content and call uploadEntryFromChild(sku, ` +
        `verdict.recommendedFixSku, entry) once a human has confirmed the file.`
      );
    }
  }

  console.log(`Done. ${flagged} configurable(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
