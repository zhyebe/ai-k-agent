import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { algorithmEntryDecision, recheckAlgorithmEntry } from "../server/algorithm-strategy.mjs";
import { probeAlgorithmCandles, replayAlgorithm } from "../scripts/replay-algorithm.mjs";
import { confirmPendingAction, runAnalysis, runPositionExitCycle, stopController } from "../server/engine.mjs";
import { publicTask, state } from "../server/store.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { installSummaryPlan, observeSummaryPlans, summaryExitAllowsPrice, summaryExitCandidates, summaryExitReviewContexts } from "../server/summary-exit-policy.mjs";
import { tradingPlan } from "./fixtures/trading-plan.mjs";

function bookAt(now, price, direction = 1, { flash = false, cost, candles = 97 } = {}) {
  const history = Array.from({ length: candles }, (_, index) => {
    const minutesAgo = candles - 1 - index;
    const close = 100 - 0.44 * direction * minutesAgo;
    return { timestamp: now - minutesAgo * 60_000,
      open: close - 0.25 * direction, high: close + 0.6, low: close - 0.7, close };
  });
  const candle = history.at(-1);
  candle.confirmation = { status: "PROVISIONAL", observed: true, lastObservedAt: now };
  if (flash) Object.assign(candle, { high: Math.max(candle.open, candle.close), low: Math.min(candle.open, candle.close) });
  return { ok: true, symbol: "ALGO", timeframe: "1m", observedAt: new Date(now).toISOString(), history, historyCount: history.length,
    executionCostPoints: cost,
    orderBook: { bids: [{ price: price - 0.1, volume: 10 }], asks: [{ price: price + 0.1, volume: 10 }] } };
}

test("algorithm buys a recent relative low in an uptrend and shorts a relative high in a downtrend", () => {
  const now = Date.now();
  for (const direction of [1, -1]) {
    const price = 100 - direction;
    const decision = algorithmEntryDecision(bookAt(now, price, direction), { now });
    assert.equal(decision.action, direction === 1 ? "BUY" : "SELL");
    assert.equal(decision.algorithmForecast.expectedEntryBars, 0);
    assert.ok(decision.algorithmForecast.matchedPaths > 0);
    assert.ok(decision.algorithmForecast.expectedExitBars >= 1);
    assert.ok((decision.tradePlan.takeProfitPrice - decision.entryPrice) * direction > 0);
    assert.ok((decision.entryPrice - decision.tradePlan.stopLossPrice) * direction > 0);
    assert.ok((decision.tradePlan.stopLossPrice - decision.tradePlan.hardStopPrice) * direction > 0);
    const chased = algorithmEntryDecision(bookAt(now, 100 + direction, direction), { now });
    assert.equal(chased.action, "HOLD");
    assert.equal(chased.riskFlags[0], "ALGORITHM_WAITING_ENTRY_ZONE");
  }
});

test("future candles and a wickless intrabar spike are not used for an entry", () => {
  const now = Date.now(), market = bookAt(now, 99);
  const baseline = algorithmEntryDecision(market, { now });
  const future = { ...market, history: [...market.history,
    { timestamp: now + 60000, open: 200, high: 205, low: 198, close: 201 }] };
  assert.deepEqual(algorithmEntryDecision(future, { executionBook: market, now }), baseline);
  assert.equal(algorithmEntryDecision(bookAt(now, 99, 1, { flash: true }), { now }).riskFlags[0], "ENTRY_AWAITING_CONFIRMED_PRICE");
  const replayed = bookAt(now, 99);
  replayed.history.at(-1).confirmation.observed = false;
  assert.equal(algorithmEntryDecision(replayed, { now }).riskFlags[0], "ENTRY_AWAITING_CONFIRMED_PRICE");
  const oneWick = bookAt(now, 99);
  const candle = oneWick.history.at(-1);
  candle.high = Math.max(candle.open, candle.close);
  assert.equal(algorithmEntryDecision(oneWick, { now }).action, "BUY");
});

