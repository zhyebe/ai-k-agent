import { executableExitQuote, heldDirection } from "./exit-policy.mjs";
import { costPointsFor, matchesInstrument, planNetPoints, tightenHoldingPlan, validateHoldingPlan } from "./trading-plan.mjs";

export const SUMMARY_REVIEW_TTL_MS = 60_000;
export const SUMMARY_LOSS_SAMPLE_GAP_MS = 10_000;
const normalized = value => String(value || "").replace(/\s+/g, "").toLowerCase();
export const summaryKey = summary => `${normalized(summary.symbolName || summary.symbol || summary.instrumentId)}:${heldDirection(summary)}`;
export const sameSummaryInstrument = matchesInstrument;
export const summarySignature = summary => JSON.stringify([summaryKey(summary), Number(summary.averagePrice), Number(summary.quantity)]);

export function summaryExitReviewContexts(market, now = Date.now()) {
  if (market.account?.positionSummariesVerified !== true) return [];
  return (market.account.positionSummaries || []).flatMap(row => {
    if (!(Number(row.quantity) > 0) || Number(row.frozenQuantity) !== 0 || !["LONG", "SHORT"].includes(heldDirection(row))) return [];
    const book = (market.books || []).find(item => matchesInstrument(item, row)) || (matchesInstrument(market, row) ? market : null);
    const summary = { symbol: book?.symbol, instrumentId: book?.instrumentId, ...row, side: heldDirection(row) };
    const quote = executableExitQuote(market, summary, now);
    if (!quote) return [];
    return [{ key: summaryKey(summary), signature: summarySignature(summary), summary, quote,
      pnlPoints: planNetPoints(summary, quote.price, null)?.grossPoints ?? null }];
  });
}

export function installSummaryPlan(task, context, source, { id, observedAt, now = Date.now(), origin = "AI_REVIEW" } = {}) {
  const validated = validateHoldingPlan(source, context.summary, { observedAt, now, costs: task.tradingCosts,
    allowExpired: origin === "AI_ENTRY" });
  if (validated.code) return validated;
  const prior = (task.summaryTradingPlans || []).find(record => record.key === context.key
    && Number(record.summary.averagePrice) === Number(context.summary.averagePrice)
    && Number(record.summary.quantity) >= Number(context.summary.quantity));
  const record = tightenHoldingPlan(prior, {
    id, key: context.key, signature: context.signature, summary: context.summary, origin,
    ...validated, createdAt: new Date(now).toISOString(), bestPrice: context.quote.price, profitArmed: false,
  });
  task.summaryTradingPlans = [...(task.summaryTradingPlans || []).filter(item => item.key !== context.key), record];
  return { record };
}

export function syncSummaryPlans(task, market, now = Date.now()) {
  if (market.account?.positionSummariesVerified !== true) return;
  const rows = market.account.positionSummaries || [];
  task.summaryTradingPlans = (task.summaryTradingPlans || []).filter(record => {
    const summary = rows.find(row => summaryKey(row) === record.key);
    if (!summary || Number(summary.averagePrice) !== Number(record.summary.averagePrice)
      || Number(summary.quantity) > Number(record.summary.quantity) || !(Number(summary.quantity) > 0)) return false;
    record.summary = { ...record.summary, ...summary, side: heldDirection(summary) };
    record.signature = summarySignature(summary);
    record.costPoints = costPointsFor(record.summary, task.tradingCosts);
    return true;
  });
  const forecast = task.entryForecast;
  if (!forecast?.tradePlan || !forecast.confirmedAt || forecast.closedAt) return;
  for (const context of summaryExitReviewContexts(market, now)) {
    if ((task.summaryTradingPlans || []).some(record => record.key === context.key)
      || !matchesInstrument(forecast, context.summary)
      || heldDirection(context.summary) !== (forecast.action === "BUY" ? "LONG" : "SHORT")) continue;
    const zone = forecast.tradePlan.entryZone;
    if (context.summary.averagePrice < zone.min || context.summary.averagePrice > zone.max) continue;
    installSummaryPlan(task, context, forecast.tradePlan,
      { id: `entry-plan:${forecast.pendingId}`, observedAt: forecast.observedAt, now, origin: "AI_ENTRY" });
  }
}

