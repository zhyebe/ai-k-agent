import { executableExitQuote, heldDirection } from "./exit-policy.mjs";

export const SUMMARY_PROFIT_POINTS = 0.5;
export const RESCUE_RECOVERY_AMOUNT = -1;
export const RESCUE_FORECAST_AFTER_MS = 10 * 60 * 1000;
export const RESCUE_FORECAST_HORIZON_MS = 5 * 60 * 1000;
export const RESCUE_FORECAST_RETRY_MS = 60 * 1000;
const normalized = value => String(value || "").replace(/\s+/g, "").toLowerCase();
export const summaryKey = summary => `${normalized(summary.symbolName)}:${heldDirection(summary)}`;
export const sameSummaryInstrument = (a, b) => [a.symbol, a.symbolName, a.instrumentId].filter(Boolean)
  .some(value => [b.symbol, b.symbolName, b.instrumentId].filter(Boolean).some(other => normalized(other) === normalized(value)));

export function summaryExitAllowsPrice(summary, price) {
  const average = Number(summary?.averagePrice);
  if (!(average > 0) || !(Number(price) > 0) || !["LONG", "SHORT"].includes(heldDirection(summary))) return false;
  const threshold = average + (heldDirection(summary) === "LONG" ? SUMMARY_PROFIT_POINTS : -SUMMARY_PROFIT_POINTS);
  return heldDirection(summary) === "LONG" ? Number(price) >= threshold : Number(price) <= threshold;
}