test("the final quote must remain in the planned zone and cover the order quantity", () => {
  const now = Date.now(), market = bookAt(now, 99);
  const entryGuard = { symbol: market.symbol, plan: algorithmEntryDecision(market, { now }).tradePlan,
    expiresAt: new Date(now + 20_000).toISOString() };
  const options = { now, action: "BUY", quantity: 1, entryGuard };
  assert.equal(recheckAlgorithmEntry(market, options).ok, true);
  assert.equal(recheckAlgorithmEntry(bookAt(now, 101), options).code, "ALGORITHM_ENTRY_PRICE_MOVED");
  assert.equal(recheckAlgorithmEntry(market, { ...options, quantity: 11 }).code, "ENTRY_QUOTE_OR_DEPTH_UNVERIFIED");
  assert.equal(recheckAlgorithmEntry(market, { ...options, now: now + 20_000 }).code, "ALGORITHM_ENTRY_EXPIRED");
});

function engineFixture(t, id, mode) {
  const task = { id, mode, status: "MONITORING", ownerUserId: "algorithm-test", decisionSource: "ALGORITHM",
    stopLocked: false, monitoringEnabled: true, autoDecisionEnabled: true, entryQuantity: 1,
    target: { browserSessionId: id, connectorId: "connector_haohan_readonly" }, workflow: [], rules: [], metrics: {}, decision: { action: "HOLD" } };
  const account = { positions: [], positionsVerified: true, positionSummaries: [],
    positionSummariesVerified: true, openOrders: [], openOrdersVerified: true };
  const market = (now, price, options) => ({ ...bookAt(now, price, 1, options),
    account, evidenceId: `evidence:${id}`, fingerprint: `market:${id}`, dataQuality: "VERIFIED" });
  const calls = { model: 0, submitted: [], filled: 0 };
  const forbiddenModel = () => { calls.model += 1; throw new Error("unexpected provider request"); };
  const runtime = { openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ authenticated: true }),
    observeMarket: async () => market(Date.now(), 99), requestMarketAnalysis: forbiddenModel, requestDecision: forbiddenModel,
    requestSummaryExitDecision: forbiddenModel, fillSuggestionForm: async () => { calls.filled += 1; },
    submitSuggestionForm: async input => { calls.submitted.push(input); return { ok: true, submitted: true, submittedPrice: input.price }; } };
  state.tasks.unshift(task);
  t.after(() => { stopController(id); state.tasks = state.tasks.filter(item => item !== task); });
  return { task, account, market, calls, runtime };
}

test("shadow algorithm runs with desktop AI required and no provider, produces a read-only suggestion", async t => {
  const fixture = engineFixture(t, "algo-shadow", "SHADOW");
  fixture.task.autoDecisionEnabled = false;
  fixture.task.entryQuantity = 3;
  const prior = process.env.AXIOM_REQUIRE_DESKTOP_AI;
  process.env.AXIOM_REQUIRE_DESKTOP_AI = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_AI;
    else process.env.AXIOM_REQUIRE_DESKTOP_AI = prior;
  });
  const { requestDecision, ...runtime } = fixture.runtime;
  const result = await runAnalysis(fixture.task.id, "", { runtime });
  assert.equal(result.task.decision.action, "BUY");
  assert.equal(result.task.decision.decisionSource, "ALGORITHM");
  assert.equal(result.task.pendingAction.formFilled, false);
  assert.equal(result.task.pendingAction.suggestedQty, 3);
  assert.equal(result.task.pendingAction.suggestedPrice, result.task.decision.entryPrice);
  assert.equal(fixture.calls.filled, 0);
  assert.deepEqual(fixture.calls.submitted, []);
  assert.equal(fixture.calls.model, 0);
  assert.equal(publicTask(result.task).providerSelectionRequired, false);
  assert.equal(compactTaskRuntime(result.task).decisionSource, "ALGORITHM");
});

