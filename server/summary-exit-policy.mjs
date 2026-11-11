import { executableExitQuote, heldDirection } from "./exit-policy.mjs";
import { directionalProfitPoints, matchesInstrument, profitProtectionFor, tightenHoldingPlan, validateHoldingPlan } from "./trading-plan.mjs";

export const SUMMARY_REVIEW_TTL_MS = 60_000;
export const SUMMARY_LOSS_SAMPLE_GAP_MS = 10_000;
export const HEDGE_WINNER_HOLD_MS = 60_000;
const normalized = value => String(value || "").replace(/\s+/g, "").toLowerCase();
export const summaryKey = summary => `${normalized(summary.symbolName || summary.symbol || summary.instrumentId)}:${heldDirection(summary)}`;
export const sameSummaryInstrument = matchesInstrument;
export const summarySignature = summary => JSON.stringify([summaryKey(summary), Number(summary.averagePrice), Number(summary.quantity)]);
const activeBatch = batch => batch && !["COMPLETE", "INVALIDATED"].includes(batch.phase);
const batchTargetMatches = (target, summary) => summaryKey(target) === summaryKey(summary)
  && Number(target.averagePrice) === Number(summary.averagePrice)
  && Number(summary.quantity) > 0 && Number(summary.quantity) <= Number(target.quantity);
const unsettled = task => [task.pendingAction, ...(task.unsettledActions || [])]
  .filter(action => action && ["SUBMITTING", "AWAITING_FILL", "UNVERIFIED"].includes(action.status));

function verifiedAccount(market, now) {
  const timestamp = Date.parse(market.accountObservedAt || market.observedAt || "");
  return market.account?.positionsVerified === true && market.account?.positionSummariesVerified === true
    && market.account?.openOrdersVerified === true && timestamp <= now && now - timestamp <= 5000;
}

export function summaryExitReviewContexts(market, now = Date.now()) {
  if (market.account?.positionSummariesVerified !== true) return [];
  return (market.account.positionSummaries || []).flatMap(row => {
    if (!(Number(row.quantity) > 0) || Number(row.frozenQuantity) !== 0 || !["LONG", "SHORT"].includes(heldDirection(row))) return [];
    const book = (market.books || []).find(item => matchesInstrument(item, row)) || (matchesInstrument(market, row) ? market : null);
    const summary = { symbol: book?.symbol, instrumentId: book?.instrumentId, ...row, side: heldDirection(row) };
    const quote = executableExitQuote(market, summary, now);
    if (!quote) return [];
    return [{ key: summaryKey(summary), signature: summarySignature(summary), summary, quote,
      pnlPoints: directionalProfitPoints(summary, quote.price) }];
  });
}

export function executableSummaryPortfolio(market, now = Date.now()) {
  if (!verifiedAccount(market, now)) return null;
  const rows = (market.account.positionSummaries || []).filter(row => Number(row.quantity) > 0);
  if (!rows.length || new Set(rows.map(summaryKey)).size !== rows.length
    || rows.some(row => !Number.isFinite(Number(row.quantity)) || !Number.isFinite(Number(row.averagePrice)))) return null;
  const contexts = summaryExitReviewContexts(market, now);
  if (contexts.length !== rows.length || contexts.some(context => context.pnlPoints === null)) return null;
  const positions = (market.account.positions || []).filter(row => Number(row.quantity) > 0);
  if (positions.length && (positions.some(position => !rows.some(row => matchesInstrument(row, position)
    && heldDirection(row) === heldDirection(position))) || rows.some(row => Number(row.quantity) !== positions
    .filter(position => matchesInstrument(row, position) && heldDirection(row) === heldDirection(position))
    .reduce((sum, position) => sum + Number(position.quantity), 0)))) return null;
  return { contexts, totalPnl: Number(contexts.reduce((sum, context) =>
    sum + context.pnlPoints * Number(context.summary.quantity), 0).toFixed(8)) };
}

