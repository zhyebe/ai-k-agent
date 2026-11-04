import { summarizeOrderBook } from "./order-book.mjs";
import { heldDirection } from "./exit-policy.mjs";
import { confirmedCandlesForAnalysis } from "./analysis-context.mjs";

const number = value => !["number", "string"].includes(typeof value) || String(value).trim() === "" ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => String(value || "").trim().slice(0, 600);
export const instrumentValues = value => [value?.symbol, value?.symbolName, value?.instrumentId]
  .map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
export const matchesInstrument = (left, right) => instrumentValues(left).some(value => instrumentValues(right).includes(value));

export function parseTradingCosts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 100 || entries.some(([symbol, cost]) => !symbol.trim() || symbol.length > 120 || number(cost) === null || number(cost) < 0)) return null;
  return Object.fromEntries(entries.map(([symbol, cost]) => [symbol.trim(), number(cost)]));
}

export function costPointsFor(instrument, costs = {}) {
  const explicit = number(instrument?.roundTripCostPoints);
  const fees = number(instrument?.roundTripFee ?? instrument?.totalFees);
  const quantity = number(instrument?.quantity);
  const recorded = fees !== null && fees >= 0 && quantity > 0 ? fees / quantity : null;
  const values = instrumentValues(instrument);
  const configured = Object.entries(costs || {}).filter(([symbol]) => values.includes(symbol.trim().toLowerCase()))
    .map(([, value]) => number(value));
  const known = [explicit, recorded, ...configured].filter(value => value !== null && value >= 0);
  return known.length ? Math.max(...known) : null;
}

export function planNetPoints(summary, price, costPoints) {
  const average = number(summary?.averagePrice);
  const direction = heldDirection(summary);
  if (!(average > 0) || !(number(price) > 0) || !["LONG", "SHORT"].includes(direction)) return null;
  const grossPoints = Number(((Number(price) - average) * (direction === "LONG" ? 1 : -1)).toFixed(8));
  return { grossPoints, netPoints: costPoints === null ? null : Number((grossPoints - costPoints).toFixed(8)) };
}

export function normalizeTradingPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const zone = value.entry_zone ?? value.entryZone ?? {};
  const protection = value.profit_protection ?? value.profitProtection ?? {};
  return {
    setup: text(value.setup).toUpperCase(),
    entryZone: { min: number(zone.min), max: number(zone.max) },
    anchorPrice: number(value.anchor_price ?? value.anchorPrice),
    anchorTimestamp: text(value.anchor_timestamp ?? value.anchorTimestamp),
    takeProfitPrice: number(value.take_profit_price ?? value.takeProfitPrice),
    stopLossPrice: number(value.stop_loss_price ?? value.stopLossPrice),
    hardStopPrice: number(value.hard_stop_price ?? value.hardStopPrice),
    stopConfirmationSec: number(value.stop_confirmation_sec ?? value.stopConfirmationSec),
    validForSec: number(value.valid_for_sec ?? value.validForSec),
    maxHoldSec: number(value.max_hold_sec ?? value.maxHoldSec),
    profitProtection: {
      activationPrice: number(protection.activation_price ?? protection.activationPrice),
      floorPrice: number(protection.floor_price ?? protection.floorPrice),
      trailingDistance: number(protection.trailing_distance ?? protection.trailingDistance),
    },
    rationale: text(value.rationale),
    invalidation: text(value.invalidation),
  };
}