test("entry after slow collection uses the refreshed normal candle and executable price", async t => {
  const fixture = engineFixture(t, "algo-api-refresh", "LIVE");
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const collected = fixture.market(now - 5800, 103, { flash: true });
  const fresh = fixture.market(now, 99);
  const result = await runAnalysis(fixture.task.id, "", { runtime: {
    ...fixture.runtime, observeMarket: async () => collected, observeExecutionMarket: async () => fresh,
  } });
  assert.equal(result.task.decision.action, "BUY");
  assert.equal(fixture.calls.submitted.length, 1);
  assert.equal(fixture.calls.submitted[0].price, fresh.orderBook.asks[0].price);
  assert.equal(fixture.calls.model, 0);
});

test("an unsubmitted confirmation failure allows the next automatic entry", async t => {
  const fixture = engineFixture(t, "algo-entry-retry", "LIVE");
  let now = Math.floor(Date.now() / 60_000) * 60_000;
  t.mock.method(Date, "now", () => now);
  const submit = fixture.runtime.submitSuggestionForm;
  let attempts = 0;
  t.mock.method(fixture.runtime, "submitSuggestionForm", async input => {
    if (++attempts === 1) {
      return { ok: false, code: "TRADE_CONFIRM_DISABLED", submitted: false, confirmed: false, cancelled: true };
    }
    return submit(input);
  });
  await runAnalysis(fixture.task.id, "", { runtime: fixture.runtime });
  assert.equal(fixture.task.pendingAction.status, "CANCELLED");
  assert.equal(fixture.task.pendingAction.lastExecution.cancelled, true);
  now += 2000;
  await runAnalysis(fixture.task.id, "", { trigger: "monitor", skipIfUnchanged: true, runtime: fixture.runtime });
  assert.equal(fixture.task.pendingAction.status, "AWAITING_FILL");
  assert.equal(fixture.calls.submitted.length, 1);
});

test("a pending suggestion cannot submit after switching decision sources", async t => {
  const fixture = engineFixture(t, "algo-changed-source", "LIVE");
  await runAnalysis(fixture.task.id, "", { runtime: fixture.runtime });
  fixture.task.pendingAction = { ...fixture.task.pendingAction, status: "WAITING" };
  fixture.task.decisionSource = "AI";
  await assert.rejects(confirmPendingAction(fixture.task.id, { runtime: fixture.runtime }), /DECISION_SOURCE_CHANGED/);
  assert.equal(fixture.task.pendingAction.status, "CANCELLED");
  assert.equal(fixture.calls.submitted.length, 1);
});

test("algorithm submits through the existing path, preserves target after fill and skips flash exits", async t => {
  const fixture = engineFixture(t, "algo-live", "LIVE");
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  await runAnalysis(fixture.task.id, "", { runtime: fixture.runtime });
  assert.equal(fixture.calls.submitted.length, 1);
  const entry = fixture.calls.submitted[0];
  assert.equal(entry.action, "BUY");
  assert.equal(entry.entryGuard.decisionSource, "ALGORITHM");
  const { takeProfitPrice: target, hardStopPrice } = entry.entryGuard.plan;
  fixture.account.positionSummaries = [{ symbol: "ALGO", side: "LONG", quantity: 1, frozenQuantity: 0, averagePrice: entry.price }];
  const tick = async (price, options, elapsed = 2000) => {
    clock += elapsed;
    return runPositionExitCycle(fixture.task.id, { now: clock, runtime: {
      ...fixture.runtime, observeExecutionMarket: async () => fixture.market(clock, price, options),
    } });
  };
  await tick(entry.price);
  assert.equal(fixture.task.summaryTradingPlans[0].origin, "ALGORITHM_ENTRY");
  await tick(entry.price + 0.2, undefined, 60_000);
  assert.equal(fixture.task.summaryTradingPlans[0].plan.takeProfitPrice, target);
  await tick(hardStopPrice, { flash: true });
  assert.equal(fixture.calls.submitted.length, 1);
  await tick(entry.price);
  assert.equal(fixture.calls.submitted.length, 1);
  await tick(target + 0.2);
  assert.equal(fixture.calls.submitted.length, 2);
  assert.equal(fixture.calls.submitted[1].exitGuard.aiAuthorization.trigger, "TAKE_PROFIT");
  assert.equal(fixture.calls.model, 0);
});