// Bind predictions to verified holdings, not to account-wide PnL or a former
// rescue of the same commodity. Price changes do not invalidate the target.
export function rescueForecastContexts(task, market, now = Date.now()) {
  const session = task.rescueSession;
  if (!["ACTIVE", "EXITING"].includes(session?.status) || market.account?.positionsVerified !== true
    || market.account?.positionSummariesVerified !== true) return [];
  const ids = new Set([...(session.originalPositionIds || []), ...(session.rescuePositionIds || [])]);
  const positions = (market.account.positions || []).filter(p => ids.has(p.positionOrderId) && Number(p.quantity) > 0);
  const contexts = [];
  for (const summary of market.account.positionSummaries || []) {
    if (contexts.some(c => sameSummaryInstrument(c, summary)) || !positions.some(p => sameSummaryInstrument(p, summary))
      || (task.summaryRecoveryExits || []).some(r => sameSummaryInstrument(r, summary))) continue;
    const members = positions.filter(p => sameSummaryInstrument(p, summary));
    const rows = market.account.positionSummaries.filter(row => sameSummaryInstrument(row, summary));
    const groupTimes = (session.groups || []).filter(g => g.status !== "COMPLETE"
      && [...(g.originalPositionIds || []), ...(g.rescuePositionIds || [])].some(id => members.some(p => p.positionOrderId === id)))
      .map(g => Date.parse(g.startedAt || session.startedAt)).filter(Number.isFinite);
    const startedAt = groupTimes.length ? Math.min(...groupTimes) : Date.parse(session.startedAt);
    // Legacy sessions without a timestamp begin at the first verified observation.
    if (!Number.isFinite(startedAt)) { session.startedAt = new Date(now).toISOString(); continue; }
    const signature = JSON.stringify([session.startedAt, startedAt,
      members.map(p => [p.positionOrderId, heldDirection(p), Number(p.quantity)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      rows.map(r => [summaryKey(r), Number(r.averagePrice), Number(r.quantity)]).sort((a, b) => a[0].localeCompare(b[0]))]);
    contexts.push({ symbol: summary.symbol, symbolName: summary.symbolName, instrumentId: summary.instrumentId,
      key: summaryKey(summary).replace(/:(LONG|SHORT)$/, ""), signature, startedAt: new Date(startedAt).toISOString(),
      elapsedMs: now - startedAt, summaries: rows, quote: executableExitQuote(market, summary, now) });
  }
  return contexts;
}

export function validateRescueExitForecast(result, observedAt, now = Date.now()) {
  const expiresAt = Date.parse(observedAt) + RESCUE_FORECAST_HORIZON_MS;
  const value = result?.prediction;
  if (result?.ok !== true || !value || !["BID", "ASK"].includes(value.quoteSide)
    || !["GTE", "LTE"].includes(value.comparison) || typeof value.targetPrice !== "number" || !(value.targetPrice > 0)
    || !Number.isFinite(value.targetPrice) || typeof value.estimatedMinutes !== "number"
    || !Number.isFinite(value.estimatedMinutes) || value.estimatedMinutes < 0 || value.estimatedMinutes > 5
    || !String(value.rationale || "").trim() || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("INVALID_RESCUE_EXIT_FORECAST");
  }
  return { quoteSide: value.quoteSide, comparison: value.comparison, targetPrice: value.targetPrice,
    estimatedMinutes: value.estimatedMinutes, rationale: String(value.rationale), observedAt,
    expiresAt: new Date(expiresAt).toISOString() };
}

function rescueForecastReached(task, market, summary, now) {
  const context = rescueForecastContexts(task, market, now).find(c => sameSummaryInstrument(c, summary));
  const record = (task.rescueExitForecasts || []).find(r => r.key === context?.key && r.signature === context?.signature);
  if (!record || record.status !== "ARMED" || context.elapsedMs < RESCUE_FORECAST_AFTER_MS) return false;
  let forecast;
  try { forecast = validateRescueExitForecast({ ok: true, prediction: record.forecast }, record.forecast?.observedAt, now); }
  catch { return false; }
  // Read the requested executable quote from the current observation, never
  // the quote captured when the model started its prediction.
  const quote = executableExitQuote(market, { ...summary, side: forecast.quoteSide === "BID" ? "LONG" : "SHORT" }, now);
  if (!quote) return false;
  return forecast.comparison === "GTE" ? quote.price >= forecast.targetPrice : quote.price <= forecast.targetPrice;
}

export function summaryExitCandidates(task, market, now = Date.now(), { closing = false } = {}) {
  if (market.account?.positionSummariesVerified !== true) return [];
  const summaries = market.account.positionSummaries || [];
  const recoveries = task.summaryRecoveryExits ||= [];
  const session = task.rescueSession;
  const pendingRescues = [task.pendingAction, ...(task.unsettledActions || [])].filter(p => p && !p.exitType
    && p.entryPurpose === "RESCUE" && ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status));
  const participants = new Set([...(session?.originalPositionIds || []), ...(session?.rescuePositionIds || [])]);
  if (["ACTIVE", "EXITING"].includes(session?.status) && market.account.positionsVerified === true
    && !(market.account.positions || []).some(p => participants.has(p.positionOrderId))
    && !pendingRescues.length && !recoveries.some(r => summaries.some(row => sameSummaryInstrument(r, row)))
    && market.account.openOrdersVerified === true && !(market.account.openOrders || []).length
    && ![task.pendingAction, ...(task.unsettledActions || [])].some(p => p && !p.exitType
      && ["SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(p.status))) {
    session.status = "COMPLETE";
    session.completedAt = new Date(now).toISOString();
    for (const group of session.groups || []) group.status = "COMPLETE";
  }
  const rescued = ["ACTIVE", "EXITING"].includes(session?.status)
    ? (market.account.positions || []).filter(p => participants.has(p.positionOrderId)) : [];
  for (const summary of summaries) {
    if (!rescued.some(p => sameSummaryInstrument(p, summary)) || recoveries.some(r => sameSummaryInstrument(r, summary))) continue;
    const rows = summaries.filter(row => sameSummaryInstrument(row, summary));
    // Read this commodity's displayed summary PnL, never the account total or
    // a single winning leg. Missing values cannot be treated as zero.
    const pnl = rows.every(row => Number.isFinite(row.realtimeValueChange))
      ? rows.reduce((sum, row) => sum + row.realtimeValueChange, 0) : null;
    const recovered = pnl !== null && pnl >= RESCUE_RECOVERY_AMOUNT
      - Number.EPSILON * rows.reduce((sum, row) => sum + Math.abs(row.realtimeValueChange), 1) * 4;
    if (!recovered && !rescueForecastReached(task, market, summary, now)) continue;
    recoveries.push({ symbol: summary.symbol, symbolName: summary.symbolName, instrumentId: summary.instrumentId,
      triggerPnl: pnl, reason: recovered ? "RESCUE_RECOVERED" : "AI_TIMEOUT_PRICE", startedAt: new Date(now).toISOString() });
    session.status = "EXITING";
  }
  task.summaryRecoveryExits = recoveries.filter(recovery => summaries.some(row => sameSummaryInstrument(row, recovery)));
  return summaries.flatMap(summary => {
    const recovery = task.summaryRecoveryExits.some(r => sameSummaryInstrument(r, summary));
    const rescueActive = rescued.some(p => sameSummaryInstrument(p, summary)) || pendingRescues.some(p =>
      sameSummaryInstrument(summary, { symbol: p.targetSymbol, symbolName: p.targetSymbolName, instrumentId: p.targetInstrumentId }));
    const quote = executableExitQuote(market, summary, now);
    if (!quote || !(Number(summary.quantity) > 0) || Number(summary.frozenQuantity) !== 0) return [];
    if (recovery && (market.account.openOrdersVerified !== true || (market.account.openOrders || []).some(order =>
      sameSummaryInstrument(order, summary) && /订立/.test(order.orderKind) && order.remainingQuantity > 0))) return [];
    if (!closing && !recovery && (rescueActive || !summaryExitAllowsPrice(summary, quote.price))) return [];
    const side = heldDirection(summary);
    const exitType = closing ? "SCHEDULED_CLOSE" : side === "LONG" ? quote.price >= summary.averagePrice ? "TAKE_PROFIT" : "STOP_LOSS"
      : quote.price <= summary.averagePrice ? "TAKE_PROFIT" : "STOP_LOSS";
    return [{ summary, quotePrice: quote.price, decision: {
      action: side === "LONG" ? "SELL" : "BUY", orderType: "MARKET", exitType,
      targetPositionIds: [], targetSymbol: summary.symbol, targetSymbolName: summary.symbolName, targetInstrumentId: summary.instrumentId,
      targetSummary: { symbol: summary.symbol, symbolName: summary.symbolName, instrumentId: summary.instrumentId, side,
        averagePrice: summary.averagePrice, quantity: Number(summary.quantity), key: summaryKey(summary) },
      exitGuard: { summary: true, recovery, closing, expiresAt: new Date(now + 30000).toISOString() },
    } }];
  });
}
