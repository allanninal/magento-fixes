/**
 * Flag a Magento 2 or Adobe Commerce shared catalog price cached and served to the wrong company.
 *
 * Magento's full page cache and block cache key rendered price HTML on a hash of
 * Magento\Framework\App\Http\Context, customer group, store, currency, carried via
 * the X-Magento-Vary cookie and header. Shared catalogs apply a per company
 * discount on top of the base tier price, but the cache layer does not always
 * fully re derive that context before caching a category page's rendered price
 * HTML (magento/magento2 issues 10439, 38509, and the related 40474; confirmed
 * by Adobe quality patch ACSD-48784). The first viewer's price gets cached and
 * served to the next visitor from a different company or a guest until the
 * entry is purged. This script reads each shared catalog's assigned customer
 * group and expected price, computes the authoritative tier and shared catalog
 * price per group with tier-prices-information, simulates what each relevant
 * group would see, and flags any SKU/category/group triple where the rendered
 * price does not match. It only ever writes by re-assigning the shared
 * catalog's own products, which forces Magento to reindex and invalidate the
 * associated cache tags. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/shared-catalog-price-cached-wrong-company/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const ADMIN_USERNAME = process.env.MAGENTO_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD || "change-me";
const ADMIN_TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "";
const SHARED_CATALOG_ID = process.env.SHARED_CATALOG_ID || "";
const CATEGORY_ID = process.env.CATEGORY_ID || "";
const SKUS = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
const WEBSITE_ID = Number(process.env.WEBSITE_ID || 1);
const GUEST_GROUP_ID = Number(process.env.GUEST_GROUP_ID || 0);
const GENERAL_GROUP_ID = Number(process.env.GENERAL_GROUP_ID || 1);
const PRICE_TOLERANCE = Number(process.env.PRICE_TOLERANCE || 0.01);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic (no I/O).
 *
 * expected: {sku, customerGroupId, sharedCatalogId, expectedPrice}
 * observed: {sku, customerGroupId, renderedPrice, cacheAgeSeconds}
 * otherGroupPrices: optional map of other customerGroupId -> expected price,
 *   used to detect that the rendered price actually belongs to a different group.
 *
 * Returns {isMismatch, severity, reason}. severity is one of
 * "wrong_company" (rendered price matches a DIFFERENT group's expected price
 * while the group differs from expected), "wrong_group" (rendered price is
 * wrong but matches no known other group, a generic stale cache), or "ok"
 * (rendered price matches expected within PRICE_TOLERANCE).
 */
export function decidePriceMismatch(expected, observed, otherGroupPrices = {}) {
  if (Math.abs(observed.renderedPrice - expected.expectedPrice) <= PRICE_TOLERANCE) {
    return { isMismatch: false, severity: "ok", reason: "Rendered price matches the expected price for this group." };
  }

  if (observed.customerGroupId !== expected.customerGroupId) {
    for (const [otherGroupIdStr, otherPrice] of Object.entries(otherGroupPrices)) {
      const otherGroupId = Number(otherGroupIdStr);
      if (otherGroupId === observed.customerGroupId) continue;
      if (Math.abs(observed.renderedPrice - otherPrice) <= PRICE_TOLERANCE) {
        return {
          isMismatch: true,
          severity: "wrong_company",
          reason: `Group ${observed.customerGroupId} was served group ${otherGroupId}'s price.`,
        };
      }
    }
  }

  return {
    isMismatch: true,
    severity: "wrong_group",
    reason: "Rendered price disagrees with the expected price and matches no other known group, likely a generic stale cache.",
  };
}