function forecastHolding(direction, type) {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const side = direction === 1 ? "LONG" : "SHORT";
  const averagePrice = 100 + direction * (type === "PROFIT" ? -0.4 : 2.5);
  const summary = { symbol: "ALGO", instrumentId: "537", side, averagePrice, quantity: 1, frozenQuantity: 0 };
  const plan = tradingPlan(side, averagePrice, { takeProfitPrice: averagePrice + direction * 6,
    stopLossPrice: averagePrice - direction * 4, hardStopPrice: averagePrice - direction * 6, maxHoldSec: 480 });
  const book = { ...bookAt(now, 100 - direction * 0.7, type === "STOP" ? -direction : direction, { candles: 170 }), instrumentId: "537" };
  const account = { positionsVerified: true, positionSummariesVerified: true, positionSummaries: [summary],
    openOrdersVerified: true, openOrders: [] };
  const market = (time, price, { flash = false, nextClose } = {}) => {
    const history = book.history.slice(-2);
    if (nextClose !== undefined) {
      const open = history[1].close;
      history[1] = { ...history[1], open, close: nextClose, high: Math.max(open, nextClose) + 0.25, low: Math.min(open, nextClose) - 0.25,
        confirmation: { status: "CONFIRMED", lastObservedAt: time } };
      history.push({ ...history[1], timestamp: history[1].timestamp + 60_000 });
    }
    const last = { ...history.at(-1), confirmation: { observed: true, lastObservedAt: time } };
    if (flash) Object.assign(last, { high: Math.max(last.open, last.close), low: Math.min(last.open, last.close) });
    return { ...book, account, history: [...history.slice(0, -1), last], observedAt: new Date(time).toISOString(),
      orderBook: { bids: [{ price, volume: 1 }], asks: [{ price, volume: 1 }] } };
  };
  const before = new Date(now - 60_000).toISOString();
  const task = { decisionSource: "ALGORITHM", market: { ...book, observedAt: before, history: book.history.slice(0, -2) } };
  const price = 100 - 0.8 * direction;
  const context = summaryExitReviewContexts(market(now, price), now)[0];
  const { record } = installSummaryPlan(task, context, plan, { id: `initial-${side}`,
    origin: "ALGORITHM_ENTRY", observedAt: before, holdingStartedAt: before, now });
  const tick = (time, quote = price, options) => {
    const next = market(time, quote, options);
    observeSummaryPlans(task, next, time);
    return summaryExitCandidates(task, next, time);
  };
  return { task, book, record, plan, tick, price, now, summary, averagePrice };
}

