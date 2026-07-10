/**
 * Detect and repair Magento 2 orders stuck in payment_review with no gateway callback.
 *
 * Magento sets an order's state to payment_review
 * (Magento\Sales\Model\Order::STATE_PAYMENT_REVIEW) when an asynchronous
 * gateway (PayPal fraud and risk filters, Adyen, Braintree, or a custom
 * payment adapter) flags a transaction for manual review before authorizing
 * it. Orders in this state have no invoice yet, and the admin UI hides the
 * Cancel action whenever a payment method's isGatewayOrPaymentReviewSufficient
 * / canCancel logic reports the order as gateway-held. The order can only be
 * released by the gateway's own async callback (IPN or webhook) calling
 * acceptPayment or denyPayment. If that callback never arrives, the order
 * sits in payment_review indefinitely with no cancel path in the admin grid
 * or the default REST API, silently soft-locking inventory reservations tied
 * to it.
 *
 * If DRY_RUN=true (default), this only reports each stuck order. If
 * DRY_RUN=false and the order has total_invoiced == 0, it force-cancels the
 * order via POST /orders/{id}/cancel and leaves a status history comment.
 * If total_invoiced > 0, it only posts a flagging comment recommending
 * manual Accept Payment or Deny Payment review, since a captured payment
 * must go through the creditmemo and refund flow, not order cancel.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/magento/order-stuck-in-payment-review/
 */
import { pathToFileURL } from "node:url";

const MAGENTO_URL = (process.env.MAGENTO_URL || "https://demo.example.com").replace(/\/$/, "");
const TOKEN = process.env.MAGENTO_ADMIN_TOKEN || "token_dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const THRESHOLD_HOURS = Number(process.env.THRESHOLD_HOURS || 48);

const AUTO_CANCEL_COMMENT =
  "Auto-cancelled: stuck in payment_review beyond threshold, no gateway callback received";
const FLAG_COMMENT =
  "Flagged: stuck in payment_review beyond threshold with a captured payment. " +
  "Needs manual Accept Payment or Deny Payment review in Admin.";

function isoToEpochMs(value) {
  // Magento REST timestamps are UTC, formatted as "YYYY-MM-DD HH:MM:SS".
  const text = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(text);
}

export function decideStuckOrderAction(order, now, thresholdHours) {
  if (order.state !== "payment_review") {
    return { action: "skip", reason: "not_in_payment_review" };
  }

  if (!order.createdAt) {
    return { action: "skip", reason: "missing_created_at" };
  }

  const ageHours = (now.getTime() - isoToEpochMs(order.createdAt)) / 3600000;
  if (ageHours < thresholdHours) {
    return { action: "skip", reason: "below_age_threshold" };
  }

  const createdEpoch = isoToEpochMs(order.createdAt);
  const progressed = (order.statusHistories || []).some(
    (entry) => entry.createdAt && isoToEpochMs(entry.createdAt) > createdEpoch
  );
  if (progressed) {
    return { action: "skip", reason: "gateway_callback_already_progressed" };
  }

  if ((order.totalInvoiced || 0) > 0) {
    return { action: "flag", reason: "payment_captured_needs_manual_review" };
  }

  return { action: "cancel", reason: "no_gateway_callback_within_threshold" };
}

async function magentoGet(path, params = {}) {
  const url = new URL(`${MAGENTO_URL}/rest/V1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function magentoPost(path, payload = {}) {
  const res = await fetch(`${MAGENTO_URL}/rest/V1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  return res.json();
}

async function stuckPaymentReviewOrders(thresholdHours, pageSize = 100) {
  const cutoff = new Date(Date.now() - thresholdHours * 3600000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  const params = {
    "searchCriteria[filterGroups][0][filters][0][field]": "state",
    "searchCriteria[filterGroups][0][filters][0][value]": "payment_review",
    "searchCriteria[filterGroups][0][filters][0][conditionType]": "eq",
    "searchCriteria[filterGroups][1][filters][0][field]": "created_at",
    "searchCriteria[filterGroups][1][filters][0][value]": cutoff,
    "searchCriteria[filterGroups][1][filters][0][conditionType]": "lteq",
    "searchCriteria[sortOrders][0][field]": "created_at",
    "searchCriteria[pageSize]": pageSize,
    "searchCriteria[currentPage]": 1,
  };
  const data = await magentoGet("/orders", params);
  return data.items;
}

async function orderDetail(orderId) {
  return magentoGet(`/orders/${orderId}`);
}

async function cancelOrder(orderId) {
  return magentoPost(`/orders/${orderId}/cancel`);
}

async function addComment(orderId, comment) {
  const payload = {
    statusHistory: {
      comment,
      is_customer_notified: 0,
      is_visible_on_front: 0,
    },
  };
  return magentoPost(`/orders/${orderId}/comments`, payload);
}

export async function run() {
  const now = new Date();
  let cancelled = 0;
  let flagged = 0;

  const summaries = await stuckPaymentReviewOrders(THRESHOLD_HOURS);
  for (const summary of summaries) {
    const orderId = summary.entity_id;
    const detail = await orderDetail(orderId);

    const order = {
      state: detail.state,
      status: detail.status,
      createdAt: detail.created_at,
      totalInvoiced: detail.total_invoiced,
      statusHistories: (detail.status_histories || []).map((h) => ({ createdAt: h.created_at })),
    };

    const decision = decideStuckOrderAction(order, now, THRESHOLD_HOURS);
    const incrementId = detail.increment_id;
    const paymentMethod = (detail.payment || {}).method;

    if (decision.action === "skip") continue;

    if (decision.action === "flag") {
      console.warn(
        `Order ${incrementId} payment_review with captured payment (method=${paymentMethod}). ${
          DRY_RUN ? "would flag" : "flagging"
        }`
      );
      if (!DRY_RUN) await addComment(orderId, FLAG_COMMENT);
      flagged++;
      continue;
    }

    console.warn(
      `Order ${incrementId} stuck in payment_review beyond ${THRESHOLD_HOURS}h (method=${paymentMethod}). ${
        DRY_RUN ? "would cancel" : "cancelling"
      }`
    );
    if (!DRY_RUN) {
      await cancelOrder(orderId);
      await addComment(orderId, AUTO_CANCEL_COMMENT);
    }
    cancelled++;
  }

  console.log(
    `Done. ${cancelled} order(s) ${DRY_RUN ? "to cancel" : "cancelled"}, ${flagged} order(s) ${
      DRY_RUN ? "to flag" : "flagged"
    }.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
