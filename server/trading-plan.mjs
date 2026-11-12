import { summarizeOrderBook } from "./order-book.mjs";
import { heldDirection } from "./exit-policy.mjs";

const number = value => !["number", "string"].includes(typeof value) || String(value).trim() === "" ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => String(value || "").trim().slice(0, 600);
export const instrumentValues = value => [value?.symbol, value?.symbolName, value?.instrumentId]
  .map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
export const matchesInstrument = (left, right) => instrumentValues(left).some(value => instrumentValues(right).includes(value));

export function directionalProfitPoints(summary, price) {
  const average = number(summary?.averagePrice);
  const direction = heldDirection(summary);
  if (!(average > 0) || !(number(price) > 0) || !["LONG", "SHORT"].includes(direction)) return null;
  return Number(((Number(price) - average) * (direction === "LONG" ? 1 : -1)).toFixed(8));
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

export function profitProtectionFor(summary, plan) {
  const protection = plan?.profitProtection;
  const side = heldDirection(summary), direction = side === "LONG" ? 1 : -1;
  const average = number(summary?.averagePrice);
  if (!["LONG", "SHORT"].includes(side) || !(average > 0)
    || !protection || ![protection.activationPrice, protection.floorPrice, protection.trailingDistance].every(price => number(price) > 0)
    || direction * (protection.activationPrice - average) < 0
    || direction * (protection.floorPrice - average) < 0
    || direction * (protection.activationPrice - protection.floorPrice) < 0) return null;
  return protection;
}

export function validateHoldingPlan(value, summary, { observedAt, now = Date.now(), allowExpired = false } = {}) {
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
  const profitProtectionEnabled = Boolean(profitProtectionFor(summary, plan));
  return { plan, profitProtectionEnabled, warnings: profitProtectionEnabled ? [] : ["AI_PROFIT_PROTECTION_UNAVAILABLE"],
    observedAt: new Date(timestamp).toISOString(),
    expiresAt: new Date(timestamp + plan.validForSec * 1000).toISOString(),
    maxHoldAt: new Date(timestamp + plan.maxHoldSec * 1000).toISOString() };
}

export function entryOrderPrice(market, action, quantity) {
  const depth = summarizeOrderBook(market?.orderBook || market?.pageView?.orderBook);
  const levels = action === "BUY" ? depth.asks : action === "SELL" ? depth.bids : [];
  let remaining = Number(quantity);
  for (const level of levels) {
    remaining -= level.volume;
    if (remaining <= 0) return level.price;
  }
  return levels.at(-1)?.price ?? null;
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
  return Boolean(guard && ["BUY", "SELL"].includes(guard.action) && number(price) > 0
    && Number.isFinite(Date.parse(guard.expiresAt)) && now < Date.parse(guard.expiresAt));
}

export function validateEntryPlan(decision, market, task, now = Date.now()) {
  if (!["BUY", "SELL"].includes(decision.action)) return { code: "AI_ENTRY_ACTION_REQUIRED" };
  const quote = executableEntryQuote(market, decision.action, task.entryQuantity || 1, now);
  if (!quote) return { code: "ENTRY_QUOTE_OR_DEPTH_UNVERIFIED" };
  const price = decision.orderType === "LIMIT" ? number(decision.targetPrice ?? decision.entryPrice) : quote.price;
  if (!(price > 0)) return { code: "ENTRY_LIMIT_PRICE_REQUIRED" };
  const observedAt = decision.observedAt || market.observedAt;
  const timestamp = Date.parse(observedAt || "");
  const ttlSec = number(decision.decisionTtlSec) || 300;
  if (!Number.isFinite(timestamp) || timestamp > now || timestamp + ttlSec * 1000 <= now) return { code: "AI_ENTRY_DECISION_EXPIRED" };
  const plan = normalizeTradingPlan(decision.tradePlan);
  const summary = { ...market, side: decision.action === "BUY" ? "LONG" : "SHORT", averagePrice: price };
  const validated = validateHoldingPlan(plan, summary, { observedAt, now });
  const guard = { action: decision.action, plan, orderType: decision.orderType || "MARKET",
    targetPrice: decision.orderType === "LIMIT" ? price : null, expiresAt: new Date(timestamp + ttlSec * 1000).toISOString(),
    symbol: market.symbol, symbolName: market.symbolName, instrumentId: market.instrumentId };
  return { plan, guard, quote, price, warnings: validated.code ? ["AI_ENTRY_RISK_PLAN_PENDING"] : validated.warnings };
}

export function tightenHoldingPlan(previous, next) {
  if (!previous) return next;
  const long = previous.summary.side === "LONG";
  const tighterStop = (left, right) => long ? Math.max(left, right) : Math.min(left, right);
  const earlierTarget = (left, right) => long ? Math.min(left, right) : Math.max(left, right);
  const priorProtection = profitProtectionFor(previous.summary, previous.plan);
  const nextProtection = profitProtectionFor(next.summary, next.plan);
  const plan = { ...next.plan,
    takeProfitPrice: previous.plan.takeProfitPrice,
    maxHoldSec: previous.plan.maxHoldSec,
    stopLossPrice: tighterStop(previous.plan.stopLossPrice, next.plan.stopLossPrice),
    hardStopPrice: tighterStop(previous.plan.hardStopPrice, next.plan.hardStopPrice),
    stopConfirmationSec: Math.min(previous.plan.stopConfirmationSec, next.plan.stopConfirmationSec),
    profitProtection: priorProtection && nextProtection ? {
      activationPrice: earlierTarget(priorProtection.activationPrice, nextProtection.activationPrice),
      floorPrice: tighterStop(priorProtection.floorPrice, nextProtection.floorPrice),
      trailingDistance: Math.min(priorProtection.trailingDistance, nextProtection.trailingDistance),
    } : priorProtection || nextProtection || next.plan.profitProtection };
  if (priorProtection && !profitProtectionFor(next.summary, plan)) plan.profitProtection = priorProtection;
  const profitProtectionEnabled = Boolean(profitProtectionFor(next.summary, plan));
  return { ...next, plan, profitProtectionEnabled, warnings: profitProtectionEnabled ? [] : ["AI_PROFIT_PROTECTION_UNAVAILABLE"],
    maxHoldAt: previous.maxHoldAt,
    bestPrice: previous.bestPrice, profitArmed: previous.profitArmed, lossObservation: previous.lossObservation,
    createdAt: previous.createdAt };
}