for (const direction of [1, -1]) {
  const side = direction === 1 ? "LONG" : "SHORT";
  test(`${side} rolls its profitable target from confirmed history and uses fresh executable prices`, () => {
    const { record, plan, tick, now, price, averagePrice } = forecastHolding(direction, "PROFIT");
    const deadline = record.maxHoldAt;
    assert.deepEqual(tick(now), []);
    const forecast = record.algorithmExitForecast;
    assert.equal(forecast.kind, "PROFIT");
    assert.ok(forecast.matchedPaths >= 8);
    assert.ok((forecast.targetPrice - averagePrice) * direction > 0);
    assert.ok((plan.takeProfitPrice - forecast.targetPrice) * direction > 0);
    assert.equal(record.plan.hardStopPrice, plan.hardStopPrice);
    assert.equal(record.maxHoldAt, deadline);
    assert.deepEqual(tick(now + 2000, price + 0.1 * direction), []);
    assert.equal(record.algorithmExitForecast, forecast);
    assert.equal(tick(now + 4000, forecast.targetPrice)[0]?.decision.exitReason, "TAKE_PROFIT");
  });

  test(`${side} rechecks a less-loss target after a flash without widening its risk`, () => {
    const { record, plan, tick, now, price, averagePrice, summary } = forecastHolding(direction, "REDUCE_LOSS");
    const deadline = record.maxHoldAt;
    assert.deepEqual(tick(now), []);
    const forecast = record.algorithmExitForecast;
    assert.equal(forecast.kind, "REDUCE_LOSS");
    assert.ok((forecast.targetPrice - price) * direction > 0);
    assert.ok((forecast.targetPrice - averagePrice) * direction <= 0);
    assert.ok(Date.parse(forecast.deadlineAt) < Date.parse(deadline));
    assert.deepEqual(tick(now + 2000, forecast.targetPrice, { flash: true }), []);
    assert.deepEqual(tick(now + 4000), []);
    const candidate = tick(now + 6000, forecast.targetPrice)[0].decision;
    assert.equal(candidate.exitReason, "ALGORITHM_REDUCE_LOSS");
    assert.equal(candidate.exitType, "STOP_LOSS");
    const authorization = candidate.exitGuard.aiAuthorization;
    assert.equal(summaryExitAllowsPrice(summary, price, authorization, now + 6000), false);
    assert.equal(summaryExitAllowsPrice(summary, plan.hardStopPrice, authorization, now + 6000), true);
    assert.equal(record.maxHoldAt, deadline);
    assert.equal(record.plan.stopLossPrice, plan.stopLossPrice);
    assert.equal(record.algorithmExitForecast, forecast);
  });
}

test("recovery expiry exits at the next normal price and an unsupported adverse trend arms a stop", () => {
  const recovery = forecastHolding(1, "REDUCE_LOSS");
  recovery.tick(recovery.now);
  const expires = Date.parse(recovery.record.algorithmExitForecast.deadlineAt);
  assert.deepEqual(recovery.tick(expires, recovery.price, { flash: true }), []);
  assert.equal(recovery.tick(expires + 1000)[0]?.decision.exitReason, "ALGORITHM_RECOVERY_TIMEOUT");

  const stop = forecastHolding(-1, "STOP");
  const [candidate] = stop.tick(stop.now);
  assert.equal(candidate.decision.exitReason, "ALGORITHM_STOP");
  const authorization = candidate.decision.exitGuard.aiAuthorization;
  assert.equal(summaryExitAllowsPrice(stop.summary, stop.averagePrice, authorization, stop.now), false);
});

test("a new confirmed reversal can invalidate a pending rebound before its deadline", () => {
  const recovery = forecastHolding(1, "REDUCE_LOSS");
  const older = bookAt(recovery.now, 99, 1, { candles: 520 }).history.slice(0, -2);
  recovery.task.market.history = older.map((bar, index) => {
    if (index >= 240) return bar;
    const step = index % 20;
    if (step === 11) return { ...bar, open: 100, high: 100.25, low: 95.75, close: 96 };
    const close = step < 11 ? 95.16 + step * 0.44 : 96 - (step - 11) * 0.65;
    return { ...bar, open: close - 0.25, high: close + 0.6, low: close - 0.7, close };
  });
  assert.deepEqual(recovery.tick(recovery.now), []);
  const prior = recovery.record.algorithmExitForecast;
  assert.equal(prior.kind, "REDUCE_LOSS");
  const after = recovery.now + 61_000;
  assert.ok(after < Date.parse(prior.deadlineAt));
  assert.deepEqual(recovery.tick(after, 98, { nextClose: 96, flash: true }), []);
  assert.equal(recovery.record.algorithmExitForecast, prior);
  const [candidate] = recovery.tick(after + 1000, 98, { nextClose: 96 });
  assert.equal(candidate?.decision.exitReason, "ALGORITHM_STOP");
  assert.equal(recovery.record.plan.hardStopPrice, recovery.plan.hardStopPrice);
});

