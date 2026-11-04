import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { installSummaryPlan, summaryExitReviewContexts } from "../server/summary-exit-policy.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { dueExitReviewTargets, runPositionExitCycle, stopAllControllers, confirmPendingAction, stopTask, updateExitOutcomes } from "../server/engine.mjs";
import { state } from "../server/store.mjs";
import { entryGuard, tradingPlan } from "./fixtures/trading-plan.mjs";

beforeEach(t => t.mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(stopAllControllers);
const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (side = "LONG", extra = {}) => ({ symbol: "A", symbolName: "商品A", side, quantity: 3, frozenQuantity: 0, averagePrice: 100, ...extra });
function fixture(t, id, { side = "LONG", plan = true } = {}) {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const market = { ok: true, symbol: "A", symbolName: "商品A", observedAt: new Date(clock).toISOString(),
    account: { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: [row(side)], openOrdersVerified: true, openOrders: [] },
    orderBook: { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] } };
  const task = { id, ownerUserId: "summary-test", mode: "LIVE", status: "MONITORING", monitoringEnabled: true,
    stopLocked: false, monitorGeneration: 0, market, rules: [], workflow: [], metrics: {}, decision: { action: "HOLD" },
    tradingCosts: { A: 0.2 }, target: { browserSessionId: id, connectorId: "connector_haohan_readonly" } };
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
  test(`${side} ${automatic ? "automatic" : "manual"} entry exits exactly at AI target and deduplicates unsettled transfer`, async t => {
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
  assert.equal(f.reviews[0].costPoints, 0.2);
  assert.equal(f.task.summaryTradingPlans.length, 1);
  await f.tick(104, 2000);
  assert.equal(f.submitted.length, 1);
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
test("AI plan is not discarded when response also contains explicit EXIT price", async t => {
  const f = fixture(t, "ai-exit-now", { plan: false });
  f.runtime.requestSummaryExitDecision = async () => ({ ok: true, decision: "EXIT", exitPrice: 101,
    plan: tradingPlan(), rationale: "结构转弱，兑现当前可成交利润" });
  await f.tick(101);
  await f.tick(101, 2000);
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
test("repeated new flash events cannot postpone soft stop forever", async t => {
  const f = fixture(t, "flash-risk");
  for (let seconds = 0; seconds <= 30; seconds += 5) {
    f.market.flashK = { suspected: true, price: 98 - seconds / 100, observedAt: Date.now() };
    await f.tick(98 - seconds / 100, seconds ? 5000 : 0);
  }
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization.trigger, "STOP_LOSS");
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
test("profit peak and original max-hold deadline survive AI refresh and persistence", async t => {
  const f = fixture(t, "persist-plan");
  await f.tick(103);
  const deadline = f.task.summaryTradingPlans[0].maxHoldAt;
  await f.tick(103, 51000);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.task.summaryTradingPlans[0].maxHoldAt, deadline);
  const saved = compactTaskRuntime(f.task);
  assert.equal(saved.summaryTradingPlans[0].bestPrice, 103);
  assert.equal(saved.summaryTradingPlans[0].profitArmed, true);
  assert.deepEqual(saved.tradingCosts, { A: 0.2 });
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
for (const fault of ["missing", "expired", "outside", "valid"]) test(`manual ${fault} entry plan cannot leave invalid suggestion locked`, async t => {
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
  if (fault === "valid") {
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
