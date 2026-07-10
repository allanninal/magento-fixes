/**
 * Find Magento customer accounts that share one email across websites.
 *
 * When Customer Configuration, Account Sharing Options is set to Per Website,
 * Magento only enforces the unique-email rule inside a website's shared customer
 * group. The same email can register a separate customer entity_id on every
 * website, which is fine for storefront browsing but breaks any external system
 * that keys customer records by email alone.
 *
 * This script never merges or deletes anything, since merging entity_ids means
 * re-pointing sales_order, quote, wishlist, and address rows, which is destructive
 * and not reversible through the REST API. By default it only reports clusters.
 * It tags each non-canonical customer with a duplicate_email_flag custom
 * attribute only when DRY_RUN is false, one customer at a time.
 *
 * Guide: https://www.allanninal.dev/magento/duplicate-customer-accounts-same-email/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://example.test").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "dummy-token";
const CANONICAL_WEBSITE_ID = Number(process.env.CANONICAL_WEBSITE_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAGE_SIZE = 100;

/**
 * Pure function. Groups customers by normalized email and returns one cluster
 * record per email that spans more than one website_id, or that has more than
 * one customer on the very same website (a data integrity issue on its own).
 * No I/O, fully unit-testable with in-memory arrays.
 */
export function groupDuplicateEmailClusters(customers) {
  const buckets = new Map();
  for (const customer of customers) {
    const key = (customer.email || "").trim().toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(customer);
  }

  const clusters = [];
  for (const [email, bucket] of buckets.entries()) {
    if (!email) continue;
    const websiteIds = [...new Set(bucket.map((c) => c.website_id))].sort((a, b) => a - b);
    const isMultiWebsite = websiteIds.length > 1;
    const isSameWebsiteDupe = websiteIds.length === 1 && bucket.length > 1;
    if (isMultiWebsite || isSameWebsiteDupe) {
      clusters.push({
        email,
        websiteIds,
        customerIds: bucket.map((c) => c.id),
      });
    }
  }
  return clusters;
}

async function get(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function put(path, body) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function allCustomers() {
  const customers = [];
  let page = 1;
  while (true) {
    const params = {
      "searchCriteria[pageSize]": PAGE_SIZE,
      "searchCriteria[currentPage]": page,
    };
    const data = await get("/customers/search", params);
    const items = data.items || [];
    for (const item of items) {
      customers.push({ id: item.id, email: item.email, website_id: item.website_id });
    }
    if (items.length < PAGE_SIZE) return customers;
    page += 1;
  }
}

function reportCluster(cluster) {
  console.warn(
    `Duplicate identity cluster: email=${cluster.email} customerIds=${cluster.customerIds} websiteIds=${cluster.websiteIds}`
  );
}

async function flagCustomer(customerId) {
  const body = {
    customer: {
      id: customerId,
      custom_attributes: [{ attribute_code: "duplicate_email_flag", value: "true" }],
    },
  };
  await put(`/customers/${customerId}`, body);
}

function customerWebsite(customerId, customersById) {
  const customer = customersById.get(customerId);
  return customer ? customer.website_id : undefined;
}

export async function run() {
  const customers = await allCustomers();
  const customersById = new Map(customers.map((c) => [c.id, c]));
  const clusters = groupDuplicateEmailClusters(customers);

  if (!clusters.length) {
    console.log(`Done. No duplicate-identity clusters found out of ${customers.length} customer(s) checked.`);
    return;
  }

  for (const cluster of clusters) reportCluster(cluster);

  if (DRY_RUN) {
    console.log(
      `Done. ${clusters.length} duplicate-identity cluster(s) found. Set DRY_RUN=false to tag non-canonical ` +
      `customers with duplicate_email_flag for manual reconciliation.`
    );
    return;
  }

  let tagged = 0;
  for (const cluster of clusters) {
    for (const customerId of cluster.customerIds) {
      if (customerWebsite(customerId, customersById) === CANONICAL_WEBSITE_ID) continue;
      await flagCustomer(customerId);
      tagged++;
    }
  }
  console.log(`Done. ${clusters.length} duplicate-identity cluster(s) found, ${tagged} customer(s) tagged for reconciliation.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
