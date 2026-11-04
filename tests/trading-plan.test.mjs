import assert from "node:assert/strict";
import test from "node:test";
import { costPointsFor, entryPlanAllowsPrice, executableEntryQuote, normalizeTradingPlan, parseTradingCosts, validateEntryPlan, validateHoldingPlan } from "../server/trading-plan.mjs";
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
  const task = { tradingCosts: { A: 0.2 }, entryQuantity: 3 };
  const context = summaryExitReviewContexts(market, now)[0];
  const installed = installSummaryPlan(task, context, plan, { id: "plan-ai", observedAt: market.observedAt, now });
  assert.ok(installed.record, installed.code);
  return { market, summary, plan, task, record: installed.record, now };
}

for (const side of ["LONG", "SHORT"]) test(`${side} AI entry requires an executable plan and actual profitable price`, () => {
  const { market, plan, task, now } = fixture(side);
  const decision = { action: side === "LONG" ? "BUY" : "SELL", entryPrice: 100, orderType: "MARKET", tradePlan: plan };
  assert.ok(validateEntryPlan(decision, market, task, now).guard);
  assert.equal(validateEntryPlan({ ...decision, tradePlan: null }, market, task, now).code, "AI_ENTRY_PLAN_REQUIRED");
  const outside = side === "LONG" ? 110 : 90;
  market.orderBook.bids[0].price = outside;
  market.orderBook.asks[0].price = outside;
  assert.equal(validateEntryPlan(decision, market, task, now).code, "ENTRY_PRICE_OUTSIDE_AI_PLAN");
});
for (const fault of ["missing-costs", "unknown-anchor", "provisional-anchor", "provisional-marker", "future-anchor", "wrong-setup", "loss-target", "invalid-hard-stop", "no-protection", "expired", "stale-book", "insufficient-depth"]) {
  test(`entry rejects ${fault} without inventing a fallback plan`, () => {
    const { market, plan, task, now } = fixture();
    if (fault === "missing-costs") task.tradingCosts = {};
    if (fault === "unknown-anchor") plan.anchorPrice = 99.6;
    if (fault === "provisional-anchor") market.history[0].confirmation = "PROVISIONAL";
    if (fault === "provisional-marker") market.history[0].confirmation = { status: "PROVISIONAL" };
    if (fault === "future-anchor") market.history[0].timestamp = plan.anchorTimestamp = new Date(now + 60000).toISOString();
    if (fault === "wrong-setup") plan.setup = "CHASE_BREAKOUT";
    if (fault === "loss-target") plan.takeProfitPrice = 99;
    if (fault === "invalid-hard-stop") plan.hardStopPrice = 99;
    if (fault === "no-protection") plan.profitProtection = {};
    if (fault === "expired") plan.validForSec = 0;
    if (fault === "stale-book") market.observedAt = new Date(now - 6000).toISOString();
    if (fault === "insufficient-depth") market.orderBook.asks[0].volume = 1;
    assert.ok(validateEntryPlan({ action: "BUY", entryPrice: 100, tradePlan: plan }, market, task, now).code);
  });
}
test("unknown and blank fees stay unknown; explicit zero remains valid", () => {
  for (const value of [null, "", " ", false, [], {}, -1, Infinity]) assert.equal(parseTradingCosts({ A: value }), null);
  assert.equal(costPointsFor({ symbol: "A" }, {}), null);
  assert.equal(costPointsFor({ symbol: "A" }, { A: 0 }), 0);
  assert.deepEqual(parseTradingCosts({ A: "0.2" }), { A: 0.2 });
});
test("entry price must preserve profitable protection after actual fill", () => {
  const { market, plan, task, now } = fixture();
  const { guard } = validateEntryPlan({ action: "BUY", entryPrice: 100, tradePlan: plan }, market, task, now);
  assert.equal(entryPlanAllowsPrice(guard, 100.5, now), true);
  assert.equal(entryPlanAllowsPrice({ ...guard, costPoints: 1 }, 100.5, now), false);
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
  assert.equal(protection.decision.netPoints, 2.2);
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
test("new AI plan cannot widen stops, move target away, extend hold, or erase protected peak", () => {
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
});
test("fees greater than target profit reject the plan; missing cost is never verified net profit", () => {
  const { plan, summary, market, task, now } = fixture();
  assert.equal(validateHoldingPlan(plan, summary, { observedAt: market.observedAt, now, costs: { A: 5 } }).code, "AI_PLAN_NET_PROFIT_INVALID");
  task.tradingCosts = {};
  market.orderBook.bids[0].price = market.orderBook.asks[0].price = 104;
  observeSummaryPlans(task, market, now);
  assert.equal(summaryExitCandidates(task, market, now)[0].decision.netPoints, null);
});
test("known whole-position fees cannot be ignored in favor of a smaller configured point cost", () => {
  const { summary, plan, market, now } = fixture();
  summary.roundTripFee = 15;
  assert.equal(costPointsFor(summary, { A: 0.2 }), 5);
  assert.equal(validateHoldingPlan(plan, summary, { observedAt: market.observedAt, now, costs: { A: 0.2 } }).code, "AI_PLAN_NET_PROFIT_INVALID");
  assert.equal(costPointsFor({ ...summary, roundTripFee: undefined, totalFees: 15 }, {}), 5);
  assert.equal(costPointsFor({ symbol: "A" }, { A: 0, a: 0.2 }), 0.2);
});
