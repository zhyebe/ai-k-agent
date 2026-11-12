import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { installSummaryPlan, summaryExitReviewContexts, summarySignature } from "../server/summary-exit-policy.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { buildPendingAction, dueExitReviewTargets, runPositionExitCycle, stopAllControllers, confirmPendingAction, stopTask, updateExitOutcomes } from "../server/engine.mjs";
import { state } from "../server/store.mjs";
import { anchorCandle, entryGuard, tradingPlan } from "./fixtures/trading-plan.mjs";

beforeEach(t => t.mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(stopAllControllers);
const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (side = "LONG", extra = {}) => ({ symbol: "A", symbolName: "商品A", side, quantity: 3, frozenQuantity: 0, averagePrice: 100, ...extra });
const fixedCandle = plan => ({ ...anchorCandle(plan), confirmation: { status: "CONFIRMED", lastObservedAt: Date.now() } });
function fixture(t, id, { side = "LONG", plan = true } = {}) {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const market = { ok: true, symbol: "A", symbolName: "商品A", observedAt: new Date(clock).toISOString(),
    account: { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: [row(side)], openOrdersVerified: true, openOrders: [] },
    orderBook: { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] } };
  const task = { id, ownerUserId: "summary-test", mode: "LIVE", status: "MONITORING", monitoringEnabled: true,
    stopLocked: false, monitorGeneration: 0, market, rules: [], workflow: [], metrics: {}, decision: { action: "HOLD" },
    target: { browserSessionId: id, connectorId: "connector_haohan_readonly" } };
  state.tasks.unshift(task);
  t.after(() => { state.tasks = state.tasks.filter(item => item !== task); });
  if (plan) installSummaryPlan(task, summaryExitReviewContexts(market, clock)[0], tradingPlan(side),
    { id: "initial-ai-plan", observedAt: market.observedAt, now: clock });
  const submitted = [], reviews = [], cancellations = [];
  const runtime = {
    observeExecutionMarket: async () => ({ ...market, observedAt: new Date(clock).toISOString() }),
    submitSuggestionForm: async input => { submitted.push(input); return { ok: true, submitted: true, submittedQuantity: input.quantity, submittedPrice: input.price }; },
    requestSummaryExitDecision: async (_provider, context) => { reviews.push(context); return { ok: true, decision: "HOLD", plan: tradingPlan(side), rationale: "预测目标与明确风控" }; },
    cancelOpenOrders: async ({ orderIds }) => {
      cancellations.push(...orderIds);
      market.account.openOrders = [];
      return { ok: true, results: orderIds.map(orderId => ({ orderId, cancelled: true })) };
    },
  };
  const tick = async (price, elapsed = 0) => {
    clock += elapsed;
    market.observedAt = new Date(clock).toISOString();
    market.orderBook.bids[0].price = market.orderBook.asks[0].price = price;
    const result = await runPositionExitCycle(id, { runtime, now: clock });
    await flush();
    return result;
  };
  return { task, market, runtime, submitted, reviews, cancellations, tick };
}

