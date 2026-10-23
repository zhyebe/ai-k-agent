export const MIN_PROFIT_PROBABILITY = 0.4;

export function normalizeMarketRegime(value) {
  const regime = String(value || "").trim().toUpperCase();
  return ["UP", "DOWN", "RANGE"].includes(regime) ? regime : "UNKNOWN";
}

export function hasDirectionalProbabilities(decision) {
  if (decision?.directionalProbabilitiesComplete === false) return false;
  return [decision?.bullishProfitProbability, decision?.bearishProfitProbability].every((value) => {
    if (typeof value !== "number" && typeof value !== "string") return false;
    const text = String(value).trim();
    if (!text) return false;
    const numeric = Number(text.replace(/[%％]/g, "").trim());
    const unit = /[%％]/.test(text) || numeric > 1 ? numeric / 100 : numeric;
    return Number.isFinite(unit) && unit >= 0 && unit <= 1;
  });
}

// One round owns the account until its holdings and current orders are clear.
export function entryRoundBlock(task, market, { pendingId } = {}) {
  const account = market?.account;
  if (account?.positionsVerified !== true || account?.positionSummariesVerified !== true || account?.openOrdersVerified !== true) return "ACCOUNT_UNVERIFIED";
  if ((account.positions || []).some(p => Number(p.quantity) > 0) || (account.positionSummaries || []).some(p => Number(p.quantity) > 0)) return "ROUND_HOLDING";
  if ((account.openOrders || []).some(order => Number(order.remainingQuantity) > 0)) return "ROUND_ORDER_PENDING";
  if ([task.pendingAction, ...(task.unsettledActions || [])].some(p => p && p.id !== pendingId
    && ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status))) return "ROUND_ACTION_PENDING";
  return null;
}