export function validateHoldingPlan(value, summary, { observedAt, now = Date.now(), costs = {}, allowExpired = false } = {}) {
  const plan = normalizeTradingPlan(value);
  const side = heldDirection(summary), long = side === "LONG";
  const direction = long ? 1 : -1;
  const average = number(summary?.averagePrice);
  if (!plan || !["LONG", "SHORT"].includes(side) || !(average > 0)) return { code: "AI_PLAN_REQUIRED" };
  if (![plan.takeProfitPrice, plan.stopLossPrice, plan.hardStopPrice].every(price => price > 0)
    || direction * (plan.takeProfitPrice - average) <= 0
    || direction * (plan.takeProfitPrice - plan.stopLossPrice) <= 0
    || direction * (plan.stopLossPrice - plan.hardStopPrice) < 0
    || direction * (average - plan.hardStopPrice) <= 0) return { code: "AI_PLAN_PRICE_INVALID" };
  if (!Number.isSafeInteger(plan.validForSec) || plan.validForSec <= 0 || plan.validForSec > 3600
    || !Number.isSafeInteger(plan.maxHoldSec) || plan.maxHoldSec <= 0 || plan.maxHoldSec > 86400
    || !Number.isSafeInteger(plan.stopConfirmationSec) || plan.stopConfirmationSec < 0 || plan.stopConfirmationSec > 300
    || !plan.rationale || !plan.invalidation) return { code: "AI_PLAN_RISK_INVALID" };
  const timestamp = Date.parse(observedAt || "");
  if (!Number.isFinite(timestamp) || timestamp > now || (!allowExpired && timestamp + plan.validForSec * 1000 <= now)) return { code: "AI_PLAN_EXPIRED" };
  const protection = plan.profitProtection;
  if (!(protection.activationPrice > 0) || !(protection.floorPrice > 0) || !(protection.trailingDistance > 0)
    || direction * (protection.floorPrice - average) <= 0
    || direction * (protection.activationPrice - protection.floorPrice) <= 0
    || direction * (plan.takeProfitPrice - protection.activationPrice) < 0
    || protection.trailingDistance >= direction * (protection.activationPrice - average)) return { code: "AI_PLAN_PROTECTION_INVALID" };
  const costPoints = costPointsFor(summary, costs);
  if (costPoints !== null && [plan.takeProfitPrice, protection.floorPrice,
    protection.activationPrice - direction * protection.trailingDistance].some(price => planNetPoints(summary, price, costPoints).netPoints <= 0)) {
    return { code: "AI_PLAN_NET_PROFIT_INVALID" };
  }
  return { plan, costPoints, observedAt: new Date(timestamp).toISOString(),
    expiresAt: new Date(timestamp + plan.validForSec * 1000).toISOString(),
    maxHoldAt: new Date(timestamp + plan.maxHoldSec * 1000).toISOString() };
}

export function executableEntryQuote(market, action, quantity, now = Date.now()) {
  const timestamp = Date.parse(market?.observedAt || "");
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > 5000) return null;
  const depth = summarizeOrderBook(market.orderBook || market.pageView?.orderBook);
  if (depth.status === "CROSSED") return null;
  const levels = action === "BUY" ? depth.asks : action === "SELL" ? depth.bids : [];
  let remaining = Number(quantity), value = 0, price = null;
  if (!(remaining > 0)) return null;
  for (const level of levels) {
    const filled = Math.min(remaining, level.volume);
    if (!filled) continue;
    value += filled * level.price;
    remaining -= filled;
    price = level.price;
    if (remaining <= 0) return { price, averagePrice: value / Number(quantity), quantity: Number(quantity), observedAt: timestamp };
  }
  return null;
}

export function entryPlanAllowsPrice(guard, price, now = Date.now()) {
  if (!guard || !["BUY", "SELL"].includes(guard.action) || !(number(price) > 0)
    || !Number.isFinite(Date.parse(guard.expiresAt)) || now >= Date.parse(guard.expiresAt)
    || guard.costPoints === null || number(guard.costPoints) === null) return false;
  const plan = normalizeTradingPlan(guard.plan);
  if (!plan || price < plan.entryZone.min || price > plan.entryZone.max) return false;
  const direction = guard.action === "BUY" ? 1 : -1;
  return direction * (plan.takeProfitPrice - price) > guard.costPoints
    && direction * (price - plan.stopLossPrice) > 0
    && direction * (price - plan.hardStopPrice) > 0
    && direction * (plan.profitProtection.floorPrice - price) > guard.costPoints
    && direction * (plan.profitProtection.activationPrice - price) - plan.profitProtection.trailingDistance > guard.costPoints;
}