for (const side of ["LONG", "SHORT"]) for (const automatic of [false, true]) {
  test(`${side} ${automatic ? "automatic" : "manual"} entry follows the AI target and deduplicates unsettled transfer`, async t => {
    const f = fixture(t, `target-${side}-${automatic}`, { side });
    f.task.autoDecisionEnabled = automatic;
    await f.tick(side === "LONG" ? 104 : 96);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0].quantity, 3);
    assert.equal(f.submitted[0].action, side === "LONG" ? "SELL" : "BUY");
    assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "TAKE_PROFIT");
    await f.tick(side === "LONG" ? 105 : 95, 2000);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.task.exitMonitor.status, "RECONCILING");
    f.market.account.positionSummaries = [];
    await f.tick(105, 2000);
    assert.equal(f.task.pendingAction.status, "CONFIRMED");
    assert.equal(f.task.exitOutcomes.length, 1);
    assert.equal(f.task.exitOutcomes[0].fillPrice, null);
  });
}
test("holdings missing a plan immediately request structured AI with original forecast, even before any loss", async t => {
  const f = fixture(t, "missing-plan", { plan: false });
  f.task.entryForecast = { forecastHorizon: { nextK: { path: "先回支撑再上行" } } };
  await f.tick(100);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0].entryForecast.forecastHorizon.nextK.path, "先回支撑再上行");
  assert.equal(Object.hasOwn(f.reviews[0], "costPoints"), false);
  assert.equal(f.task.summaryTradingPlans.length, 1);
  await f.tick(104, 2000);
  assert.equal(f.submitted.length, 1);
});
test("entry at 16-19 keeps the original 21 target across one K and AI refresh", async t => {
  const f = fixture(t, "hold-original-21", { plan: false });
  f.market.account.positionSummaries[0].averagePrice = 17;
  const plan = tradingPlan("LONG", 17, { entryZone: { min: 16, max: 19 }, takeProfitPrice: 21,
    maxHoldSec: 600, profitProtection: null });
  f.task.entryForecast = { pendingId: "entry-17", symbol: "A", action: "BUY", tradePlan: plan,
    observedAt: new Date(Date.now()).toISOString(), confirmedAt: new Date(Date.now()).toISOString() };
  f.runtime.requestSummaryExitDecision = async () => ({ ok: true, decision: "EXIT", exitPrice: 18,
    plan: { ...plan, takeProfitPrice: 18, maxHoldSec: 1 }, rationale: "已有一根K浮盈" });
  await f.tick(18);
  const deadline = f.task.summaryTradingPlans[0].maxHoldAt;
  await f.tick(19, 56000);
  assert.equal(f.task.summaryExitReviews[0].decision, "HOLD");
  assert.equal(f.task.summaryTradingPlans[0].plan.takeProfitPrice, 21);
  assert.equal(f.task.summaryTradingPlans[0].maxHoldAt, deadline);
  await f.tick(20, 2000);
  assert.equal(f.submitted.length, 0);
  await f.tick(21, 2000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "TAKE_PROFIT");
});
for (const side of ["LONG", "SHORT"]) for (const evidence of ["none", "old", "provisional", "confirmed"]) {
  test(`${side} early AI EXIT requires new confirmed invalidation evidence: ${evidence}`, async t => {
    const f = fixture(t, `early-exit-${side}-${evidence}`, { side });
    const start = Date.now(), direction = side === "LONG" ? 1 : -1;
    const timestamp = Math.floor(start / 60000) * 60000 - (evidence === "old" ? 60000 : 0);
    f.market.timeframe = "1m";
    f.market.history = evidence === "none" ? [] : [{ timestamp, open: 100, high: 102, low: 98, close: 100 + direction,
      volume: 10, partial: false, confirmation: { status: evidence === "provisional" ? "PROVISIONAL" : "CONFIRMED" } }];
    f.runtime.requestSummaryExitDecision = async () => ({ ok: true, decision: "EXIT", exitPrice: 100 + direction,
      plan: tradingPlan(side), forecastInvalidated: true, invalidationCandleTimestamp: timestamp,
      rationale: "新定K出现与原预测相反的结构失效" });
    await f.tick(100 + direction, 56000);
    await f.tick(100 + direction, 2000);
    assert.equal(f.submitted.length, evidence === "confirmed" ? 1 : 0);
    if (evidence === "confirmed") assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "AI_EXIT_NOW");
    else if (evidence === "provisional") assert.equal(f.task.exitMonitor.status, "AWAITING_CONFIRMED_PRICE");
    else assert.equal(f.task.summaryExitReviews[0].decision, "HOLD");
  });
}
test("a fill outside the advisory zone binds the original target and starts holding time at the real fill", async t => {
  const f = fixture(t, "fill-outside-advisory", { plan: false });
  const now = Date.now();
  f.market.account.positionSummaries[0].averagePrice = 101;
  f.task.entryForecast = { pendingId: "filled-later", symbol: "A", action: "BUY", tradePlan: tradingPlan(),
    observedAt: new Date(now - 120000).toISOString(), confirmedAt: new Date(now).toISOString() };
  await f.tick(101);
  assert.equal(f.task.summaryTradingPlans[0].plan.takeProfitPrice, 104);
  assert.equal(f.task.summaryTradingPlans[0].maxHoldAt, new Date(now + 300000).toISOString());
  assert.equal(f.submitted.length, 0);
});
test("a late observed fill keeps the original AI hard stop when entry validity elapsed and model is offline", async t => {
  const f = fixture(t, "late-fill-risk", { plan: false });
  f.task.entryForecast = { pendingId: "old-entry", action: "BUY", symbol: "A",
    observedAt: new Date(Date.now() - 120000).toISOString(), confirmedAt: new Date(Date.now()).toISOString(),
    tradePlan: tradingPlan() };
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(94);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
  assert.ok(Date.parse(f.task.summaryTradingPlans[0].expiresAt) < Date.now());
});
test("expired manual suggestion reconciles an already filled entry before retiring its suggestion", async t => {
  const f = fixture(t, "late-manual-fill", { plan: false });
  f.task.autoDecisionEnabled = false;
  f.market.account.positionSummaries[0].quantity = 1;
  f.market.account.positions = [{ symbol: "A", side: "买入", positionOrderId: "P-entry", quantity: 1, orderPrice: 100 }];
  const observedAt = new Date(Date.now() - 120000).toISOString(), plan = tradingPlan();
  f.task.pendingAction = { id: "manual-filled", action: "BUY", status: "WAITING", entryPurpose: "NORMAL",
    targetSymbol: "A", baselinePositionQty: 0, baselinePositions: {}, suggestedQty: 1, suggestedPrice: 100,
    tradePlan: plan, forecastObservedAt: observedAt, bullishProfitProbability: 0.6, bearishProfitProbability: 0.4,
    entryGuard: { ...entryGuard("BUY", 100, "A"), expiresAt: new Date(Date.now() - 60000).toISOString() } };
  f.task.entryForecast = { symbol: "A", action: "BUY", tradePlan: plan, observedAt, confirmedAt: null };
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(94);
  assert.ok(f.task.entryForecast.confirmedAt);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
});
for (const side of ["LONG", "SHORT"]) test(`${side} verified summary fill activates the entry stop before detail rows load`, async t => {
  const f = fixture(t, `summary-fill-stop-${side}`, { side, plan: false });
  const average = 1327, direction = side === "LONG" ? 1 : -1;
  const plan = tradingPlan(side, average, { takeProfitPrice: average + direction * 2,
    stopLossPrice: average - direction, hardStopPrice: average - direction * 2 });
  const held = row(side, { averagePrice: average, quantity: 1 });
  f.market.account.positionSummaries = [];
  const pending = buildPendingAction(f.task, { action: side === "LONG" ? "BUY" : "SELL", targetSymbol: "A",
    tradePlan: plan, entryPrice: average, entryGuard: entryGuard(side === "LONG" ? "BUY" : "SELL", average, "A") });
  f.task.pendingAction = { ...pending, source: "auto_takeover", status: "AWAITING_FILL" };
  f.task.entryForecast = { pendingId: pending.id, action: pending.action, symbol: "A",
    tradePlan: plan, observedAt: pending.forecastObservedAt, confirmedAt: null };
  f.market.account.positionSummaries = [held];
  f.market.account.positionsVerified = false;
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(average - direction * 2, 2000);
  assert.ok(f.task.entryForecast.confirmedAt);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
  assert.equal(f.task.unsettledActions[0].status, "AWAITING_FILL");
});
for (const field of ["rationale", "validForSec", "maxHoldSec", "stopConfirmationSec"]) {
  test(`entry hard stop remains active without ${field} while model is offline`, async t => {
    const f = fixture(t, `partial-stop-${field}`, { plan: false });
    const plan = tradingPlan("LONG", 100, { [field]: null });
    f.task.entryForecast = { pendingId: `entry-${field}`, action: "BUY", symbol: "A",
      tradePlan: plan, observedAt: f.market.observedAt, confirmedAt: f.market.observedAt };
    f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
    await f.tick(95);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
  });
}
test("missing AI confirmation time never invents an immediate ordinary stop", async t => {
  const f = fixture(t, "partial-stop-confirmation", { plan: false });
  f.task.entryForecast = { pendingId: "entry-no-confirmation", action: "BUY", symbol: "A",
    tradePlan: tradingPlan("LONG", 100, { stopConfirmationSec: null, maxHoldSec: null }),
    observedAt: f.market.observedAt, confirmedAt: f.market.observedAt };
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(98);
  await f.tick(98, 5000);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.summaryTradingPlans[0].maxHoldAt, null);
  await f.tick(95, 2000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
});
for (const fault of ["unchanged", "wrong-side", "wrong-instrument", "stale-account"]) {
  test(`${fault} summary cannot falsely bind an entry stop`, async t => {
    const f = fixture(t, `summary-bind-${fault}`, { plan: false });
    const pending = buildPendingAction(f.task, { action: "BUY", targetSymbol: "A",
      tradePlan: tradingPlan(), entryPrice: 100, entryGuard: entryGuard("BUY", 100, "A") });
    f.task.pendingAction = { ...pending, source: "auto_takeover", status: "AWAITING_FILL" };
    f.task.entryForecast = { pendingId: pending.id, action: "BUY", symbol: "A",
      tradePlan: pending.tradePlan, observedAt: pending.forecastObservedAt, confirmedAt: null };
    f.market.account.positionsVerified = false;
    if (fault !== "unchanged") f.market.account.positionSummaries[0].quantity += 1;
    if (fault === "wrong-side") f.market.account.positionSummaries[0].side = "SHORT";
    if (fault === "wrong-instrument") f.market.account.positionSummaries[0].symbol = "B";
    if (fault === "stale-account") f.market.accountObservedAt = new Date(Date.now() - 6000).toISOString();
    f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
    await f.tick(95, 2000);
    assert.equal(f.task.entryForecast.confirmedAt, null);
    assert.equal(f.submitted.length, 0);
  });
}
test("slippage beyond the original entry hard stop activates protection instead of rejecting the prices", async t => {
  const f = fixture(t, "slipped-hard-stop", { plan: false });
  f.market.account.positionSummaries[0].averagePrice = 94;
  f.task.entryForecast = { pendingId: "entry-slipped", action: "BUY", symbol: "A", tradePlan: tradingPlan(),
    observedAt: f.market.observedAt, confirmedAt: f.market.observedAt };
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(94);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
});
test("AI plan is not discarded when response also contains explicit EXIT price", async t => {
  const f = fixture(t, "ai-exit-now", { plan: false });
  f.runtime.requestSummaryExitDecision = async () => ({ ok: true, decision: "EXIT", exitPrice: 100,
    plan: tradingPlan(), rationale: "结构转弱，兑现当前可成交利润" });
  await f.tick(100);
  await f.tick(100, 2000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "AI_EXIT_NOW");
});
for (const fault of ["missing-plan", "missing-hard-stop", "missing-exit-price"]) test(`invalid AI ${fault} cannot fabricate authorization`, async t => {
  const f = fixture(t, `bad-${fault}`, { plan: false });
  f.runtime.requestSummaryExitDecision = async () => ({ ok: true, decision: "EXIT", exitPrice: fault === "missing-exit-price" ? null : 100,
    plan: fault === "missing-plan" ? null : tradingPlan("LONG", 100, fault === "missing-hard-stop" ? { hardStopPrice: null } : {}), rationale: "缺少必要风险字段" });
  await f.tick(100);
  assert.equal(f.task.summaryExitReviews[0].status, "FAILED");
  assert.equal(f.submitted.length, 0);
});
test("flash prices wait for a real fixed K before starting ordinary stop confirmation", async t => {
  const f = fixture(t, "flash-risk");
  for (let seconds = 0; seconds <= 30; seconds += 5) {
    f.market.flashK = { suspected: true, price: 98 - seconds / 100, observedAt: Date.now() };
    await f.tick(98 - seconds / 100, seconds ? 5000 : 0);
  }
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.exitMonitor.status, "AWAITING_CONFIRMED_PRICE");
  f.market.flashK = { suspected: false, confirmed: true };
  f.market.timeframe = "1m";
  f.market.history = [fixedCandle(tradingPlan())];
  for (let seconds = 0; seconds <= 30; seconds += 5) await f.tick(98, seconds ? 5000 : 2000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "STOP_LOSS");
});
for (const side of ["LONG", "SHORT"]) for (const trigger of ["TAKE_PROFIT", "HARD_STOP", "MAX_HOLD"]) {
  test(`${side} ${trigger} waits across flash expiry and restart, then reevaluates the fixed price`, async t => {
    const f = fixture(t, `fixed-exit-${side}-${trigger}`, { side });
    f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
    const direction = side === "LONG" ? 1 : -1;
    const price = 100 + direction * (trigger === "TAKE_PROFIT" ? 4 : trigger === "HARD_STOP" ? -5 : 0);
    f.market.flashK = { suspected: true, confirmed: false };
    await f.tick(price, trigger === "MAX_HOLD" ? 301000 : 0);
    assert.equal(f.submitted.length, 0);
    f.task.summaryExitPriceWaits = compactTaskRuntime(f.task).summaryExitPriceWaits;
    f.market.flashK = { suspected: false };
    await f.tick(price, 31000);
    assert.equal(f.submitted.length, 0);
    f.market.timeframe = "1m";
    f.market.history = [{ ...fixedCandle(tradingPlan(side)), confirmation: { status: "CONFIRMED", lastObservedAt: Date.now() - 60000 } }];
    await f.tick(price, 2000);
    assert.equal(f.submitted.length, 0);
    f.market.history = [fixedCandle(tradingPlan(side))];
    f.market.flashK = { suspected: false, confirmed: true };
    await f.tick(price, 2000);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, trigger);
    assert.equal(f.task.summaryExitPriceWaits.length, 0);
  });
}
test("flash profit cannot arm protection or cause an exit after the fixed price recovers below target", async t => {
  const f = fixture(t, "flash-profit-recovery");
  f.market.flashK = { suspected: true, confirmed: false };
  await f.tick(106);
  assert.equal(f.task.summaryTradingPlans[0].bestPrice, 100);
  assert.equal(f.task.summaryTradingPlans[0].profitArmed, false);
  f.market.flashK = { suspected: false, confirmed: true };
  f.market.timeframe = "1m";
  f.market.history = [fixedCandle(tradingPlan())];
  await f.tick(101, 2000);
  assert.equal(f.submitted.length, 0);
});
test("a new flash in the exit dialog persists waiting and never retries blindly without a fixed K", async t => {
  const f = fixture(t, "flash-dialog-wait");
  f.runtime.submitSuggestionForm = async input => {
    f.submitted.push(input);
    return { ok: false, code: "EXIT_AWAITING_CONFIRMED_PRICE", submitted: false, uncertain: false };
  };
  await f.tick(104);
  assert.equal(f.task.pendingAction.status, "CANCELLED");
  assert.equal(f.task.summaryExitPriceWaits.length, 1);
  await f.tick(104, 31000);
  assert.equal(f.submitted.length, 1);
  f.market.timeframe = "1m";
  f.market.history = [fixedCandle(tradingPlan())];
  f.runtime.submitSuggestionForm = async input => { f.submitted.push(input); return { ok: true, submitted: true }; };
  await f.tick(104, 2000);
  assert.equal(f.submitted.length, 2);
});
test("brief pullback recovery avoids soft exit; hard invalidation exits immediately without model", async t => {
  const f = fixture(t, "brief-rebound");
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(98);
  await f.tick(97.8, 5000);
  await f.tick(99, 5000);
  assert.equal(f.submitted.length, 0);
  await f.tick(94, 5000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HARD_STOP");
});
test("AI target, protected peak and original deadline survive refresh and persistence", async t => {
  const f = fixture(t, "persist-plan");
  await f.tick(103);
  const deadline = f.task.summaryTradingPlans[0].maxHoldAt;
  await f.tick(103, 51000);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.task.summaryTradingPlans[0].maxHoldAt, deadline);
  const saved = compactTaskRuntime(f.task);
  assert.equal(saved.summaryTradingPlans[0].bestPrice, 103);
  assert.equal(saved.summaryTradingPlans[0].profitArmed, true);
  assert.equal(Object.hasOwn(saved, "tradingCosts"), false);
  assert.equal(saved.summaryExitBatch, null);
  await f.tick(102.4, 2000);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "PROFIT_PROTECTION");
});
for (const change of ["stop", "average", "quantity"]) test(`late AI result cannot bind after ${change}`, async t => {
  const f = fixture(t, `late-${change}`, { plan: false });
  let release;
  f.runtime.requestSummaryExitDecision = () => new Promise(resolve => { release = resolve; });
  await f.tick(100);
  const first = release;
  if (change === "stop") stopTask(f.task.id);
  else {
    f.market.account.positionSummaries[0][change === "average" ? "averagePrice" : "quantity"] = change === "average" ? 101 : 2;
    await f.tick(100, 2000);
  }
  first({ ok: true, decision: "EXIT", exitPrice: 100, plan: tradingPlan(), rationale: "旧持仓" });
  await flush();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.summaryTradingPlans?.length || 0, 0);
});
test("timeout exit recovers only after grace and two fresh verified unchanged holdings without orders", async t => {
  const f = fixture(t, "timeout-recovery");
  f.runtime.submitSuggestionForm = async input => { f.submitted.push(input); throw Error("DESKTOP_CALL_TIMEOUT"); };
  await f.tick(104);
  assert.equal(f.task.pendingAction.status, "UNVERIFIED");
  await f.tick(105, 121000);
  assert.equal(f.submitted.length, 1);
  f.runtime.submitSuggestionForm = async input => { f.submitted.push(input); return { ok: true, submitted: true }; };
  await f.tick(106, 2000);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.task.unsettledActions.length, 0);
});
for (const obstruction of ["unverified", "frozen", "order", "changed-average"]) test(`${obstruction} prevents blind timeout retry`, async t => {
  const f = fixture(t, `blocked-recovery-${obstruction}`);
  f.runtime.submitSuggestionForm = async input => { f.submitted.push(input); throw Error("TIMEOUT"); };
  await f.tick(104);
  if (obstruction === "unverified") f.market.account.openOrdersVerified = false;
  if (obstruction === "frozen") f.market.account.positionSummaries[0].frozenQuantity = 1;
  if (obstruction === "changed-average") f.market.account.positionSummaries[0].averagePrice = 101;
  if (obstruction === "order") f.market.account.openOrders = [{ symbol: "A", orderId: "other", remainingQuantity: 3, orderTime: new Date(Date.now() + 120000).toISOString() }];
  await f.tick(105, 121000);
  await f.tick(106, 2000);
  assert.equal(f.submitted.length, 1);
});
test("actual refreshed transfer price attributes order, cancels remainder and exits remaining holdings", async t => {
  const f = fixture(t, "actual-price");
  f.runtime.submitSuggestionForm = async input => {
    f.submitted.push(input);
    return { ok: true, submitted: true, submittedPrice: 104.5, submittedQuantity: 3 };
  };
  await f.tick(104);
  const originalOrder = state.orders.find(order => order.idempotencyKey === `pending:${f.task.pendingAction.id}`);
  assert.equal(originalOrder.submittedPrice, 104.5);
  f.market.account.openOrders = [{ orderId: "O-fresh", symbol: "A", side: "卖出", orderKind: "转让",
    quantity: 3, remainingQuantity: 2, orderPrice: 104.5, orderTime: new Date(Date.now()).toISOString() }];
  f.market.account.positionSummaries[0].quantity = 2;
  await f.tick(105, 2000);
  assert.deepEqual(f.task.pendingAction.entrustedOrderIds, ["O-fresh"]);
  await f.tick(106, 120000);
  assert.deepEqual(f.cancellations, ["O-fresh"]);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.submitted[1].quantity, 2);
});
test("old fixed-profit pending authorization cannot execute after upgrade", async t => {
  const f = fixture(t, "old-program");
  f.task.pendingAction = { status: "WAITING", action: "SELL", exitType: "TAKE_PROFIT", targetSummary: row(), suggestedPrice: 104,
    exitGuard: { summary: true, programProfit: true } };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /SUMMARY_EXIT_AUTHORIZATION_REQUIRED/);
  assert.equal(f.submitted.length, 0);
});
test("a user-rule exit cannot borrow an AI plan ID to authorize a missing cohort", async t => {
  const f = fixture(t, "missing-user-cohort");
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  f.task.pendingAction = { status: "WAITING", action: "SELL", exitType: "TAKE_PROFIT", targetSummary: row(), suggestedPrice: 104,
    exitGuard: { summary: true, expiresAt, aiAuthorization: { id: "initial-ai-plan", decision: "EXIT", source: "USER_RULE",
      trigger: "TOTAL_PROFIT", batchId: "missing", signature: summarySignature(row()), expiresAt } } };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /SUMMARY_EXIT_AUTHORIZATION_REQUIRED/);
  assert.equal(f.submitted.length, 0);
});
test("post-exit review records only real 3/5 minute quotes and never labels a limit price as filled", () => {
  const start = Date.now(), summary = row();
  const task = { exitOutcomes: [{ pendingId: "p", summary, confirmedAt: new Date(start).toISOString(), submittedLimitPrice: 98, fillPrice: null }] };
  const market = { symbol: "A", observedAt: new Date(start + 180000).toISOString(),
    orderBook: { bids: [{ price: 103, volume: 100 }], asks: [{ price: 103, volume: 100 }] } };
  assert.deepEqual(dueExitReviewTargets(task, start + 179999), []);
  assert.deepEqual(dueExitReviewTargets(task, start + 180000), [summary]);
  updateExitOutcomes(task, market, start + 180000);
  assert.deepEqual(dueExitReviewTargets(task, start + 180001), []);
  assert.equal(task.exitOutcomes[0].after3Minutes.hypotheticalGrossPoints, 3);
  assert.deepEqual(dueExitReviewTargets(task, start + 300000), [summary]);
  assert.deepEqual(dueExitReviewTargets(task, start + 311000), []);
  updateExitOutcomes(task, market, start + 311000);
  assert.equal(task.exitOutcomes[0].after5Minutes.status, "MISSING");
  assert.equal(task.exitOutcomes[0].fillPrice, null);
});
test("fast cycle asks for due post-exit instruments without claiming an unobserved quote", async t => {
  const f = fixture(t, "due-review", { plan: false });
  f.market.account.positionSummaries = [];
  const summary = row("LONG", { symbol: "B", symbolName: "商品B" });
  f.task.exitOutcomes = [{ summary, confirmedAt: new Date(Date.now() - 180000).toISOString() }];
  let targets;
  f.runtime.observeExecutionMarket = async task => {
    targets = task.exitReviewTargets;
    return { ...f.market, observedAt: new Date(Date.now()).toISOString() };
  };
  await f.tick(100);
  assert.deepEqual(targets, [summary]);
  assert.equal(f.task.exitOutcomes[0].after3Minutes, undefined);
});
for (const fault of ["missing", "expired", "outside", "valid"]) test(`manual ${fault} preserves an approved AI entry without expiry or reference-zone checks`, async t => {
  const f = fixture(t, `manual-plan-${fault}`, { plan: false });
  f.market.account.positionSummaries = [];
  f.task.autoDecisionEnabled = false;
  const guard = entryGuard("BUY", 100, "A");
  if (fault === "expired") guard.expiresAt = new Date(Date.now() - 1).toISOString();
  f.task.pendingAction = { id: "manual-suggestion", status: "WAITING", action: "BUY", targetSymbol: "A",
    entryPurpose: "NORMAL", bullishProfitProbability: 0.6, bearishProfitProbability: 0.4,
    suggestedQty: 1, suggestedPrice: fault === "outside" ? 105 : 100, entryGuard: fault === "missing" ? null : guard };
  const result = await f.tick(100);
  assert.equal(f.submitted.length, 0);
  if (fault !== "missing") {
    assert.equal(result.reason, "MANUAL_ENTRY_WAITING");
    assert.equal(f.task.pendingAction.status, "WAITING");
  } else {
    assert.notEqual(result.reason, "MANUAL_ENTRY_WAITING");
    assert.equal(f.task.pendingAction.status, "CANCELLED");
    assert.match(f.task.pendingAction.message, /已取消/);
  }
});
test("summary parser rejects duplicate and loading rows without inventing fees", () => {
  const rows = [["商品名称", "买 | 卖", "订立均价", "存货数量", "委托冻结数量", "实时货值变化"], ["商品A", "买入", "1,000.25", "3", "0", "--"]];
  const table = { kind: "positionSummaries", rows };
  const account = parseHaohanAccount("", [table]);
  assert.equal(account.positionSummariesVerified, true);
  assert.equal(account.positionSummaries[0].averagePrice, 1000.25);
  assert.equal(account.positionSummaries[0].roundTripCostPoints, undefined);
  assert.equal(parseHaohanAccount("", [{ ...table, loading: true }]).positionSummariesVerified, false);
  assert.equal(parseHaohanAccount("", [{ ...table, rows: [...rows, rows[1]] }]).positionSummariesVerified, false);
});