test("a quick observation cannot use another instrument's history or an unfinished candle to reforecast", () => {
  const fixture = forecastHolding(1, "PROFIT");
  fixture.task.market = { ...fixture.task.market, instrumentId: "536" };
  assert.deepEqual(fixture.tick(fixture.now), []);
  assert.equal(fixture.record.algorithmExitForecast, undefined);
  fixture.task.market = { ...fixture.task.market, instrumentId: "537" };
  assert.deepEqual(fixture.tick(fixture.now, fixture.price, { flash: true }), []);
  assert.equal(fixture.record.algorithmExitForecast, undefined);
  assert.deepEqual(fixture.tick(fixture.now + 2000), []);
  assert.equal(fixture.record.algorithmExitForecast.candleTimestamp, fixture.now - 60_000);
});

test("replay executes only on a subsequent quote, reports net if available and keeps gross losses", async () => {
  const now = Date.now(), decision = algorithmEntryDecision(bookAt(now, 99), { now });
  const { takeProfitPrice, hardStopPrice } = decision.tradePlan;
  const withCosts = await replayAlgorithm([
    bookAt(now, 99),
    bookAt(now + 2000, 99, 1, { cost: 0.2 }),
    bookAt(now + 4000, takeProfitPrice + 0.2, 1, { cost: 0.2 }),
    bookAt(now + 6000, 99),
    bookAt(now + 8000, 99, 1, { cost: 0.2 }),
    bookAt(now + 10000, hardStopPrice, 1, { cost: 0.2 }),
  ]);
  assert.equal(withCosts.closedTrades, 2);
  assert.equal(withCosts.trades[0].entryAt, new Date(now + 2000).toISOString());
  assert.ok(withCosts.gross.profit > 0 && withCosts.gross.loss > 0);
  assert.ok(withCosts.net.total < withCosts.gross.total);
  assert.ok(withCosts.net.maxClosedTradeDrawdown > 0);
  const withoutCosts = await replayAlgorithm([
    bookAt(now, 99), bookAt(now + 2000, 99), bookAt(now + 4000, takeProfitPrice + 0.2),
  ]);
  assert.equal(withoutCosts.closedTrades, 1);
  assert.equal(withoutCosts.net, null);
  await assert.rejects(replayAlgorithm([bookAt(now, 99), bookAt(now, 99)]), /observedAt 严格递增/);
  await assert.rejects(replayAlgorithm([
    { ...bookAt(now, 99), instrumentId: "537" }, { ...bookAt(now + 2000, 99), instrumentId: "536" },
  ]), /同一个交易品种/);
});

test("minute probe uses the next continuous open and keeps costs unknown", async () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const history = bookAt(now - 60_000, 99).history.map(({ confirmation, ...candle }) => ({ ...candle, instrumentId: "537" }));
  history.at(-1).close = 99.4;
  const next = { instrumentId: "537", timestamp: now, open: 99.4, high: 101.2, low: 99, close: 101 };
  const result = await probeAlgorithmCandles([...history, next]);
  assert.equal(result.closedTrades, 1);
  assert.equal(result.trades[0].entryAt, new Date(now).toISOString());
  assert.equal(result.trades[0].entryPrice, next.open);
  assert.equal(result.byExitReason.TAKE_PROFIT.total, 1.6);
  assert.equal(result.net, null);
  const gap = await probeAlgorithmCandles([...history, { ...next, timestamp: now + 60_000 }]);
  assert.equal(gap.closedTrades, 0);
  assert.equal(gap.openPosition, null);
});
