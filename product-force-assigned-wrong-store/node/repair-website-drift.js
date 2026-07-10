/**
 * Detect and safely repair Magento products force-assigned to the wrong website on save.
 *
 * Magento\Catalog\Model\ProductRepository::save() runs an internal
 * assignProductToWebsites() step on every save. When the save context resolves to
 * the admin store code, common for CLI scripts, cron-triggered imports, custom
 * catalog_product_save_after observers, or REST calls that skip an explicit store
 * scope, this step can force-assign the product only to the default website,
 * silently overwriting catalog_product_website and dropping every other website
 * the product used to be on.
 *
 * This script reads the actual website_ids for each SKU in your expected mapping,
 * compares them with decideWebsiteDrift, and by default only reports the drift.
 * Only when the drift is a pure lost assignment, missing ids with nothing
 * unexpected, does it call POST /V1/products/{sku}/websites to add each missing
 * id back, and only under an explicit DRY_RUN=false operator override. It never
 * calls the DELETE websites endpoint. Run on a schedule after any bulk save,
 * import, or deploy that touches ProductRepository::save. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/magento/product-force-assigned-wrong-store/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const ADMIN_STORE_CODE = process.env.ADMIN_STORE_CODE || "admin";
const STORE_CONTEXT_CODE = process.env.STORE_CONTEXT_CODE || ADMIN_STORE_CODE;
const EXPECTED_WEBSITES_JSON = process.env.EXPECTED_WEBSITES_JSON || "{}";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_WEBSITE_ID = 1;

/**
 * Pure function. No I/O. Compares actual vs expected website id sets.
 *
 * Returns:
 *   isDrifted: true when missing or unexpected ids exist
 *   missing: expected ids that are absent from actual (lost assignment)
 *   unexpected: actual ids that are not expected (possibly a deliberate edit)
 *   likelyForcedDefault: true when actual is exactly the default website id,
 *     expected has more than one id, and the save's store context code
 *     equals the admin store code, the signature of the forced-default bug.
 */
export function decideWebsiteDrift(actualWebsiteIds, expectedWebsiteIds, storeContextCode, adminStoreCode = "admin") {
  const actual = [...new Set(actualWebsiteIds)].sort((a, b) => a - b);
  const expected = [...new Set(expectedWebsiteIds)].sort((a, b) => a - b);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  const isDrifted = missing.length > 0 || unexpected.length > 0;
  const likelyForcedDefault =
    actual.length === 1 &&
    actual[0] === DEFAULT_WEBSITE_ID &&
    expected.length > 1 &&
    storeContextCode === adminStoreCode;
  return { isDrifted, missing, unexpected, likelyForcedDefault };
}

async function magentoGet(path) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPost(path, body) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function actualWebsiteIds(sku) {
  const product = await magentoGet(`/products/${sku}`);
  const ext = product.extension_attributes || {};
  if (ext.website_ids !== undefined) return ext.website_ids;
  return magentoGet(`/products/${sku}/websites`);
}

async function addWebsiteLink(sku, websiteId) {
  const body = { productWebsiteLink: { sku, website_id: websiteId } };
  return magentoPost(`/products/${sku}/websites`, body);
}

export async function run() {
  const expectedMap = JSON.parse(EXPECTED_WEBSITES_JSON);
  let flagged = 0;
  let repaired = 0;

  for (const [sku, expectedIds] of Object.entries(expectedMap)) {
    const actualIds = await actualWebsiteIds(sku);
    const drift = decideWebsiteDrift(actualIds, expectedIds, STORE_CONTEXT_CODE, ADMIN_STORE_CODE);

    if (!drift.isDrifted) continue;

    flagged++;
    console.warn(
      `Drift on sku=${sku} expected=${JSON.stringify([...new Set(expectedIds)].sort((a, b) => a - b))} ` +
      `actual=${JSON.stringify([...new Set(actualIds)].sort((a, b) => a - b))} ` +
      `missing=${JSON.stringify(drift.missing)} unexpected=${JSON.stringify(drift.unexpected)} ` +
      `likely_forced_default=${drift.likelyForcedDefault}`
    );

    const safeToRepair = drift.missing.length > 0 && drift.unexpected.length === 0;
    if (!safeToRepair) {
      console.warn(`Sku=${sku} has an unexpected website id, flagging only, no auto-repair.`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`Sku=${sku} would add missing website id(s) ${JSON.stringify(drift.missing)} (dry run).`);
      continue;
    }

    for (const websiteId of drift.missing) {
      await addWebsiteLink(sku, websiteId);
      console.log(`Sku=${sku} added back website id ${websiteId}.`);
    }
    repaired++;
  }

  console.log(`Done. ${flagged} sku(s) flagged, ${repaired} sku(s) repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
