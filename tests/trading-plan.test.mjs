import assert from "node:assert/strict";
import test from "node:test";
import { directionalProfitPoints, entryPlanAllowsPrice, executableEntryQuote, normalizeTradingPlan, profitProtectionFor, validateEntryPlan, validateHoldingPlan } from "../server/trading-plan.mjs";
import { executableExitQuote } from "../server/exit-policy.mjs";
import { installSummaryPlan, observeSummaryPlans, summaryExitAllowsPrice, summaryExitCandidates, summaryExitReviewContexts, summaryReviewType } from "../server/summary-exit-policy.mjs";
import { anchorCandle, tradingPlan } from "./fixtures/trading-plan.mjs";

function fixture(side = "LONG", now = Date.now()) {
  const summary = { symbol: "A", symbolName: "商品A", side, quantity: 3, averagePrice: 100, frozenQuantity: 0 };
  const market = { symbol: "A", symbolName: "商品A", observedAt: new Date(now).toISOString(), history: [],
    account: { positionSummariesVerified: true, positionSummaries: [summary] },
    orderBook: { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] } };
  const plan = tradingPlan(side);
  market.history = [anchorCandle(plan)];
  const task = { entryQuantity: 3 };
  const context = summaryExitReviewContexts(market, now)[0];
  const installed = installSummaryPlan(task, context, plan, { id: "plan-ai", observedAt: market.observedAt, now });
  assert.ok(installed.record, installed.code);
  return { market, summary, plan, task, record: installed.record, now };
}