test("a failed leg does not block all other holdings and only that leg retries", async t => {
  const f = fixture(t, "portfolio-failure", { plan: false });
  f.market.account.positionSummaries = [row("LONG", { quantity: 1 }), row("SHORT", { symbol: "B", symbolName: "商品B", quantity: 1, averagePrice: 96 })];
  f.market.books = [{ symbol: "B", symbolName: "商品B", observedAt: new Date(Date.now()).toISOString(),
    orderBook: { bids: [{ price: 98, volume: 100 }], asks: [{ price: 98, volume: 100 }] } }];
  f.runtime.observeExecutionMarket = async () => ({ ...f.market, observedAt: new Date(Date.now()).toISOString(),
    books: [{ ...f.market, books: undefined }, { ...f.market.books[0], observedAt: new Date(Date.now()).toISOString() }] });
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  f.runtime.submitSuggestionForm = async input => {
    f.submitted.push(input);
    return input.symbol === "A" ? { ok: false, submitted: false, code: "FIXTURE_CONFIRM_FAILED" } : { ok: true, submitted: true };
  };
  await f.tick(103);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.task.exitMonitor.failures.length, 1);
  await f.tick(102, 2000);
  assert.equal(f.submitted.length, 3);
  assert.equal(f.submitted[2].symbol, "A");
  assert.equal(f.submitted[2].exitGuard.aiAuthorization.trigger, "TOTAL_PROFIT");
});

