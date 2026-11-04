export function tradingPlan(side = "LONG", average = 100, overrides = {}) {
  const direction = side === "LONG" ? 1 : -1;
  return {
    setup: side === "LONG" ? "SUPPORT_REBOUND" : "RESISTANCE_REJECTION",
    entryZone: { min: average - 0.5, max: average + 0.5 },
    anchorPrice: average - direction * 0.5,
    anchorTimestamp: new Date(Date.now() - 120000).toISOString(),
    takeProfitPrice: average + direction * 4,
    stopLossPrice: average - direction * 2,
    hardStopPrice: average - direction * 5,
    stopConfirmationSec: 30, validForSec: 60, maxHoldSec: 300,
    profitProtection: { activationPrice: average + direction * 2, floorPrice: average + direction, trailingDistance: 0.5 },
    rationale: "已确认支撑反弹或阻力受阻，目标对应结构位",
    invalidation: "结构失效后确认止损，硬边界立即离场",
    ...overrides,
  };
}

export function anchorCandle(plan) {
  const average = (plan.entryZone.min + plan.entryZone.max) / 2;
  return { timestamp: plan.anchorTimestamp, open: average, close: average, high: plan.entryZone.max, low: plan.entryZone.min,
    volume: 100, confirmation: "CONFIRMED" };
}

export function entryGuard(action, price, symbol = "DGKZ") {
  const plan = tradingPlan(action === "BUY" ? "LONG" : "SHORT", price);
  return { action, symbol, plan, costPoints: 0.2, expiresAt: new Date(Date.now() + 60000).toISOString() };
}
import { summarySignature } from "../../server/summary-exit-policy.mjs";


export function summaryAuthorization(summary, price) {
  return { id: "fixture-ai-exit", decision: "EXIT", trigger: "AI_EXIT_NOW", exitPrice: price,
    signature: summarySignature(summary), expiresAt: new Date(Date.now() + 60000).toISOString() };
}
