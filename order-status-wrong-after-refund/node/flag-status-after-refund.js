/**
 * Flag Magento 2 orders whose status disagrees with their refund totals.
 *
 * Magento derives order state and status largely from totals such as
 * total_refunded and total_paid, via Order::getIsInProcess(), Order::setState(),
 * and the creditmemo save observers, rather than recomputing status from a
 * single authoritative rule each time a credit memo posts. A zero-total credit
 * memo (store-credit-only refunds), a shipping-only refund, or a partial
 * refund on a bundle/configurable item can make the totals comparison come
 * out wrong, leaving a fully refunded order on Processing or Complete, or
 * forcing an order to Closed after only a partial refund.
 *
 * There is no safe REST write for order.status alone, so this reports by
 * default. The only optional write is a status history comment, and only
 * when DRY_RUN is false. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-status-wrong-after-refund/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

export function expectedOrderStatus(orderTotals, creditMemos, currentStatus) {
  const totalInvoiced = orderTotals.totalInvoiced || 0;
  const totalPaid = orderTotals.totalPaid || 0;
  const totalRefunded = orderTotals.totalRefunded || 0;

  if (totalInvoiced <= 0) {
    return { expected: currentStatus, isMismatch: false };
  }

  let isFullyRefunded = totalRefunded >= totalPaid - EPSILON;
  const hasZeroTotalMemo = creditMemos.some((cm) => cm.grandTotal === 0);
  if (creditMemos.length > 0 && hasZeroTotalMemo && totalRefunded >= totalPaid - EPSILON) {
    isFullyRefunded = true;
  }

  let expected;
  if (isFullyRefunded) {
    expected = "closed";
  } else if (totalRefunded > 0 && totalRefunded < totalPaid - EPSILON) {
    expected = currentStatus === "closed" ? "processing" : currentStatus;
  } else {
    expected = currentStatus;
  }

  return { expected, isMismatch: expected !== currentStatus };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function candidateOrders(pageSize = 200) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "status",
    "searchCriteria[filterGroups][0][filters][0][value]": "processing,complete",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "in",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": 1,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function creditmemosForOrder(orderId) {
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "order_id",
    "searchCriteria[filterGroups][0][filters][0][value]": orderId,
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
  };
  const data = await magentoGet("/creditmemo", params);
  return data.items;
}

async function addStatusHistoryComment(orderId, comment) {
  const payload = {
    entity: {
      entity_id: orderId,
      status_histories: [
        { comment, is_customer_notified: 0, is_visible_on_front: 0 },
      ],
    },
  };
  const res = await fetch(`${MAGENTO_URL}/rest/V1/orders/${orderId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  const orders = await candidateOrders();
  for (const order of orders) {
    const orderId = order.entity_id;
    const currentStatus = order.status;
    const memos = await creditmemosForOrder(orderId);

    const creditMemos = memos.map((m) => ({ grandTotal: m.grand_total, state: m.state }));
    const orderTotals = {
      totalInvoiced: order.total_invoiced,
      totalPaid: order.total_paid,
      totalRefunded: order.total_refunded,
    };

    const result = expectedOrderStatus(orderTotals, creditMemos, currentStatus);
    if (!result.isMismatch) continue;

    const comment = `Flagged: total_refunded=${orderTotals.totalRefunded} total_paid=${orderTotals.totalPaid} status=${currentStatus} expected=${result.expected}`;
    console.warn(
      `Order ${order.increment_id} (id=${orderId}) status mismatch: current=${currentStatus} expected=${result.expected} total_refunded=${orderTotals.totalRefunded} total_paid=${orderTotals.totalPaid}. ${
        DRY_RUN ? "would add status history comment" : "adding status history comment"
      }`
    );
    if (!DRY_RUN) await addStatusHistoryComment(orderId, comment);
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) flagged with a status mismatch after refund.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