for (const gap of [2000, 6000]) test(`rotating quote collection combines all holdings only within freshness, gap ${gap}`, async t => {
  const f = fixture(t, `portfolio-quote-${gap}`, { plan: false });
  f.market.account.positionSummaries = [row("LONG", { quantity: 1 }), row("SHORT", { symbol: "B", symbolName: "商品B", quantity: 1, averagePrice: 96 })];
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(103);
  assert.equal(f.submitted.length, 0);
  f.runtime.observeExecutionMarket = async () => ({ ok: true, symbol: "B", symbolName: "商品B", account: f.market.account,
    observedAt: new Date(Date.now()).toISOString(),
    orderBook: { bids: [{ price: 98, volume: 100 }], asks: [{ price: 98, volume: 100 }] } });
  await f.tick(103, gap);
  assert.equal(f.submitted.length, gap <= 5000 ? 2 : 0);
});

test("hedge cleanup confirms the losing side before observing winners and exits growing profit within a minute", async t => {
  const f = fixture(t, "hedge-minute", { plan: false });
  f.market.account.positionSummaries = [row("LONG", { quantity: 1 }), row("SHORT", { quantity: 2 })];
  f.runtime.requestSummaryExitDecision = async () => { throw Error("MODEL_OFFLINE"); };
  await f.tick(103);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].action, "BUY");
  assert.equal(f.submitted[0].quantity, 2);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "HEDGE_LOSS");
  f.market.account.positionSummaries.pop();
  await f.tick(103, 2000);
  assert.equal(f.task.pendingAction.status, "CONFIRMED");
  assert.equal(f.task.summaryExitBatch.phase, "WATCH_WINNERS");
  const deadline = f.task.summaryExitBatch.winnerDeadlineAt;
  await f.tick(104, 30000);
  assert.equal(f.submitted.length, 1);
  await f.tick(105, 30000);
  assert.equal(f.task.summaryExitBatch.winnerDeadlineAt, deadline);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.submitted[1].action, "SELL");
  assert.equal(f.submitted[1].quantity, 1);
  assert.equal(f.submitted[1].exitGuard.aiAuthorization.trigger, "HEDGE_WINNER_DEADLINE");
});