export function validateEntryPlan(decision, market, task, now = Date.now()) {
  const plan = normalizeTradingPlan(decision.tradePlan);
  const long = decision.action === "BUY";
  const entry = number(decision.entryPrice);
  if (!plan || !(entry > 0)) return { code: "AI_ENTRY_PLAN_REQUIRED" };
  if (plan.setup !== (long ? "SUPPORT_REBOUND" : "RESISTANCE_REJECTION")
    || !(plan.entryZone.min > 0) || plan.entryZone.max < plan.entryZone.min
    || entry < plan.entryZone.min || entry > plan.entryZone.max
    || !(plan.anchorPrice > 0) || !plan.anchorTimestamp
    || plan.anchorPrice < plan.entryZone.min || plan.anchorPrice > plan.entryZone.max
    || (long ? plan.stopLossPrice >= plan.entryZone.min : plan.stopLossPrice <= plan.entryZone.max)) return { code: "AI_ENTRY_ZONE_INVALID" };
  const groups = [[market.timeframe || "1m", market.history || []],
    ...Object.entries(market.timeframes || {}).map(([timeframe, frame]) => [timeframe, frame?.history || []])];
  const candles = groups.flatMap(([timeframe, rows]) => confirmedCandlesForAnalysis(rows.map(item => ({
    ...item, sourceTimestamp: String(item.timestamp),
    timestamp: number(item.timestamp) ?? Date.parse(item.timestamp),
  })).filter(item => Number.isFinite(item.timestamp) && item.timestamp <= now && item.confirmation !== "PROVISIONAL"
    && [item.open, item.high, item.low, item.close].every(price => number(price) > 0)
    && item.low <= Math.min(item.open, item.close) && item.high >= Math.max(item.open, item.close)), timeframe, now));
  const candle = candles.find(item => item.sourceTimestamp === plan.anchorTimestamp && Number(item[long ? "low" : "high"]) === plan.anchorPrice);
  if (!candle) return { code: "AI_ENTRY_ANCHOR_UNVERIFIED" };
  const summary = { ...market, side: long ? "LONG" : "SHORT", averagePrice: entry };
  const validated = validateHoldingPlan(plan, summary, { observedAt: decision.observedAt || market.observedAt, now, costs: task.tradingCosts });
  if (validated.code) return validated;
  if (validated.costPoints === null) return { code: "TRADING_COSTS_REQUIRED" };
  const guard = { action: decision.action, plan, costPoints: validated.costPoints, expiresAt: validated.expiresAt,
    symbol: market.symbol, symbolName: market.symbolName, instrumentId: market.instrumentId };
  const quote = executableEntryQuote(market, decision.action, task.entryQuantity || 1, now);
  if (!quote) return { code: "ENTRY_QUOTE_OR_DEPTH_UNVERIFIED" };
  const price = decision.orderType === "LIMIT" ? number(decision.targetPrice ?? entry) : quote.price;
  if (!entryPlanAllowsPrice(guard, price, now)) return { code: "ENTRY_PRICE_OUTSIDE_AI_PLAN" };
  return { plan, guard, quote, price };
}

export function tightenHoldingPlan(previous, next) {
  if (!previous) return next;
  const long = previous.summary.side === "LONG";
  const tighterStop = (left, right) => long ? Math.max(left, right) : Math.min(left, right);
  const earlierTarget = (left, right) => long ? Math.min(left, right) : Math.max(left, right);
  const plan = { ...next.plan,
    takeProfitPrice: earlierTarget(previous.plan.takeProfitPrice, next.plan.takeProfitPrice),
    stopLossPrice: tighterStop(previous.plan.stopLossPrice, next.plan.stopLossPrice),
    hardStopPrice: tighterStop(previous.plan.hardStopPrice, next.plan.hardStopPrice),
    stopConfirmationSec: Math.min(previous.plan.stopConfirmationSec, next.plan.stopConfirmationSec),
    profitProtection: {
      activationPrice: earlierTarget(previous.plan.profitProtection.activationPrice, next.plan.profitProtection.activationPrice),
      floorPrice: tighterStop(previous.plan.profitProtection.floorPrice, next.plan.profitProtection.floorPrice),
      trailingDistance: Math.min(previous.plan.profitProtection.trailingDistance, next.plan.profitProtection.trailingDistance),
    } };
  return { ...next, plan, maxHoldAt: new Date(Math.min(Date.parse(previous.maxHoldAt), Date.parse(next.maxHoldAt))).toISOString(),
    bestPrice: previous.bestPrice, profitArmed: previous.profitArmed, lossObservation: previous.lossObservation,
    createdAt: previous.createdAt };
}