export function updateSummaryExitBatch(task, market, now = Date.now()) {
  if (!verifiedAccount(market, now)) return;
  const rows = (market.account.positionSummaries || []).filter(row => Number(row.quantity) > 0);
  let batch = task.summaryExitBatch;
  const pendingFor = target => unsettled(task).some(action => action.targetSummary
    && summaryKey(action.targetSummary) === summaryKey(target))
    || (market.account.openOrders || []).some(order => Number(order.remainingQuantity) > 0 && matchesInstrument(order, target));
  if (activeBatch(batch)) {
    if (batch.targets.some(target => rows.some(row => summaryKey(row) === summaryKey(target) && !batchTargetMatches(target, row)))) {
      batch.phase = "INVALIDATED";
      batch.reason = "持仓均价或数量增加，原离场批次失效";
      return;
    }
    if (batch.targets.every(target => !rows.some(row => batchTargetMatches(target, row)) && !pendingFor(target))) {
      batch.phase = "COMPLETE";
      batch.completedAt = new Date(now).toISOString();
      return;
    }
    if (batch.phase === "EXIT_LOSERS") {
      for (const context of summaryExitReviewContexts(market, now)) {
        const target = batch.targets.find(target => target.role === "WINNER" && batchTargetMatches(target, context.summary));
        if (target && context.pnlPoints < 0) target.role = "LOSER";
      }
    }
    if (batch.phase === "EXIT_LOSERS" && batch.targets.filter(target => target.role === "LOSER")
      .every(target => !rows.some(row => batchTargetMatches(target, row)) && !pendingFor(target))) {
      batch.phase = "WATCH_WINNERS";
      batch.watchStartedAt = new Date(now).toISOString();
      batch.winnerDeadlineAt = new Date(now + HEDGE_WINNER_HOLD_MS).toISOString();
    }
    if (batch.phase === "WATCH_WINNERS") {
      if (now >= Date.parse(batch.winnerDeadlineAt)) {
        batch.phase = "EXIT_WINNERS";
        batch.winnerExitReason = "HEDGE_WINNER_DEADLINE";
      } else {
        const winners = rows.filter(row => batch.targets.some(target => target.role === "WINNER" && batchTargetMatches(target, row)));
        const contexts = summaryExitReviewContexts(market, now).filter(context =>
          winners.some(row => summarySignature(row) === context.signature));
        if (winners.length && contexts.length === winners.length) {
          const profit = Number(contexts.reduce((sum, context) => sum + context.pnlPoints * Number(context.summary.quantity), 0).toFixed(8));
          const samples = batch.winnerProfitSamples || {};
          if (contexts.some(context => context.pnlPoints <= 0 || (samples[context.key]
            && context.quote.observedAt > samples[context.key].observedAt && context.pnlPoints < samples[context.key].pnlPoints))) {
            batch.phase = "EXIT_WINNERS";
            batch.winnerExitReason = "HEDGE_WINNER_PULLBACK";
          }
          batch.winnerProfitSamples = Object.fromEntries(contexts.map(context => [context.key,
            { pnlPoints: context.pnlPoints, observedAt: context.quote.observedAt }]));
          batch.lastWinnerProfit = profit;
        }
      }
    }
    return;
  }
  if (unsettled(task).length || (market.account.openOrders || []).some(order => Number(order.remainingQuantity) > 0)) return;
  const portfolio = executableSummaryPortfolio(market, now);
  if (!portfolio) return;
  const negative = portfolio.contexts.filter(context => context.pnlPoints < 0);
  const mixed = new Set(portfolio.contexts.map(context => heldDirection(context.summary))).size === 2;
  const all = portfolio.totalPnl > 0;
  if (!all && !(mixed && negative.length)) return;
  batch = { id: `summary-batch:${now}:${summarySignature(rows[0])}`, phase: all ? "EXIT_ALL" : "EXIT_LOSERS",
    startedAt: new Date(now).toISOString(), triggerPnl: portfolio.totalPnl,
    targets: portfolio.contexts.filter(context => all || context.pnlPoints !== 0).map(context => ({ ...context.summary,
      role: all ? "ALL" : context.pnlPoints < 0 ? "LOSER" : "WINNER" })) };
  task.summaryExitBatch = batch;
}

export function summaryRuleAuthorizationCurrent(task, summary, authorization) {
  const batch = task.summaryExitBatch;
  if (!activeBatch(batch) || authorization?.source !== "USER_RULE" || authorization.batchId !== batch.id) return false;
  return batch.targets.some(target => batchTargetMatches(target, summary)
    && (batch.phase === "EXIT_ALL" ? authorization.trigger === "TOTAL_PROFIT"
      : batch.phase === "EXIT_LOSERS" ? target.role === "LOSER" && authorization.trigger === "HEDGE_LOSS"
      : batch.phase === "EXIT_WINNERS" && target.role === "WINNER" && authorization.trigger === batch.winnerExitReason));
}