export function observeSummaryPlans(task, market, now = Date.now()) {
  syncSummaryPlans(task, market, now);
  for (const context of summaryExitReviewContexts(market, now)) {
    const record = (task.summaryTradingPlans || []).find(item => item.signature === context.signature);
    if (!record) continue;
    if (record.lastObservedAt && context.quote.observedAt < record.lastObservedAt) continue;
    record.lastObservedAt = context.quote.observedAt;
    const long = context.summary.side === "LONG", price = context.quote.price;
    record.bestPrice = long ? Math.max(record.bestPrice, price) : Math.min(record.bestPrice, price);
    const protection = record.plan.profitProtection;
    if (long ? price >= protection.activationPrice : price <= protection.activationPrice) record.profitArmed = true;
    const breached = long ? price <= record.plan.stopLossPrice : price >= record.plan.stopLossPrice;
    const prior = record.lossObservation;
    if (!breached) { record.lossObservation = null; continue; }
    if (prior && context.quote.observedAt === prior.lastObservedAt) continue;
    const continuous = prior && context.quote.observedAt > prior.lastObservedAt
      && context.quote.observedAt - prior.lastObservedAt <= SUMMARY_LOSS_SAMPLE_GAP_MS;
    record.lossObservation = { startedAt: continuous ? prior.startedAt : context.quote.observedAt,
      lastObservedAt: context.quote.observedAt, price };
  }
  task.summaryLossObservations = (task.summaryTradingPlans || []).flatMap(record => record.lossObservation
    ? [{ key: record.key, signature: record.signature, confirmationSec: record.plan.stopConfirmationSec, ...record.lossObservation }] : []);
}

export function summaryReviewType(summary, price, record, now = Date.now()) {
  if (!record?.plan || record.signature !== summarySignature(summary) || !(Number(price) > 0)) return null;
  const long = heldDirection(summary) === "LONG", plan = record.plan;
  if (long ? price <= plan.hardStopPrice : price >= plan.hardStopPrice) return "HARD_STOP";
  if (Date.parse(record.maxHoldAt) <= now) return "MAX_HOLD";
  if (long ? price >= plan.takeProfitPrice : price <= plan.takeProfitPrice) return "TAKE_PROFIT";
  if (record.profitArmed) {
    const floor = long ? Math.max(plan.profitProtection.floorPrice, record.bestPrice - plan.profitProtection.trailingDistance)
      : Math.min(plan.profitProtection.floorPrice, record.bestPrice + plan.profitProtection.trailingDistance);
    if (long ? price <= floor : price >= floor) return "PROFIT_PROTECTION";
  }
  const breached = long ? price <= plan.stopLossPrice : price >= plan.stopLossPrice;
  const observation = record.lossObservation;
  if (breached && (plan.stopConfirmationSec === 0 || (observation
    && now - observation.lastObservedAt <= SUMMARY_LOSS_SAMPLE_GAP_MS
    && observation.lastObservedAt - observation.startedAt >= plan.stopConfirmationSec * 1000))) return "STOP_LOSS";
  return null;
}

export function summaryExitAllowsPrice(summary, price, authorization, now = Date.now()) {
  if (!(Number(price) > 0) || !authorization?.id || authorization.signature !== summarySignature(summary)
    || authorization.decision !== "EXIT" || !Number.isFinite(Date.parse(authorization.expiresAt))
    || now >= Date.parse(authorization.expiresAt)) return false;
  if (authorization.trigger === "AI_EXIT_NOW") {
    if (!(Number(authorization.exitPrice) > 0)) return false;
    return heldDirection(summary) === "LONG" ? price >= authorization.exitPrice : price <= authorization.exitPrice;
  }
  return summaryReviewType(summary, price, authorization.record, now) === authorization.trigger;
}

export function summaryExitCandidates(task, market, now = Date.now()) {
  return summaryExitReviewContexts(market, now).flatMap(context => {
    const record = (task.summaryTradingPlans || []).find(item => item.signature === context.signature);
    const trigger = summaryReviewType(context.summary, context.quote.price, record, now);
    const review = (task.summaryExitReviews || []).find(item => item.signature === context.signature && item.decision === "EXIT");
    const immediate = review && summaryExitAllowsPrice(context.summary, context.quote.price, review, now);
    if (!trigger && !immediate) return [];
    const points = planNetPoints(context.summary, context.quote.price, costPointsFor(context.summary, task.tradingCosts));
    const selectedTrigger = trigger || "AI_EXIT_NOW";
    const profitIntent = ["TAKE_PROFIT", "PROFIT_PROTECTION"].includes(selectedTrigger)
      || ((selectedTrigger === "MAX_HOLD" || selectedTrigger === "AI_EXIT_NOW") && points?.netPoints > 0);
    const exitType = profitIntent && points?.netPoints !== null && points.netPoints <= 0 ? "STOP_LOSS"
      : profitIntent ? "TAKE_PROFIT" : "STOP_LOSS";
    const authorization = trigger ? { id: record.id, signature: context.signature, decision: "EXIT",
      trigger, record: structuredClone(record), expiresAt: new Date(now + SUMMARY_REVIEW_TTL_MS).toISOString() } : review;
    return [{ summary: context.summary, decision: { action: context.summary.side === "LONG" ? "SELL" : "BUY",
      orderType: "MARKET", exitType, exitReason: selectedTrigger, netPoints: points?.netPoints ?? null,
      targetSummary: context.summary, targetPositionIds: [], targetSymbol: context.summary.symbol,
      targetSymbolName: context.summary.symbolName, targetInstrumentId: context.summary.instrumentId,
      exitGuard: { summary: true, aiAuthorization: authorization, expiresAt: authorization.expiresAt,
        triggerPrice: context.quote.price, netPoints: points?.netPoints ?? null } } }];
  });
}