for (const side of ["LONG", "SHORT"]) test(`${side} AI entry follows real quotes without a risk-plan or reference-zone veto`, () => {
  const { market, plan, task, now } = fixture(side);
  const decision = { action: side === "LONG" ? "BUY" : "SELL", entryPrice: 100, orderType: "MARKET", tradePlan: plan };
  assert.ok(validateEntryPlan(decision, market, task, now).guard);
  const withoutPlan = validateEntryPlan({ ...decision, tradePlan: null, entryPrice: null }, market, task, now);
  assert.ok(withoutPlan.guard);
  assert.deepEqual(withoutPlan.warnings, ["AI_ENTRY_RISK_PLAN_PENDING"]);
  const outside = side === "LONG" ? 110 : 90;
  market.orderBook.bids[0].price = outside;
  market.orderBook.asks[0].price = outside;
  const refreshed = validateEntryPlan(decision, market, task, now);
  assert.ok(refreshed.guard);
  assert.equal(refreshed.price, outside);
});
for (const fault of ["unknown-anchor", "provisional-anchor", "provisional-marker", "future-anchor", "wrong-setup", "loss-target", "invalid-hard-stop", "expired", "stale-book", "insufficient-depth"]) {
  test(`entry treats ${fault} as advisory except unreadable execution quotes`, () => {
    const { market, plan, task, now } = fixture();
    if (fault === "unknown-anchor") plan.anchorPrice = 99.6;
    if (fault === "provisional-anchor") market.history[0].confirmation = "PROVISIONAL";
    if (fault === "provisional-marker") market.history[0].confirmation = { status: "PROVISIONAL" };
    if (fault === "future-anchor") market.history[0].timestamp = plan.anchorTimestamp = new Date(now + 60000).toISOString();
    if (fault === "wrong-setup") plan.setup = "CHASE_BREAKOUT";
    if (fault === "loss-target") plan.takeProfitPrice = 99;
    if (fault === "invalid-hard-stop") plan.hardStopPrice = 99;
    if (fault === "expired") plan.validForSec = 0;
    if (fault === "stale-book") market.observedAt = new Date(now - 6000).toISOString();
    if (fault === "insufficient-depth") market.orderBook.asks[0].volume = 1;
    const result = validateEntryPlan({ action: "BUY", entryPrice: 100, tradePlan: plan }, market, task, now);
    if (["stale-book", "insufficient-depth"].includes(fault)) assert.equal(result.code, "ENTRY_QUOTE_OR_DEPTH_UNVERIFIED");
    else {
      assert.ok(result.guard, result.code);
      assert.equal(result.plan.takeProfitPrice, plan.takeProfitPrice);
      assert.equal(result.plan.hardStopPrice, plan.hardStopPrice);
    }
  });
}
test("entry authorization retains AI TTL and explicit limit price without inventing a price", () => {
  const { market, task, now } = fixture();
  assert.equal(validateEntryPlan({ action: "HOLD" }, market, task, now).code, "AI_ENTRY_ACTION_REQUIRED");
  assert.equal(validateEntryPlan({ action: "BUY", orderType: "LIMIT" }, market, task, now).code, "ENTRY_LIMIT_PRICE_REQUIRED");
  const result = validateEntryPlan({ action: "BUY", orderType: "LIMIT", targetPrice: 90, decisionTtlSec: 120 }, market, task, now);
  assert.equal(result.price, 90);
  assert.equal(result.guard.targetPrice, 90);
  assert.equal(entryPlanAllowsPrice(result.guard, 200, now), true);
  assert.equal(entryPlanAllowsPrice(result.guard, 100, now + 120000), false);
});
test("directional price arithmetic keeps invalid data unknown and reverses shorts", () => {
  assert.equal(directionalProfitPoints({ side: "LONG", averagePrice: 100 }, 100.1), 0.1);
  assert.equal(directionalProfitPoints({ side: "SHORT", averagePrice: 100 }, 99.9), 0.1);
  for (const price of [null, "", " ", false, [], {}, -1, Infinity]) {
    assert.equal(directionalProfitPoints({ side: "LONG", averagePrice: 100 }, price), null);
  }
  assert.equal(directionalProfitPoints({ side: "UNKNOWN", averagePrice: 100 }, 101), null);
});
test("legacy costs and optional protection cannot veto a valid executable entry", () => {
  const { market, plan, task, now } = fixture();
  const { guard } = validateEntryPlan({ action: "BUY", entryPrice: 100, tradePlan: plan }, market, task, now);
  assert.equal(entryPlanAllowsPrice(guard, 100.5, now), true);
  assert.equal(entryPlanAllowsPrice({ ...guard, costPoints: 1000 }, 100.5, now), true);
  for (const profitProtection of [null, {}, { activationPrice: 99, floorPrice: 98, trailingDistance: 2 }]) {
    const result = validateEntryPlan({ action: "BUY", entryPrice: 100, tradePlan: { ...plan, profitProtection } }, market, task, now);
    assert.ok(result.guard);
    assert.deepEqual(result.warnings, ["AI_PROFIT_PROTECTION_UNAVAILABLE"]);
  }
});
for (const side of ["LONG", "SHORT"]) test(`${side} a confirmed relative anchor may sit outside the executable entry zone`, () => {
  const { market, plan, task, now } = fixture(side);
  plan.anchorPrice = side === "LONG" ? 98.5 : 101.5;
  market.history[0][side === "LONG" ? "low" : "high"] = plan.anchorPrice;
  assert.ok(validateEntryPlan({ action: side === "LONG" ? "BUY" : "SELL", entryPrice: 100, tradePlan: plan }, market, task, now).guard);
});
test("screenshot entry 1256-1257 remains executable with an unusable optional protection", () => {
  const { market, task, now } = fixture();
  const plan = tradingPlan("LONG", 1256, { entryZone: { min: 1256, max: 1257 }, takeProfitPrice: 1259,
    stopLossPrice: 1255, hardStopPrice: 1253, profitProtection: { activationPrice: 1258, floorPrice: 1255, trailingDistance: 5 } });
  plan.anchorPrice = 1254;
  market.history = [{ ...anchorCandle(plan), low: 1254 }];
  market.orderBook.bids[0].price = market.orderBook.asks[0].price = 1256.5;
  const result = validateEntryPlan({ action: "BUY", entryPrice: 1256, tradePlan: plan }, market, task, now);
  assert.ok(result.guard, result.code);
  assert.equal(result.price, 1256.5);
  const installed = installSummaryPlan(task, { key: "screenshot", signature: "screenshot",
    summary: { side: "LONG", averagePrice: 1256.5, quantity: 3 }, quote: { price: 1256.5 } },
  plan, { id: "screenshot", observedAt: market.observedAt, now });
  assert.equal(installed.record.plan.hardStopPrice, 1253);
  assert.equal(installed.record.profitProtectionEnabled, false);
});
test("normalizer preserves AI risk fields and does not create default prices", () => {
  const plan = normalizeTradingPlan({ take_profit_price: 104, stop_loss_price: 98 });
  assert.equal(plan.takeProfitPrice, 104);
  assert.equal(plan.hardStopPrice, null);
  assert.equal(plan.profitProtection.activationPrice, null);
});
for (const side of ["LONG", "SHORT"]) test(`${side} full quantity quote uses worst executable depth price`, () => {
  const { market, summary, now } = fixture(side);
  if (side === "LONG") { market.orderBook.bids = [{ price: 103, volume: 1 }, { price: 98, volume: 2 }]; market.orderBook.asks[0].price = 104; }
  else { market.orderBook.asks = [{ price: 97, volume: 1 }, { price: 102, volume: 2 }]; market.orderBook.bids[0].price = 96; }
  const quote = executableExitQuote(market, summary, now);
  assert.equal(quote.price, side === "LONG" ? 98 : 102);
  assert.equal(quote.volume, 3);
  const entry = executableEntryQuote(market, side === "LONG" ? "SELL" : "BUY", 3, now);
  assert.equal(entry.price, quote.price);
});
for (const side of ["LONG", "SHORT"]) test(`${side} target and trailing protection act while model is unavailable`, () => {
  const { task, market, summary, record, now } = fixture(side);
  const direction = side === "LONG" ? 1 : -1;
  const tick = (points, offset) => {
    market.observedAt = new Date(now + offset).toISOString();
    market.orderBook.bids[0].price = market.orderBook.asks[0].price = 100 + direction * points;
    observeSummaryPlans(task, market, now + offset);
    return summaryExitCandidates(task, market, now + offset);
  };
  assert.equal(tick(3, 1000).length, 0);
  assert.equal(record.profitArmed, true);
  const protection = tick(2.4, 2000)[0];
  assert.equal(protection.decision.exitReason, "PROFIT_PROTECTION");
  assert.equal(protection.decision.pnlPoints, 2.4);
  assert.equal(summaryExitAllowsPrice(summary, 100 + direction * 2.4, protection.decision.exitGuard.aiAuthorization, now + 2000), true);
  assert.equal(tick(4, 3000)[0].decision.exitReason, "TAKE_PROFIT");
});
test("repeated flash events cannot postpone confirmed AI stop, but recovered price cancels soft breach", () => {
  const { task, market, record, now } = fixture();
  for (let seconds = 0; seconds <= 35; seconds += 5) {
    market.observedAt = new Date(now + seconds * 1000).toISOString();
    market.flashK = { suspected: true, observedAt: seconds, price: 98 - seconds / 100 };
    market.orderBook.bids[0].price = market.orderBook.asks[0].price = 98 - seconds / 100;
    observeSummaryPlans(task, market, now + seconds * 1000);
    assert.equal(summaryExitCandidates(task, market, now + seconds * 1000).length, seconds >= 30 ? 1 : 0);
  }
  market.observedAt = new Date(now + 40000).toISOString();
  market.orderBook.bids[0].price = market.orderBook.asks[0].price = 99;
  observeSummaryPlans(task, market, now + 40000);
  assert.equal(record.lossObservation, null);
  assert.equal(summaryExitCandidates(task, market, now + 40000).length, 0);
});
test("hard stop bypasses flash and soft-stop wait; expiry preserves protection", () => {
  const { task, summary, record, now } = fixture();
  assert.equal(summaryReviewType(summary, 94, record, now), "HARD_STOP");
  assert.equal(summaryReviewType(summary, 104, record, now + 61000), "TAKE_PROFIT");
  assert.equal(summaryReviewType(summary, 100, record, now + 301000), "MAX_HOLD");
  assert.equal(summaryReviewType(summary, 101, null, now), null);
});
test("new AI plan preserves the original target and deadline without widening stops or erasing protected peak", () => {
  const { task, market, plan, record, now } = fixture();
  record.bestPrice = 103;
  record.profitArmed = true;
  const context = summaryExitReviewContexts(market, now)[0];
  const result = installSummaryPlan(task, context, { ...plan, takeProfitPrice: 108, stopLossPrice: 97, hardStopPrice: 94, maxHoldSec: 600 },
    { id: "new-ai", observedAt: market.observedAt, now });
  assert.equal(result.record.plan.takeProfitPrice, 104);
  assert.equal(result.record.plan.stopLossPrice, 98);
  assert.equal(result.record.plan.hardStopPrice, 95);
  assert.equal(result.record.maxHoldAt, record.maxHoldAt);
  assert.equal(result.record.bestPrice, 103);
  assert.equal(result.record.profitArmed, true);
  const earlier = installSummaryPlan(task, context, { ...plan, takeProfitPrice: 101, maxHoldSec: 1 },
    { id: "early-ai", observedAt: market.observedAt, now });
  assert.equal(earlier.record.plan.takeProfitPrice, 104);
  assert.equal(earlier.record.maxHoldAt, record.maxHoldAt);
});
for (const side of ["LONG", "SHORT"]) test(`${side} tighter targets or incompatible refresh fields cannot erase existing profit protection`, () => {
  const { task, market, plan, record, summary, now } = fixture(side);
  const direction = side === "LONG" ? 1 : -1;
  record.bestPrice = 100 + direction * 3;
  record.profitArmed = true;
  const context = summaryExitReviewContexts(market, now)[0];
  const result = installSummaryPlan(task, context, { ...plan, takeProfitPrice: 100 + direction,
    profitProtection: null }, { id: "earlier-target", observedAt: market.observedAt, now });
  assert.equal(result.record.profitProtectionEnabled, true);
  assert.equal(summaryReviewType(summary, 100 + direction * 0.9, result.record, now), "PROFIT_PROTECTION");
  const refreshed = installSummaryPlan(task, context, { ...plan,
    profitProtection: { activationPrice: 100 + direction * 4, floorPrice: 100 + direction * 3, trailingDistance: 0.2 } },
  { id: "conflicting-protection", observedAt: market.observedAt, now });
  assert.equal(refreshed.record.profitProtectionEnabled, true);
  assert.deepEqual(refreshed.record.plan.profitProtection, plan.profitProtection);
});
test("fees do not reject the core holding plan or create a net profit claim", () => {
  const { plan, summary, market, task, now } = fixture();
  assert.equal(validateHoldingPlan(plan, summary, { observedAt: market.observedAt, now, costs: { A: 5 } }).code, undefined);
  task.tradingCosts = {};
  market.orderBook.bids[0].price = market.orderBook.asks[0].price = 104;
  observeSummaryPlans(task, market, now);
  assert.equal(summaryExitCandidates(task, market, now)[0].decision.netPoints, undefined);
});
test("optional protection allows breakeven and a wider trailing distance without imposing a minimum profit", () => {
  const { summary, plan, market, now } = fixture();
  plan.profitProtection = { activationPrice: 100, floorPrice: 100, trailingDistance: 5 };
  assert.ok(profitProtectionFor(summary, plan));
  assert.equal(validateHoldingPlan(plan, summary, { observedAt: market.observedAt, now }).profitProtectionEnabled, true);
});