export function installSummaryPlan(task, context, source, { id, observedAt, now = Date.now(), origin = "AI_REVIEW" } = {}) {
  const validated = validateHoldingPlan(source, context.summary, { observedAt, now,
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
    const protection = profitProtectionFor(context.summary, record.plan);
    if (protection && (long ? price >= protection.activationPrice : price <= protection.activationPrice)) record.profitArmed = true;
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
  const protection = profitProtectionFor(summary, plan);
  if (record.profitArmed && protection) {
    const floor = long ? Math.max(protection.floorPrice, record.bestPrice - protection.trailingDistance)
      : Math.min(protection.floorPrice, record.bestPrice + protection.trailingDistance);
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
  if (authorization.source === "USER_RULE") return Boolean(authorization.batchId)
    && ["TOTAL_PROFIT", "HEDGE_LOSS", "HEDGE_WINNER_DEADLINE", "HEDGE_WINNER_PULLBACK"].includes(authorization.trigger);
  if (authorization.trigger === "AI_EXIT_NOW") {
    if (!(Number(authorization.exitPrice) > 0)) return false;
    return heldDirection(summary) === "LONG" ? price >= authorization.exitPrice : price <= authorization.exitPrice;
  }
  return summaryReviewType(summary, price, authorization.record, now) === authorization.trigger;
}

export function summaryExitCandidates(task, market, now = Date.now()) {
  updateSummaryExitBatch(task, market, now);
  return summaryExitReviewContexts(market, now).flatMap(context => {
    const batch = task.summaryExitBatch;
    const ruleTrigger = batch?.phase === "EXIT_ALL" ? "TOTAL_PROFIT"
      : batch?.phase === "EXIT_LOSERS" ? "HEDGE_LOSS"
      : batch?.phase === "EXIT_WINNERS" ? batch.winnerExitReason : null;
    const rule = { id: `${batch?.id}:${context.key}`, batchId: batch?.id, source: "USER_RULE",
      signature: context.signature, decision: "EXIT", trigger: ruleTrigger,
      expiresAt: new Date(now + SUMMARY_REVIEW_TTL_MS).toISOString() };
    const userAuthorized = ruleTrigger && summaryRuleAuthorizationCurrent(task, context.summary, rule);
    const record = (task.summaryTradingPlans || []).find(item => item.signature === context.signature);
    const trigger = summaryReviewType(context.summary, context.quote.price, record, now);
    const review = (task.summaryExitReviews || []).find(item => item.signature === context.signature && item.decision === "EXIT");
    const immediate = review && summaryExitAllowsPrice(context.summary, context.quote.price, review, now);
    const retainedWinner = activeBatch(batch) && ["EXIT_LOSERS", "WATCH_WINNERS"].includes(batch.phase)
      && batch.targets.some(target => target.role === "WINNER" && batchTargetMatches(target, context.summary));
    const mandatoryRisk = ["HARD_STOP", "STOP_LOSS", "MAX_HOLD"].includes(trigger);
    if (retainedWinner && !mandatoryRisk && !userAuthorized) return [];
    if (!userAuthorized && !trigger && !immediate) return [];
    const selectedTrigger = userAuthorized ? ruleTrigger : trigger || "AI_EXIT_NOW";
    const exitType = context.pnlPoints > 0 ? "TAKE_PROFIT" : "STOP_LOSS";
    const authorization = userAuthorized ? rule : trigger ? { id: record.id, signature: context.signature, decision: "EXIT",
      trigger, record: structuredClone(record), expiresAt: new Date(now + SUMMARY_REVIEW_TTL_MS).toISOString() } : review;
    return [{ summary: context.summary, decision: { action: context.summary.side === "LONG" ? "SELL" : "BUY",
      orderType: "MARKET", exitType, exitReason: selectedTrigger, pnlPoints: context.pnlPoints,
      targetSummary: context.summary, targetPositionIds: [], targetSymbol: context.summary.symbol,
      targetSymbolName: context.summary.symbolName, targetInstrumentId: context.summary.instrumentId,
      exitGuard: { summary: true, aiAuthorization: authorization, expiresAt: authorization.expiresAt,
        triggerPrice: context.quote.price, pnlPoints: context.pnlPoints } } }];
  });
}