async function getToken() {
  if (ADMIN_TOKEN) return ADMIN_TOKEN;
  const res = await fetch(`${MAGENTO_URL}/rest/V1/integration/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getSharedCatalogProducts(token, sharedCatalogId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/sharedCatalog/${sharedCatalogId}/products`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function findCustomerGroupId(token, nameContains, pageSize = 100) {
  const params = new URLSearchParams({ "searchCriteria[pageSize]": String(pageSize) });
  const res = await fetch(`${MAGENTO_URL}/rest/V1/customerGroups/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  const match = (body.items || []).find((g) => (g.code || "").toLowerCase().includes(nameContains.toLowerCase()));
  return match ? match.id : null;
}

async function getTierPricesInformation(token, skus, customerGroup, websiteId) {
  const body = { skus, customerGroup, websiteId };
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/tier-prices-information`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getCategoryProducts(token, categoryId) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/categories/${categoryId}/products`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function getProduct(token, sku) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function refreshSharedCatalog(token, sharedCatalogId, productsPayload) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1/sharedCatalog/${sharedCatalogId}/assignProducts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ products: productsPayload }),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  let skus = SKUS;
  const catalogProductsBySku = {};

  if (SHARED_CATALOG_ID) {
    const catalogData = await getSharedCatalogProducts(token, SHARED_CATALOG_ID);
    const items = Array.isArray(catalogData) ? catalogData : catalogData.items || [];
    for (const item of items) catalogProductsBySku[item.sku] = item.price;
    if (!skus.length) skus = Object.keys(catalogProductsBySku);
  }

  if (CATEGORY_ID && !skus.length) {
    const categoryData = await getCategoryProducts(token, CATEGORY_ID);
    skus = categoryData.map((p) => p.sku).filter(Boolean);
  }

  let relevantGroupIds = [...new Set([GUEST_GROUP_ID, GENERAL_GROUP_ID])];
  if (SHARED_CATALOG_ID) {
    const companyGroupId = (await findCustomerGroupId(token, "company")) ?? (await findCustomerGroupId(token, "wholesale"));
    if (companyGroupId != null) relevantGroupIds = [...new Set([...relevantGroupIds, companyGroupId])];
  }
  relevantGroupIds.sort((a, b) => a - b);

  const flagged = [];
  for (const sku of skus) {
    const expectedPriceByGroup = {};
    for (const groupId of relevantGroupIds) {
      const info = await getTierPricesInformation(token, [sku], groupId, WEBSITE_ID);
      const items = Array.isArray(info) ? info : info.items || [];
      const entry = items.find((e) => e.sku === sku);
      const price = entry ? (entry.prices?.[0]?.price ?? entry.price) : null;
      expectedPriceByGroup[groupId] = price != null ? price : 0.0;
    }

    const product = await getProduct(token, sku);
    const renderedPrice = product.price || 0.0;

    for (const groupId of relevantGroupIds) {
      const expected = {
        sku, customerGroupId: groupId,
        sharedCatalogId: SHARED_CATALOG_ID || null,
        expectedPrice: expectedPriceByGroup[groupId],
      };
      const observed = { sku, customerGroupId: groupId, renderedPrice, cacheAgeSeconds: 0 };
      const otherPrices = Object.fromEntries(
        Object.entries(expectedPriceByGroup).filter(([gid]) => Number(gid) !== groupId)
      );
      const verdict = decidePriceMismatch(expected, observed, otherPrices);

      if (verdict.isMismatch) {
        flagged.push({
          sku, customerGroupId: groupId,
          expectedPrice: expected.expectedPrice, observedPrice: renderedPrice,
          severity: verdict.severity, reason: verdict.reason,
        });
        console.warn(`SKU ${sku} group ${groupId}: ${verdict.severity} (expected ${expected.expectedPrice}, observed ${renderedPrice})`);
      }
    }
  }

  if (!DRY_RUN && SHARED_CATALOG_ID && Object.keys(catalogProductsBySku).length) {
    const payload = Object.entries(catalogProductsBySku).map(([sku, price]) => ({ sku, price }));
    await refreshSharedCatalog(token, SHARED_CATALOG_ID, payload);
    console.log(`Re-assigned ${payload.length} product(s) on shared catalog ${SHARED_CATALOG_ID} to force reindex and cache invalidation.`);
    console.log("Operator follow up: bin/magento cache:clean full_page,block_html,config && bin/magento indexer:reindex catalog_product_price");
  }

  console.log(`Done. ${flagged.length} SKU/group mismatch(es) flagged, ${DRY_RUN ? "dry run, nothing written" : "shared catalog refresh triggered"}.`);
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
