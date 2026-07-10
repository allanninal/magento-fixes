/**
 * Flag Magento 2 SKUs where a negative source_item quantity is masked as positive stock.
 *
 * MSI legitimately allows a source_item to carry a negative quantity, for a drop-ship
 * or oversell tracking source signalling a deficit. Magento's indexer, SelectBuilder::execute,
 * only forces a source's contribution to 0 in the SUM() when that source's is_in_stock flag
 * is 0 (via getCheckSql()). When a negative-quantity source is left marked in-stock, or the
 * zeroing branch never fires for how sources combine into a stock, the raw negative number is
 * summed as is, and a depleted source can cancel out or invert the sign of healthy sources,
 * producing an impossible positive salable total. Tracked upstream as magento/inventory#3346
 * and #3165, both open. This script never rewrites source_items automatically. It reports the
 * impossible-total signature per SKU and stock, and only performs the guarded zero-out write
 * after DRY_RUN is explicitly set to false, which an operator should only do once they have
 * confirmed the negative row is bad data. Safe to run again and again in report mode.
 *
 * Guide: https://www.allanninal.dev/magento/negative-source-item-counted-as-positive/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network/DB calls.
 *
 * Given the source rows feeding one stock, returns whether the naive combined
 * sum is an impossible total: at least one negative-quantity row exists but the
 * sum is non-negative, or otherwise fails to propagate that source's deficit.
 */
export function isImpossibleStockTotal(sourceRows) {
  const sum = sourceRows.reduce((acc, row) => acc + row.quantity, 0);
  const negativeSources = sourceRows.filter((row) => row.quantity < 0).map((row) => row.sourceCode);

  if (negativeSources.length === 0) {
    return { flagged: false, sum, negativeSources: [], reason: null };
  }

  const masked =
    sum >= 0 ||
    sourceRows.some((row) => row.quantity < 0 && row.status === 0 && sum > row.quantity);

  if (!masked) {
    return { flagged: false, sum, negativeSources, reason: null };
  }

  const culprit = sourceRows.find((row) => row.quantity < 0);
  const statusLabel = culprit.status === 0 ? "out_of_stock" : "in_stock";
  const reason = `source ${culprit.sourceCode} qty=${culprit.quantity} status=${statusLabel} masked, sum=${sum} treated as salable`;
  return { flagged: true, sum, negativeSources, reason };
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
  return res.status === 204 ? null : res.json();
}

async function getStockSourceLinks() {
  const data = await magentoGet("/inventory/stock-source-links", { "searchCriteria[pageSize]": 200 });
  return data.items;
}

async function getSourceItemsForSku(sku) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "sku",
    "searchCriteria[filterGroups][0][filters][0][value]": sku,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/inventory/source-items", params);
  return data.items;
}

function groupRowsByStock(sourceItems, stockSourceLinks) {
  const codeToStocks = {};
  for (const link of stockSourceLinks) {
    (codeToStocks[link.source_code] ||= []).push(link.stock_id);
  }

  const grouped = {};
  for (const item of sourceItems) {
    const stockIds = codeToStocks[item.source_code] || [];
    for (const stockId of stockIds) {
      (grouped[stockId] ||= []).push({
        sourceCode: item.source_code,
        quantity: item.quantity,
        status: item.status,
      });
    }
  }
  return grouped;
}

async function getSalableQuantity(sku, stockId) {
  const data = await magentoGet(`/inventory/get-product-salable-quantity/${sku}/${stockId}`);
  return Number(data);
}

async function zeroOutSourceItem(sku, sourceCode) {
  const payload = { sourceItems: [{ sku, source_code: sourceCode, quantity: 0, status: 0 }] };
  if (DRY_RUN) {
    console.log(`DRY_RUN: would PUT /inventory/source-items with`, JSON.stringify(payload));
    return;
  }
  await magentoPut("/inventory/source-items", payload);
  console.warn(`Zeroed ${sku} at source ${sourceCode}. Re-check salable qty, then run a CLI reindex.`);
}

/**
 * skus: array of SKUs to check.
 * fixSourceCodes: optional {sku: sourceCode} map naming a source an operator
 * has confirmed is bad data. Only that source, on that SKU, gets zeroed, and
 * only when DRY_RUN=false.
 */
export async function run(skus = [], fixSourceCodes = {}) {
  const stockSourceLinks = await getStockSourceLinks();
  let flagged = 0;

  for (const sku of skus) {
    const sourceItems = await getSourceItemsForSku(sku);
    const grouped = groupRowsByStock(sourceItems, stockSourceLinks);

    for (const [stockId, rows] of Object.entries(grouped)) {
      const result = isImpossibleStockTotal(rows);
      if (!result.flagged) continue;

      const salableQty = await getSalableQuantity(sku, stockId);
      console.warn(
        `SKU ${sku} stock ${stockId}: ${result.reason} naive_sum=${result.sum} live_salable=${salableQty}`
      );
      flagged++;

      const confirmedBadSource = fixSourceCodes[sku];
      if (confirmedBadSource && result.negativeSources.includes(confirmedBadSource)) {
        await zeroOutSourceItem(sku, confirmedBadSource);
        const newSalableQty = await getSalableQuantity(sku, stockId);
        console.log(`SKU ${sku} stock ${stockId} salable qty after write: ${newSalableQty}`);
      }
    }
  }

  console.log(`Done. ${flagged} SKU/stock pair(s) flagged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skus = (process.env.CHECK_SKUS || "").split(",").filter(Boolean);
  run(skus, {}).catch((err) => { console.error(err); process.exit(1); });
}
