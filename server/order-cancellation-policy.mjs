export const CURRENT_ORDER_WAIT_MS = 30_000;

function orderTimestamp(value) {
  const raw = String(value || "").trim();
  // The target site's unzoned order timestamps are Shanghai time, including
  // when the desktop runs on Windows or the API runs in UTC.
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  if (!local && !zoned) return NaN;
  const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== raw.slice(0, 10)) return NaN;
  return Date.parse(local ? `${local[1]}T${local[2]}${local[3] || ""}+08:00` : raw);
}

export function currentOrderCancellationPlan(task, account, now = Date.now()) {
  if (account?.openOrdersVerified !== true) return { orderIds: [], waiting: [] };
  const previous = task.currentOrderTracking || {};
  const tracking = [];
  const orderIds = [], waiting = [];
  const seen = new Set();
  for (const order of account.openOrders || []) {
    const id = String(order.orderId || "").trim();
    if (!id || seen.has(id) || !(Number(order.remainingQuantity) > 0)) continue;
    seen.add(id);
    const timestamp = orderTimestamp(order.orderTime);
    const knownTime = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : null;
    const stored = Object.hasOwn(previous, id) ? previous[id]?.startedAt : null;
    const prior = typeof stored === "number" && stored > 0 && stored <= now ? stored : null;
    const startedAt = prior ?? knownTime ?? now;
    tracking.push([id, { startedAt }]);
    const remainingMs = Math.max(0, startedAt + CURRENT_ORDER_WAIT_MS - now);
    if (remainingMs === 0) orderIds.push(id);
    else waiting.push({ orderId: id, remainingMs, eligibleAt: new Date(startedAt + CURRENT_ORDER_WAIT_MS).toISOString() });
  }
  // Missing/unverified tables never clear clocks. Verified disappearance does;
  // absence alone still does not establish cancellation or a fill.
  task.currentOrderTracking = Object.fromEntries(tracking);
  return { orderIds, waiting };
}
