import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildPendingAction, confirmPendingAction, runAnalysis, runPositionExitCycle, startTask, stopAllControllers, stopController, stopTask } from "../server/engine.mjs";
import { exitNetPnl, validateExitPlans } from "../server/exit-policy.mjs";
import { observePositionLosses } from "../server/loss-observation.mjs";
import { requestDecision } from "../server/provider.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { state } from "../server/store.mjs";

afterEach(stopAllControllers);

function setup(id, positions, extras = {}) {
  const now = Date.now();
  const history = Array.from({ length: 30 }, (_, i) => ({ timestamp: now - (29 - i) * 60000, open: 100, high: 106, low: 99, close: 105, volume: 10 }));
  const market = { ok: true, symbol: "DGKZ", symbolName: "测试商品", observedAt: new Date(now).toISOString(), source: "test", evidenceId: "market:test", fingerprint: id, history, historyCount: history.length, timeframe: "1m", quote: { price: 105 }, latest: { price: 105 }, account: { positionsVerified: true, positions, openOrdersVerified: true, openOrders: [], availableFunds: 10000 }, orderBook: { bids: [{ price: 105, volume: 100 }], asks: [{ price: 106, volume: 100 }] }, books: [], missingFields: [], indicators: {} };
  const task = { id, ownerUserId: "exit-test-owner", name: id, mode: "LIVE", autoDecisionEnabled: false, status: "MONITORING", monitoringEnabled: true, stopLocked: false, monitorGeneration: 0, riskProfile: "Balanced", target: { type: "website", url: "https://smyw.haohandahan.cn/client/#/transcc", connectorId: "connector_haohan_readonly", browserSessionId: `task:${id}` }, market, rules: [], workflow: [], metrics: { equity: 10000 }, decision: { action: "HOLD", riskFlags: [], evidenceIds: [], confidence: 0 }, ...extras };
  // Most scenarios model an existing monitoring lifecycle. Startup adoption
  // is exercised separately with rescueStartupScanned=false.
  task.rescueStartupScanned = extras.rescueStartupScanned ?? true;
  state.tasks.unshift(task);
  const submitted = [], cancelled = [];
  const runtime = {
    observeExecutionMarket: async () => ({ ...market, observedAt: new Date().toISOString(), account: { ...market.account, positions: [...market.account.positions], openOrders: [...market.account.openOrders] } }),
    cancelOpenOrders: async ({ orderIds }) => { cancelled.push(...orderIds); market.account.openOrders = []; return { ok: true, results: orderIds.map(orderId => ({ orderId, cancelled: true })) }; },
    submitSuggestionForm: async input => { submitted.push(input); market.account.positions = market.account.positions.filter(p => !input.targetPositionIds.includes(p.positionOrderId)); return { ok: true, submitted: true, targetPositionIds: input.targetPositionIds, submittedQuantity: input.quantity }; },
  };
  return { task, market, runtime, submitted, cancelled };
}
const long = (id, quantity = 1) => ({ positionOrderId: id, symbol: "DGKZ", symbolName: "测试商品", side: "买入", quantity, frozenQuantity: 0, orderPrice: 100 });

function seedWorseningLoss(f, seconds = 90) {
  const now = Date.now();
  delete f.task.lossObservations;
  f.market.observedAt = new Date(now).toISOString();
  const side = /short|卖/i.test(f.market.account.positions[0].side) ? -1 : 1;
  for (let ago = seconds; ago >= 0; ago -= 10) {
    const market = structuredClone(f.market);
    market.observedAt = new Date(now - ago * 1000).toISOString();
    for (const levels of [market.orderBook.bids, market.orderBook.asks]) levels[0].price += side * ago * 0.005;
    observePositionLosses(f.task, market, now - ago * 1000);
  }
}

for (const scenario of ["missing-id", "wrong-side", "other-instrument", "not-losing"]) {
  test(`RANGE rescue exception still rejects ${scenario}`, () => {
    const position = { ...long("original"), orderPrice: scenario === "not-losing" ? 100 : 108 };
    const f = setup(`range-rescue-invalid-${scenario}`, [position]);
    assert.throws(() => buildPendingAction(f.task, { action: scenario === "wrong-side" ? "BUY" : "SELL", marketRegime: "RANGE",
      entryPurpose: "RESCUE", rescuePositionIds: [scenario === "missing-id" ? "other" : "original"],
      targetSymbol: scenario === "other-instrument" ? "DGJJ" : "DGKZ", bullishProfitProbability: 0.5, bearishProfitProbability: 0.5 }), /INVALID_RESCUE_TARGET/);
  });
}

for (const automatic of [false, true]) for (const heldSide of ["LONG", "SHORT"]) for (const regime of ["trend", "RANGE"]) {
  test(`${automatic ? "automatic" : "manual"} ${heldSide} ${regime}: counter-trend rescue opens the opposite side and preserves the original protection`, async () => {
    const position = { ...long("original"), side: heldSide, orderPrice: heldSide === "LONG" ? 107 : 104, roundTripFee: 0.2 };
    const f = setup(`rescue-entry-${automatic}-${heldSide}-${regime}`, [position], { autoDecisionEnabled: automatic });
    const action = heldSide === "LONG" ? "SELL" : "BUY";
    const forms = [];
    await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
      observeMarket: async () => f.market,
      fillSuggestionForm: async input => { forms.push(input); return { ok: true, filled: true }; },
      requestDecision: async () => ({ action, entryPurpose: "RESCUE", rescuePositionIds: ["original"], marketRegime: regime === "RANGE" ? "RANGE" : action === "SELL" ? "DOWN" : "UP", targetSymbol: "DGKZ", orderType: "MARKET",
        bullishProfitProbability: 0.6, bearishProfitProbability: 0.6, riskFlags: [], evidenceIds: [],
        holdingPlan: { decision: "HOLD_THROUGH_PULLBACK", rationale: "保留 original，反向补救，原保护继续有效" },
        exitPlans: [{ positionId: "original", heldSide, quantity: 1, validForSec: 300,
          takeProfitPrice: heldSide === "LONG" ? 109 : 102, stopLossPrice: heldSide === "LONG" ? 104.5 : 106.5 }],
      }),
    } });
    const writes = automatic ? f.submitted : forms;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, action);
    assert.equal(writes[0].quantity, 1);
    assert.equal(writes[0].exitType || null, null);
    assert.deepEqual(writes[0].targetPositionIds, []);
    assert.deepEqual(f.market.account.positions, [position]);
    assert.equal(f.task.exitPlans[0].positionId, "original");
    assert.equal(f.task.exitPlans[0].stopLossPrice, heldSide === "LONG" ? 104.5 : 106.5);
  });
}

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic" : "manual"}: account total does not bypass ordinary loss observation`, async () => {
    const positions = [
      { ...long("original-loss"), orderPrice: 101, roundTripFee: 0.2 },
      { ...long("rescue-short"), side: "SHORT", orderPrice: 101.8, quantity: 3, roundTripFee: 0.2 },
      { ...long("other-instrument"), symbol: "DGJJ", symbolName: "另一商品", orderPrice: 200, roundTripFee: 0.2 },
    ];
    const f = setup(`rescue-account-exit-${automatic}`, positions, { autoDecisionEnabled: automatic });
    f.market.orderBook = { bids: [{ price: 100, volume: 100 }], asks: [{ price: 101, volume: 100 }] };
    f.market.books = [
      { symbol: "DGKZ", observedAt: f.market.observedAt, orderBook: f.market.orderBook },
      { symbol: "DGJJ", observedAt: f.market.observedAt, orderBook: { bids: [{ price: 200.5, volume: 100 }], asks: [{ price: 202, volume: 100 }] } },
    ];
    f.market.account.realtimeValueChange = -999;
    const prices = [100, 101, 200.5];
    const pnls = positions.map((p, i) => exitNetPnl(p, prices[i]).netPnl);
    assert.ok(pnls[0] < 0);
    assert.ok(pnls.reduce((sum, value) => sum + value, 0) > 0);
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 0, "positive account total alone must not invent an AI liquidation decision");
    const validated = validateExitPlans({ exitPlans: positions.map((p, i) => ({
      positionId: p.positionOrderId, heldSide: p.side === "SHORT" ? "SHORT" : "LONG", quantity: p.quantity,
      validForSec: 300, takeProfitPrice: null, stopLossPrice: prices[i], rationale: "全账户补救成功，整体保护锁盈",
    })) }, f.market, f.task);
    assert.deepEqual(validated.rejected, []);
    f.task.exitPlans = validated.plans;
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.deepEqual(f.submitted.map(input => input.targetPositionIds[0]).sort(), ["other-instrument", "rescue-short"]);
    assert.deepEqual(f.submitted.map(input => input.action), ["BUY", "SELL"]);
    assert.ok(f.submitted.every(input => input.exitType === "STOP_LOSS" && input.quantity === positions.find(p => p.positionOrderId === input.targetPositionIds[0]).quantity));
    assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["original-loss"]);
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 2, "completed exits must not be submitted twice");
  });
}

for (const heldSide of ["LONG", "SHORT"]) test(`${heldSide}: 4-point ceiling exits a fee loss without waiting for 5`, async () => {
  const f = setup(`fee-ceiling-${heldSide}`, [{ ...long("P1"), side: heldSide, roundTripFee: 5 }]);
  const price = heldSide === "LONG" ? 104 : 96;
  f.market.orderBook = { bids: [{ price, volume: 100 }], asks: [{ price, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitType, "STOP_LOSS");
  assert.equal(f.submitted[0].exitGuard.positionPoints.threshold, 4);
  assert.equal(f.task.pendingAction.source, "position_profit_ceiling");
});

for (const automatic of [false, true]) for (const heldSide of ["LONG", "SHORT"]) for (const planState of ["missing", "distant", "expired"]) {
  test(`${automatic ? "automatic" : "manual"} ${heldSide}: 1-3 points wait for an AI-selected profit exit when the ${planState} plan cannot trigger`, async () => {
    const f = setup(`realize-profit-${automatic}-${heldSide}-${planState}`, [{ ...long("profit", 2), side: heldSide, roundTripFee: 1 },
      { ...long("recover", 2), side: heldSide, orderPrice: heldSide === "LONG" ? 102.5 : 97.5, roundTripFee: 1 }], { autoDecisionEnabled: automatic });
    const price = heldSide === "LONG" ? 102 : 98;
    f.market.orderBook = { bids: [{ price, volume: 100 }], asks: [{ price, volume: 100 }] };
    f.market.account.realtimeValueChange = -100;
    f.task.exitPlans = planState === "missing" ? [] : [{ positionId: "profit", heldSide, quantity: 2, entryPrice: 100,
      takeProfitPrice: heldSide === "LONG" ? 110 : 90, stopLossPrice: null, expiresAt: new Date(Date.now() + 120000).toISOString() }];
    if (planState === "expired") f.task.exitPlans[0].expiresAt = new Date(Date.now() - 1).toISOString();
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 0);
    assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["profit", "recover"]);
  });
}

test("an AI profit plan can exit a position between one and four points", async () => {
  const f = setup("ai-selected-profit", [{ ...long("profit", 2), roundTripFee: 1 }, long("recover", 2)]);
  f.market.orderBook = { bids: [{ price: 102, volume: 100 }], asks: [{ price: 103, volume: 100 }] };
  f.task.exitPlans = [{ positionId: "profit", heldSide: "LONG", quantity: 2, entryPrice: 100, takeProfitPrice: 102, stopLossPrice: null, expiresAt: new Date(Date.now() + 120000).toISOString() }];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitType, "TAKE_PROFIT");
  assert.equal(f.task.pendingAction.source, "ai_price_trigger");
});

for (const heldSide of ["LONG", "SHORT"]) for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
  test(`${heldSide} ${exitType}: a changed quote after AI returns invalidates the action`, async () => {
    const f = setup(`late-price-${heldSide}-${exitType}`, [{ ...long("P1"), side: heldSide === "LONG" ? "买入" : "卖出" }]);
    const result = await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
      observeMarket: async () => structuredClone(f.market),
      requestDecision: async () => {
        f.market.orderBook = { bids: [{ price: 99, volume: 100 }], asks: [{ price: 100, volume: 100 }] };
        return { action: heldSide === "LONG" ? "SELL" : "BUY", marketRegime: "UP", exitType, targetPositionIds: ["P1"], targetSymbol: "DGKZ", riskFlags: [], evidenceIds: [] };
      },
    } });
    assert.equal(result.reason, "MARKET_CHANGED_DURING_ANALYSIS");
    assert.equal(f.submitted.length, 0);
    assert.equal(f.task.lastAnalysisSucceeded, false);
  });
}

test("slow AI is cancelled on a live profit trigger, while its authorized exit still executes", async () => {
  const f = setup("cancel-stale-ai", [long("P1")]);
  f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1,
    validForSec: 300, takeProfitPrice: 104, stopLossPrice: 98 }] }, f.market, f.task).plans;
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const operation = runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => structuredClone(f.market),
    requestDecision: async (_provider, _context, options) => {
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  } });
  await ready;
  f.market.orderBook = { bids: [{ price: 106, volume: 100 }], asks: [{ price: 107, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  const result = await operation;
  assert.equal(signal.aborted, true);
  assert.equal(result.reason, "MARKET_CHANGED_DURING_ANALYSIS");
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitType, "TAKE_PROFIT");
});

for (const seconds of [50, 90, 120]) test(`ordinary loss after ${seconds}s only forces an exit after two minutes of expansion`, async () => {
  const f = setup(`loss-timer-${seconds}`, [{ ...long("P1"), orderPrice: 106.3, roundTripFee: 0 }]);
  seedWorseningLoss(f, seconds);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, seconds >= 120 ? 1 : 0);
  if (seconds >= 120) {
    assert.equal(f.submitted[0].exitType, "STOP_LOSS");
    assert.equal(f.task.pendingAction.source, "observed_loss_stop");
  }
});

test("an old stop cannot bypass the observation window or abort a running AI", async () => {
  const f = setup("old-stop-waits", [{ ...long("P1"), orderPrice: 106.3, roundTripFee: 0 }]);
  seedWorseningLoss(f, 90);
  f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1,
    validForSec: 300, takeProfitPrice: null, stopLossPrice: 105 }] }, { ...f.market, observedAt: new Date(Date.now() - 90000).toISOString() }, f.task).plans;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 0, "a plan authored before observation needs a new AI review");
  f.market.flashK = { suspected: true };
  seedWorseningLoss(f, 120);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 0, "flash blocks the two-minute stop too");
});

for (const side of ["LONG", "SHORT"]) test(`${side}: observed loss recovers to net zero and AI can exit below one point`, async () => {
  const f = setup(`recovery-ai-${side}`, [{ ...long("P1", 2), side, roundTripFee: 1 }]);
  const now = Date.now();
  for (let ago = 60; ago >= 10; ago -= 10) {
    const market = { ...f.market, observedAt: new Date(now - ago * 1000).toISOString(), orderBook: {
      bids: [{ price: 100, volume: 10 }], asks: [{ price: 100, volume: 10 }] } };
    observePositionLosses(f.task, market, now - ago * 1000);
  }
  const price = side === "LONG" ? 100.5 : 99.5;
  f.market.orderBook = { bids: [{ price, volume: 10 }], asks: [{ price, volume: 10 }] };
  await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => ({ ...f.market, observedAt: new Date().toISOString() }),
    requestDecision: async (_provider, context) => {
      assert.equal(context.account.lossObservations[0].review.status, "RECOVERED");
      return { action: side === "LONG" ? "SELL" : "BUY", exitType: "TAKE_PROFIT", targetPositionIds: ["P1"], targetSymbol: "DGKZ",
        riskFlags: [], evidenceIds: [], exitPlans: [{ positionId: "P1", heldSide: side, quantity: 2, validForSec: 120, takeProfitPrice: price, stopLossPrice: null }] };
    },
  } });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.positions[0].lossRecovery, true);
});

test("a stale HOLD cannot replace live exit plans; unchanged fresh snapshots keep the original expiry", async () => {
  const f = setup("hold-plan-review", [long("P1")]);
  const oldPlan = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 300, takeProfitPrice: 104 }] }, f.market, f.task).plans[0];
  f.task.exitPlans = [oldPlan];
  const result = await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => structuredClone(f.market), requestDecision: async () => {
      f.market.account.positions[0].orderPrice = 101;
      return { action: "HOLD", riskFlags: [], evidenceIds: [], exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 300, takeProfitPrice: 120 }] };
    },
  } });
  assert.equal(result.reason, "POSITION_CHANGED_DURING_ANALYSIS");
  assert.equal(f.task.exitPlans[0], oldPlan);
  assert.equal(f.submitted.length, 0);
});

test("ordinary ticks do not starve AI; its matching price condition executes at the latest quote", async () => {
  const f = setup("live-condition-completes", [{ ...long("P1"), orderPrice: 102.5 }]);
  let started, finish, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const originalObservedAt = f.market.observedAt;
  const operation = runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => structuredClone(f.market),
    requestDecision: async (_provider, _context, options) => {
      signal = options.signal;
      started();
      return new Promise(resolve => { finish = resolve; });
    },
  } });
  await ready;
  f.market.orderBook = { bids: [{ price: 103.5, volume: 100 }], asks: [{ price: 104.5, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(signal.aborted, false);
  finish({ action: "SELL", marketRegime: "DOWN", exitType: "STOP_LOSS", targetPositionIds: ["P1"], targetSymbol: "DGKZ", riskFlags: [], evidenceIds: [],
    exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 120, takeProfitPrice: 107.5, stopLossPrice: 104 }] });
  await operation;
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.positions[0].triggerPrice, 104);
  assert.equal(f.submitted[0].exitGuard.positions[0].comparison, "LTE");
  assert.equal(f.task.exitPlans[0].observedAt, originalObservedAt);
});

for (const automatic of [false, true]) for (const heldSide of ["LONG", "SHORT"]) {
  test(`${automatic ? "automatic" : "manual"} ${heldSide}: the 4-point host ceiling exits without an AI plan`, async () => {
    const isLong = heldSide === "LONG";
    const price = 100 + (isLong ? 1 : -1) * 4;
    const f = setup(`amount-boundary-${automatic}-${heldSide}`, [
      { ...long("boundary", 2), side: isLong ? "\u4e70\u5165" : "\u5356\u51fa", roundTripFee: 1 },
      { ...long("recover"), side: isLong ? "\u4e70\u5165" : "\u5356\u51fa", orderPrice: price + (isLong ? 1 : -1) },
    ], { autoDecisionEnabled: automatic });
    f.market.account.realtimeValueChange = -100;
    f.market.orderBook = { bids: [{ price, volume: 100 }], asks: [{ price, volume: 100 }] };
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 1);
    assert.deepEqual(f.submitted[0].targetPositionIds, ["boundary"]);
    assert.equal(f.submitted[0].exitType, "TAKE_PROFIT");
    assert.equal(f.submitted[0].exitGuard.positionPoints.threshold, 4);
    assert.equal(f.submitted[0].exitGuard.positionPoints.programCeiling, true);
    assert.equal(f.task.pendingAction.source, "position_profit_ceiling");
    assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["recover"]);
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 1);
  });
}

for (const heldSide of ["LONG", "SHORT"]) for (const amount of [0, 0.5, 0.99, 1, 1.99, 2, 4, -1]) {
  test(`${heldSide}: below 1 point cannot take profit; eligible point boundary ${amount}`, async () => {
    const f = setup(`ai-range-${heldSide}-${amount}`, [{ ...long("P1", 2), side: heldSide, roundTripFee: 1 }]);
    const price = 100 + (heldSide === "LONG" ? 1 : -1) * amount;
    f.market.orderBook = { bids: [{ price, volume: 100 }], asks: [{ price, volume: 100 }] };
    const exitType = amount >= 0 ? "TAKE_PROFIT" : "STOP_LOSS";
    f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide, quantity: 2, validForSec: 120,
      takeProfitPrice: amount >= 0 ? price : null, stopLossPrice: amount < 0 ? price : null }] }, f.market, f.task).plans;
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, amount < 1 ? 0 : 1);
    if (f.submitted.length) {
      assert.equal(f.submitted[0].exitType, exitType);
      assert.equal(f.task.pendingAction.source, amount === 4 ? "position_profit_ceiling" : "ai_price_trigger");
    }
  });
}

test("account realtime value exactly 2 is reference only without an AI exit plan", async () => {
  const f = setup("account-profit-fallback", [long("profit"), { ...long("loss"), orderPrice: 103 }]);
  f.market.orderBook = { bids: [{ price: 100.5, volume: 100 }], asks: [{ price: 101.5, volume: 100 }] };
  f.task.exitPlans = [{ positionId: "profit", expiresAt: new Date(Date.now() - 1000).toISOString() }];
  f.market.account.realtimeValueChange = 2;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 0);
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["profit", "loss"]);
});

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic" : "manual"}: additional entry keeps omitted valid old plans without extending their expiry`, async t => {
    const f = setup(`entry-retains-plans-${automatic}`, [long("P1"), long("P2")], { autoDecisionEnabled: automatic });
    f.task.exitPlans = validateExitPlans({ exitPlans: f.market.account.positions.map(p => ({ positionId: p.positionOrderId,
      heldSide: "LONG", quantity: 1, validForSec: 300, takeProfitPrice: 104, stopLossPrice: 90 })) }, f.market, f.task).plans;
    const oldExpiry = f.task.exitPlans[1].expiresAt;
    let modelCalls = 0, formCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      modelCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        action: "BUY", marketRegime: "UP", target_symbol: "DGKZ", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3,
        holding_plan: { decision: "HOLD_FOR_TARGET" },
        exit_plans: [{ position_id: "P1", held_side: "LONG", quantity: 1, valid_for_sec: 300, take_profit_price: 103, stop_loss_price: 91 }],
      }) } }] }));
    });
    await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
      observeMarket: async () => f.market,
      requestDecision: async (_provider, context, options) => requestDecision({ apiKey: "fixture", baseUrl: "https://fixture.invalid", model: "deepseek-chat" }, context, options),
      fillSuggestionForm: async () => { formCalls++; return { ok: true, filled: true }; },
    } });
    assert.equal(modelCalls, 1);
    assert.equal(f.task.decision.action, "BUY");
    assert.equal(f.task.lastAnalysisSucceeded, true);
    assert.equal(f.submitted.length, automatic ? 1 : 0);
    assert.equal(formCalls, automatic ? 0 : 1);
    assert.equal(f.task.exitPlans.length, 2);
    assert.equal(f.task.exitPlans.find(p => p.positionId === "P2").expiresAt, oldExpiry);
    assert.equal(f.task.exitPlans.find(p => p.positionId === "P1").takeProfitPrice, 103);
    assert.equal(compactTaskRuntime(f.task).exitPlans.length, 2);
  });
}

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic" : "manual"}: verified net profit exits long/short holdings before distant targets and account thresholds`, async () => {
    const f = setup(`realtime-condition-${automatic}`, [
      { ...long("profit-long"), roundTripFee: 4 },
      { ...long("profit-short"), side: "卖出", orderPrice: 111, roundTripFee: 4 },
      { ...long("loss"), orderPrice: 105, roundTripFee: 2 },
    ], { autoDecisionEnabled: automatic });
    f.market.account.realtimeValueChange = 0;
    f.task.exitPlans = validateExitPlans({ exitPlans: f.market.account.positions.map(p => ({
      positionId: p.positionOrderId, heldSide: p.side === "买入" ? "LONG" : "SHORT", quantity: 1, validForSec: 300,
      takeProfitPrice: p.side === "买入" ? 115 : 95, stopLossPrice: p.side === "买入" ? 96 : 115,
      realtime_take_profit: { value_above: 1, take_profit_price: p.side === "买入" ? p.orderPrice + 5 : p.orderPrice - 5 },
    })) }, f.market, f.task).plans;
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.submitted.length, 2, "verified positive net profit does not wait for an account threshold");
    f.market.account.realtimeValueChange = 2.5;
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.deepEqual(f.submitted.map(s => [s.targetPositionIds[0], s.action, s.exitType]), [
      ["profit-long", "SELL", "TAKE_PROFIT"], ["profit-short", "BUY", "TAKE_PROFIT"],
    ]);
    assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["loss"]);
    f.market.account.realtimeValueChange = -15;
    f.market.orderBook = { bids: [{ price: 96, volume: 100 }], asks: [{ price: 97, volume: 100 }] };
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.deepEqual(f.task.pendingAction.rescuePositionIds, ["loss"]);
    assert.equal(f.submitted.at(-1).exitType, null);
    assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["loss"]);
  });
}

test("closing clears all three long/short positions and verifies actual flatness next observation", async () => {
  const f = setup("closing-three", [long("P1"), long("P2", 2), { ...long("P3"), side: "卖出" }]);
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "entry-old", orderKind: "订立", remainingQuantity: 1 }];
  const scopes = [];
  const runtime = { ...f.runtime, observeExecutionMarket: async (task, connector, options) => { scopes.push(options.accountScope); return f.runtime.observeExecutionMarket(task, connector, options); } };
  const now = Date.parse("2026-10-13T15:56:00+08:00");
  await runPositionExitCycle(f.task.id, { runtime, now });
  assert.deepEqual(scopes, ["full", "full"], "closing must read all orders initially and again after cancellation");
  assert.deepEqual(f.cancelled, ["entry-old"]);
  assert.deepEqual(f.submitted.map(s => [s.action, s.targetPositionIds[0], s.quantity]), [["SELL", "P1", 1], ["SELL", "P2", 2], ["BUY", "P3", 1]]);
  assert.equal(f.task.sessionCloseState.status, "CLOSING");
  await runPositionExitCycle(f.task.id, { runtime, now });
  assert.deepEqual(scopes, ["full", "full", "full"]);
  assert.equal(f.task.sessionCloseState.status, "FLAT_VERIFIED");
  assert.equal(f.submitted.length, 3);
});

for (const autoDecisionEnabled of [false, true]) {
  for (const heldSide of ["LONG", "SHORT"]) {
    for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
      test(`${autoDecisionEnabled ? "automatic" : "manual"} entry mode executes ${heldSide} ${exitType} from verified positions without an order-table read`, async () => {
        const f = setup(`positions-only-${autoDecisionEnabled}-${heldSide}-${exitType}`, [{ ...long("P1"), side: heldSide === "LONG" ? "买入" : "卖出" }], { autoDecisionEnabled });
        const price = exitType === "TAKE_PROFIT" ? (heldSide === "LONG" ? 105 : 95) : (heldSide === "LONG" ? 99 : 101);
        f.market.orderBook = { bids: [{ price: heldSide === "LONG" ? price : price - 1, volume: 100 }], asks: [{ price: heldSide === "LONG" ? price + 1 : price, volume: 100 }] };
        f.market.account.openOrdersVerified = false;
        if (exitType === "STOP_LOSS") seedWorseningLoss(f);
        f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide, quantity: 1, validForSec: 120,
          takeProfitPrice: exitType === "TAKE_PROFIT" ? price : null, stopLossPrice: exitType === "STOP_LOSS" ? price : null }] }, f.market, f.task).plans;
        const scopes = [];
        await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime,
          observeExecutionMarket: async (task, connector, options) => { scopes.push(options.accountScope); return f.runtime.observeExecutionMarket(task, connector, options); },
          cancelOpenOrders: async () => assert.fail("a position-only exit must not cancel unread orders"),
        } });
        assert.deepEqual(scopes, ["positions"]);
        assert.equal(f.submitted.length, 1);
        assert.equal(f.submitted[0].exitType, exitType);
        assert.equal(f.submitted[0].action, heldSide === "LONG" ? "SELL" : "BUY");
        assert.deepEqual(f.submitted[0].targetPositionIds, ["P1"]);
      });
    }
  }
}

for (const autoDecisionEnabled of [false, true]) {
  for (const heldSide of ["LONG", "SHORT"]) {
    test(`${autoDecisionEnabled ? "automatic" : "manual"} ${heldSide}: AI plan observes -1, captures 3 price points after costs, and still protects at its loss boundary`, async () => {
      const isLong = heldSide === "LONG";
      const quote = (f, signedPoints) => {
        const price = 100 + (isLong ? signedPoints : -signedPoints);
        f.market.orderBook = { bids: [{ price: isLong ? price : price - 1, volume: 100 }], asks: [{ price: isLong ? price + 1 : price, volume: 100 }] };
      };
      for (const [points, exitType] of [[3, "TAKE_PROFIT"], [-3, "STOP_LOSS"]]) {
        const f = setup(`forecast-points-${autoDecisionEnabled}-${heldSide}-${exitType}`, [{ ...long("P1"), side: isLong ? "买入" : "卖出", roundTripFee: 1 }], { autoDecisionEnabled });
        quote(f, -1);
        f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide, quantity: 1, validForSec: 120,
          takeProfitPrice: isLong ? 103 : 97, stopLossPrice: isLong ? 97 : 103,
          rationale: "AI预测正常回撤可恢复，目标毛利3点扣费1后净利2，持续恶化至保护边界则止损" }] }, f.market, f.task).plans;
        assert.equal(f.task.exitPlans.length, 1);
        for (let observation = 0; observation < 2; observation++) {
          await runPositionExitCycle(f.task.id, { runtime: f.runtime });
          assert.equal(f.submitted.length, 0, "stable one-point loss must not manufacture an exit outside AI conditions");
        }
        quote(f, points);
        await runPositionExitCycle(f.task.id, { runtime: f.runtime });
        assert.equal(f.submitted.length, 1);
        assert.equal(f.submitted[0].exitType, points <= -3 ? null : exitType);
        assert.equal(f.submitted[0].action, isLong ? "SELL" : "BUY");
        assert.deepEqual(f.submitted[0].targetPositionIds, points <= -3 ? [] : ["P1"]);
        if (points <= -3) assert.deepEqual(f.task.pendingAction.rescuePositionIds, ["P1"]);
      }
    });
  }
}

for (const autoDecisionEnabled of [false, true]) {
  for (const heldSide of ["LONG", "SHORT"]) {
    test(`${autoDecisionEnabled ? "automatic" : "manual"} ${heldSide}: AI closes only the profit, then protects worsening loss with a negative account total`, async () => {
      const isLong = heldSide === "LONG";
      const f = setup(`realtime-profit-${autoDecisionEnabled}-${heldSide}`, [
        { ...long("P-profit"), side: isLong ? "买入" : "卖出", orderPrice: isLong ? 99.5 : 103.5, roundTripFee: 1 },
        { ...long("P-loss"), side: isLong ? "买入" : "卖出", orderPrice: isLong ? 102 : 101, roundTripFee: 1 },
      ], { autoDecisionEnabled });
      f.market.account.realtimeValueChange = 1.01;
      f.market.orderBook = { bids: [{ price: 101.5, volume: 100 }], asks: [{ price: 101.5, volume: 100 }] };
      f.task.exitPlans = validateExitPlans({ exitPlans: [
        { positionId: "P-profit", heldSide, quantity: 1, validForSec: 120, takeProfitPrice: 101.5, rationale: "AI读取实时货值变化大于1，只兑现当前盈利仓；趋势判断保留" },
        { positionId: "P-loss", heldSide, quantity: 1, validForSec: 120, takeProfitPrice: isLong ? 105 : 98, stopLossPrice: isLong ? 95 : 108, rationale: "亏损仓仍在恢复路径，继续趋势分析" },
      ] }, f.market, f.task).plans;
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.deepEqual(f.submitted.map(item => [item.targetPositionIds, item.action, item.exitType]), [[["P-profit"], isLong ? "SELL" : "BUY", "TAKE_PROFIT"]]);
      assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["P-loss"]);
      f.market.account.realtimeValueChange = -10;
      const protectionPrice = isLong ? 95 : 108;
      f.market.orderBook = { bids: [{ price: protectionPrice, volume: 100 }], asks: [{ price: protectionPrice, volume: 100 }] };
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 2);
      assert.equal(f.submitted[1].exitType, null);
      assert.deepEqual(f.task.pendingAction.rescuePositionIds, ["P-loss"]);
      assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["P-loss"]);
    });
  }
}

for (const unverifiedField of ["positionsVerified", "openOrdersVerified"]) {
  test(`crossing into closing rereads full scope and cannot mark an empty ${unverifiedField} snapshot flat`, async () => {
    const f = setup(`crossing-unverified-${unverifiedField}`, []);
    const scopes = [];
    const result = await runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:54:59.950+08:00"), runtime: { ...f.runtime,
      observeExecutionMarket: async (_task, _connector, options) => {
        scopes.push(options.accountScope);
        if (scopes.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 65));
          return { ...f.market, account: { ...f.market.account, openOrdersVerified: false } };
        }
        return { ...f.market, account: { ...f.market.account, [unverifiedField]: false } };
      },
    } });
    assert.deepEqual(scopes, ["positions", "full"]);
    assert.equal(result.code, "ACCOUNT_UNVERIFIED");
    assert.equal(f.task.exitMonitor.status, "ACCOUNT_UNVERIFIED");
    assert.notEqual(f.task.sessionCloseState.status, "FLAT_VERIFIED");
    assert.equal(f.task.sessionCloseState.remainingPositions, null);
    assert.equal(f.submitted.length, 0);
  });
}

test("manual WAITING skips a verified empty account without disturbing the entry form", async () => {
  const f = setup("manual-waiting-flat", []);
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8 });
  const result = await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime,
    observeExecutionMarket: async () => assert.fail("verified flat manual entry must keep its form in place"),
  } });
  assert.equal(result.reason, "MANUAL_ENTRY_WAITING");
  assert.equal(f.task.pendingAction.status, "WAITING");
});

for (const observation of ["unverified-market", "unverified-audit"]) {
  test(`manual WAITING with ${observation} still reads and exits an existing holding`, async () => {
    const f = setup(`manual-waiting-${observation}`, [long("P1")]);
    f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 120, takeProfitPrice: 105 }] }, f.market, f.task).plans;
    f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8 });
    const current = structuredClone(f.market);
    if (observation === "unverified-market") f.market.account = { ...f.market.account, positionsVerified: false, positions: [] };
    else f.task.lastPositionAudit = { positionsVerified: false, positions: [] };
    let reads = 0;
    await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime,
      observeExecutionMarket: async (_task, _connector, options) => { reads++; assert.equal(options.accountScope, "positions"); return current; },
    } });
    assert.equal(reads, 1);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0].exitType, "TAKE_PROFIT");
    assert.deepEqual(f.submitted[0].targetPositionIds, ["P1"]);
  });
}

test("closing never skips a manual WAITING form even when the last holdings snapshot was empty", async () => {
  const f = setup("closing-manual-waiting-flat", []);
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8 });
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "entry-pending", orderKind: "订立", remainingQuantity: 1 }];
  const scopes = [];
  await runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:56:00+08:00"), runtime: { ...f.runtime,
    observeExecutionMarket: async (task, connector, options) => { scopes.push(options.accountScope); return f.runtime.observeExecutionMarket(task, connector, options); },
  } });
  assert.deepEqual(scopes, ["full", "full"]);
  assert.deepEqual(f.cancelled, ["entry-pending"]);
  assert.equal(f.task.sessionCloseState.status, "FLAT_VERIFIED");
});

test("closing blocks both automatic entries and acknowledgements of stale manual entry forms", async () => {
  const f = setup("closing-entry", [], { autoDecisionEnabled: true, tradingSession: { opensAt: "2020-01-01T18:30", closesAt: "2020-01-02T09:00" }, sessionClose: { leadMinutes: 5, timezone: "Asia/Shanghai" } });
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8 });
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /SESSION_CLOSING_NO_ENTRY/);
  assert.equal(f.submitted.length, 0);
});

test("unverified or frozen holdings cannot masquerade as successful closing", async () => {
  const f = setup("closing-unknown", [long("P1")], { tradingSession: { opensAt: "2026-10-13T09:00", closesAt: "2026-10-13T16:00" } });
  f.market.account.positionsVerified = false;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime, now: Date.parse("2026-10-13T16:01:00+08:00") });
  assert.equal(f.task.exitMonitor.status, "ACCOUNT_UNVERIFIED");
  assert.equal(f.task.sessionCloseState.status, "OVERDUE");
  assert.equal(f.task.sessionCloseState.remainingPositions, null);
  assert.equal(f.submitted.length, 0);
});

test("small verified net profit executes while AI is waiting; late entry cannot overwrite the exit", async () => {
  const f = setup("exit-while-ai", [{ ...long("P1"), roundTripFee: 4.5 }]);
  f.task.exitPlans = [];
  let releaseModel, modelStarted;
  const waiting = new Promise(resolve => { modelStarted = resolve; });
  const analysis = runAnalysis(f.task.id, "", { runtime: {
    ...f.runtime, openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => structuredClone(f.market),
    requestDecision: async () => { modelStarted(); return new Promise(resolve => { releaseModel = resolve; }); },
  } });
  await waiting;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitType, "TAKE_PROFIT");
  releaseModel({ action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.9, bearishProfitProbability: 0.1, riskFlags: [], evidenceIds: ["market:test"], holdingPlan: { decision: "HOLD_FOR_TARGET" } });
  await analysis;
  assert.equal(f.submitted.length, 1);
  assert.equal(f.task.pendingAction?.exitType, "TAKE_PROFIT");
});

test("stopping aborts an in-flight fast observation and never submits its late result", async () => {
  const f = setup("stop-exit-watch", [long("P1")]);
  let finishObservation, observedSignal;
  const operation = runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:56:00+08:00"), runtime: { ...f.runtime, observeExecutionMarket: async (_task, _connector, options) => { observedSignal = options.signal; return new Promise(resolve => { finishObservation = resolve; }); } } });
  await new Promise(resolve => setImmediate(resolve));
  stopTask(f.task.id);
  assert.equal(observedSignal.aborted, true);
  finishObservation(f.market);
  await assert.rejects(operation, /EXIT_MONITOR_STOPPED/);
  assert.equal(f.submitted.length, 0);
});

test("daily close settings, explicit AI plans and position verification survive persistence", () => {
  const f = setup("exit-persist", [long("P1")], { tradingSession: { opensAt: "2099-01-01T09:00", closesAt: "2099-01-01T15:30" }, sessionClose: { leadMinutes: 10, timezone: "Asia/Shanghai" } });
  f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 120, takeProfitPrice: 105, stopLossPrice: 99 }] }, f.market, f.task).plans;
  f.task.lastPositionAudit = { positionsVerified: true, positions: [{ positionId: "P1", quantity: 1 }] };
  const runtime = JSON.parse(JSON.stringify(compactTaskRuntime(f.task)));
  assert.equal(runtime.tradingSession.closesAt, "2099-01-01T15:30");
  assert.equal(runtime.exitPlans[0].positionId, "P1");
  assert.equal(runtime.lastPositionAudit.positionsVerified, true);
});

test("entering the closing window during observation still closes; a failed transfer never skips later positions", async () => {
  const f = setup("closing-delay-failure", [long("P1"), long("P2")]);
  await runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:54:59.995+08:00"), runtime: {
    ...f.runtime,
    observeExecutionMarket: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return f.market; },
    submitSuggestionForm: async input => { if (input.targetPositionIds[0] === "P1") return { ok: false, code: "EXCHANGE_REJECTED" }; return f.runtime.submitSuggestionForm(input); },
  } });
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.submitted[0].targetPositionIds, ["P2"]);
  assert.equal(f.task.exitMonitor.status, "ERROR");
  assert.deepEqual(f.task.exitMonitor.failures, [{ positionId: "P1", code: "EXCHANGE_REJECTED" }]);
});

test("failed cancellation keeps closing free holdings, while frozen positions and live orders prevent flat verification", async () => {
  const f = setup("closing-partial-cancel", [long("P1"), { ...long("P2"), frozenQuantity: 1 }]);
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "O1", orderKind: "转让", remainingQuantity: 1, positionOrderId: "P2" }];
  const now = Date.parse("2026-10-13T15:56:00+08:00");
  await runPositionExitCycle(f.task.id, { now, runtime: { ...f.runtime, cancelOpenOrders: async () => ({ ok: false, results: [] }) } });
  assert.deepEqual(f.submitted.map(s => s.targetPositionIds[0]), ["P1"]);
  assert.equal(f.task.sessionCloseState.status, "CLOSING");
  assert.equal(f.task.sessionCloseState.remainingOrders, 1);
});

test("a cancellation transport error still refreshes the account and closes free positions", async () => {
  const f = setup("closing-cancel-error", [long("P1"), { ...long("P2"), frozenQuantity: 1 }]);
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "O1", orderKind: "转让", positionOrderId: "P2", remainingQuantity: 1 }];
  await runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:56:00+08:00"), runtime: {
    ...f.runtime, cancelOpenOrders: async () => { throw new Error("DESKTOP_CALL_TIMEOUT"); },
  } });
  assert.deepEqual(f.submitted.map(s => s.targetPositionIds[0]), ["P1"]);
  assert.equal(f.task.sessionCloseState.status, "CLOSING");
  assert.equal(f.task.sessionCloseState.remainingOrders, 1);
});

test("an exchange rejection is reported and retried without blocking other holdings", async () => {
  const f = setup("closing-rejected", [long("P1"), long("P2")]);
  const now = Date.parse("2026-10-13T15:56:00+08:00");
  await runPositionExitCycle(f.task.id, { now, runtime: {
    ...f.runtime, submitSuggestionForm: async input => input.targetPositionIds[0] === "P1"
      ? { ok: false, submitted: true, code: "TRADE_REJECTED", message: "交易所拒绝" }
      : f.runtime.submitSuggestionForm(input),
  } });
  assert.equal(f.task.exitMonitor.status, "ERROR");
  assert.equal(f.task.exitMonitor.failures[0].positionId, "P1");
  await runPositionExitCycle(f.task.id, { now, runtime: f.runtime });
  assert.deepEqual(f.submitted.map(s => s.targetPositionIds[0]), ["P2", "P1"]);
});

test("stop during cancellation discards a late failure without adding output", async () => {
  const f = setup("closing-cancel-stop", [long("P1")]);
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "O1", orderKind: "订立", remainingQuantity: 1 }];
  let rejectCancellation;
  const operation = runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:56:00+08:00"), runtime: {
    ...f.runtime, cancelOpenOrders: async () => new Promise((_resolve, reject) => { rejectCancellation = reject; }),
  } });
  while (!rejectCancellation) await new Promise(resolve => setImmediate(resolve));
  stopTask(f.task.id);
  const outputCount = state.agentOutput.length;
  rejectCancellation(new Error("DESKTOP_DISCONNECTED"));
  await assert.rejects(operation, /EXIT_MONITOR_STOPPED/);
  assert.equal(state.agentOutput.length, outputCount);
  assert.equal(f.submitted.length, 0);
});

test("stop during submission ignores a successful late browser response", async () => {
  const f = setup("closing-submit-stop", [long("P1")]);
  let finishSubmission;
  const operation = runPositionExitCycle(f.task.id, { now: Date.parse("2026-10-13T15:56:00+08:00"), runtime: {
    ...f.runtime, submitSuggestionForm: async () => new Promise(resolve => { finishSubmission = resolve; }),
  } });
  while (!finishSubmission) await new Promise(resolve => setImmediate(resolve));
  stopTask(f.task.id);
  const orderCount = state.orders.length;
  finishSubmission({ ok: true, submitted: true });
  await assert.rejects(operation, /EXIT_MONITOR_STOPPED/);
  assert.equal(state.orders.length, orderCount);
  assert.equal(f.task.pendingAction.status, "CANCELLED");
  assert.equal(f.task.status, "MANUAL_CONTROL");
});

test("manual continuation receives the close deadline even for an already waiting entry", async () => {
  const f = setup("closing-manual-continuation", [], { tradingSession: { opensAt: "2020-01-01T18:30", closesAt: "2020-01-02T09:00" }, sessionClose: { leadMinutes: 5, timezone: "Asia/Shanghai" } });
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8 });
  let input;
  await runAnalysis(f.task.id, "", { runtime: {
    ...f.runtime, openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    continueManualEntry: async value => { input = value; return { ok: false, continued: false, code: "SESSION_CLOSING_NO_ENTRY" }; },
    observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.8, bearishProfitProbability: 0.2, riskFlags: [], evidenceIds: ["market:test"] }),
  } });
  assert.ok(input.entryDeadlineAt < Date.now());
  assert.equal(f.submitted.length, 0);
});

for (const side of ["LONG", "SHORT"]) {
  for (const ending of ["TAKE_PROFIT", "STOP_LOSS"]) {
    test(`启动已有 ${side} 持仓先分析，容忍回撤，${ending} 按 AI 条件执行`, async (t) => {
      const p = { ...long(`startup-${side}-${ending}`), side: side === "LONG" ? "买入" : "卖出" };
      const f = setup(`startup-${side}-${ending}`, [p], { status: "MANUAL_CONTROL", monitoringEnabled: false });
      const connectorId = `connector-${f.task.id}`;
      state.connectors.unshift({ connectorId, reviewStatus: "APPROVED", adapterId: "haohan-readonly", capabilities: ["read_visible_market"] });
      f.task.target.connectorId = connectorId;
      t.after(() => {
        stopController(f.task.id);
        state.connectors = state.connectors.filter(item => item.connectorId !== connectorId);
        state.tasks = state.tasks.filter(item => item.id !== f.task.id);
      });
      const setPrice = (price) => {
        f.market.orderBook = { bids: [{ price: side === "LONG" ? price : price - 1, volume: 10 }], asks: [{ price: side === "LONG" ? price + 1 : price, volume: 10 }] };
        f.market.latest.price = price;
        f.market.quote.price = price;
        f.market.observedAt = new Date().toISOString();
      };
      setPrice(side === "LONG" ? 99 : 101);
      // A persisted pre-restart plan is deliberately already triggered.
      f.task.exitPlans = [{ positionId: p.positionOrderId, heldSide: side, quantity: 1, takeProfitPrice: null, stopLossPrice: 100, expiresAt: new Date(Date.now() + 60000).toISOString() }];
      startTask(f.task.id);
      stopController(f.task.id);
      assert.equal(f.task.status, "MONITORING");
      assert.deepEqual(f.task.exitPlans, []);
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 0);
      assert.equal(f.task.exitMonitor.status, "PLAN_MISSING");
      let analyzed = 0;
      await runAnalysis(f.task.id, "", { runtime: {
        ...f.runtime, openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => f.market,
        requestDecision: async (_provider, context) => {
          analyzed++;
          assert.equal(context.account.positions[0].positionOrderId, p.positionOrderId);
          assert.equal(context.market.positions[0].entryPrice, 100);
          assert.equal(context.market.positions[0].side, side);
          return { action: "HOLD", bullishProfitProbability: 0.5, bearishProfitProbability: 0.5, riskFlags: [], evidenceIds: ["market:test"], holdingPlan: { decision: "HOLD_THROUGH_PULLBACK" },
            exitPlans: [{ positionId: p.positionOrderId, heldSide: side, quantity: 1, validForSec: 120, takeProfitPrice: side === "LONG" ? 105 : 95, stopLossPrice: side === "LONG" ? 96 : 104, rationale: "趋势仍支持盈利目标，96/104 为盈利路径失效边界" }] };
        },
      } });
      assert.equal(analyzed, 1);
      assert.equal(f.task.exitPlans.length, 1);
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 0, "正常回撤不能直接平掉旧持仓");
      setPrice(ending === "TAKE_PROFIT" ? (side === "LONG" ? 105 : 95) : (side === "LONG" ? 96 : 104));
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 1);
      assert.equal(f.submitted[0].exitType, ending === "STOP_LOSS" ? null : ending);
      assert.equal(f.submitted[0].action, side === "LONG" ? "SELL" : "BUY");
      assert.deepEqual(f.submitted[0].targetPositionIds, ending === "STOP_LOSS" ? [] : [p.positionOrderId]);
      if (ending === "STOP_LOSS") assert.deepEqual(f.task.pendingAction.rescuePositionIds, [p.positionOrderId]);
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 1);
    });
  }
}


for (const automatic of [false, true]) test(`ordinary monitoring withdraws all current remainders without AI, automatic=${automatic}`, async () => {
  const f = setup(`ordinary-cancel-${automatic}`, [{ ...long("partial"), orderPrice: 105 }], { autoDecisionEnabled: automatic });
  f.market.account.openOrders = [
    { orderTime: "2020-01-01T00:00:00Z", orderId: "entry", orderKind: "订立", remainingQuantity: 2, filledQuantity: 1 },
    { orderTime: "2020-01-01T00:00:00Z", orderId: "transfer", orderKind: "转让", remainingQuantity: 1 },
  ];
  f.task.pendingAction = { ...buildPendingAction(f.task, { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.6, bearishProfitProbability: 0.3 }), status: "AWAITING_FILL", entrustedOrderIds: ["entry"] };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.cancelled, ["entry", "transfer"]);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.pendingAction.status, "CANCELLED");
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["partial"]);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.cancelled.length, 2, "confirmed cancellation is not replayed");
});

test("periodic full observation discovers external current orders without waiting for AI", async () => {
  const f = setup("external-current-order", [{ ...long("held"), orderPrice: 105 }], { exitObservationIndex: 4 });
  f.task.market = structuredClone(f.market);
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "external", remainingQuantity: 1 }];
  const scopes = [];
  await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime, observeExecutionMarket: async (...args) => {
    scopes.push(args[2].accountScope); return f.runtime.observeExecutionMarket(...args);
  } } });
  assert.deepEqual(scopes, ["full", "full"]);
  assert.deepEqual(f.cancelled, ["external"]);
  assert.equal(f.submitted.length, 0);
});


test("verified current orders still cancel when holdings are unverified", async () => {
  const f = setup("cancel-without-holdings", []);
  f.market.account.positionsVerified = false;
  f.market.account.openOrders = [{ orderTime: "2020-01-01T00:00:00Z", orderId: "verified-order", remainingQuantity: 1 }];
  const result = await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.cancelled, ["verified-order"]);
  assert.equal(f.submitted.length, 0);
  assert.equal(result.code, "CANCELLATION_UNVERIFIED");
});

for (const path of ["analysis", "monitor"]) test(`${path}: new orders wait 120 seconds without blocking qualified exits`, async () => {
  const f = setup(`wait-current-${path}`, [long("profit")]);
  const startedAt = Date.now();
  f.market.account.openOrders = [{ orderId: "fresh", symbol: "DGKZ", side: "买入", quantity: 2, remainingQuantity: 1,
    orderPrice: 1, orderKind: "订立", orderTime: new Date(startedAt).toISOString() }];
  const runtime = { ...f.runtime, openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => ({ ...f.market, observedAt: new Date().toISOString() }),
    requestDecision: async () => ({ action: "HOLD", riskFlags: [], evidenceIds: [], orderAssessments: [{ orderId: "fresh", decision: "CANCEL" }] }) };
  const cycle = () => path === "analysis" ? runAnalysis(f.task.id, "", { runtime }) : runPositionExitCycle(f.task.id, { runtime });
  await cycle();
  assert.deepEqual(f.cancelled, []);
  assert.ok(f.task.currentOrderTracking.fresh);
  await runPositionExitCycle(f.task.id, { runtime });
  assert.deepEqual(f.submitted.map(p => p.targetPositionIds[0]), ["profit"]);
  assert.deepEqual(f.cancelled, []);
  f.market.account.openOrders[0].orderTime = new Date(startedAt - 60000).toISOString();
  f.task.currentOrderTracking.fresh.startedAt = startedAt - 60000;
  await cycle();
  assert.deepEqual(f.cancelled, [], "one minute is still inside this order's fill window");
  f.market.account.openOrders[0].orderTime = new Date(startedAt - 120001).toISOString();
  f.task.currentOrderTracking.fresh.startedAt = startedAt - 120001;
  await cycle();
  assert.deepEqual(f.cancelled, ["fresh"]);
});

for (const side of ["LONG", "SHORT"]) test(`${side}: loss beyond 3 points rescues and preserves the original despite an AI stop`, async () => {
  const f = setup(`no-fixed-loss-${side}`, [{ ...long("loss", 2), side, orderPrice: side === "LONG" ? 110 : 101 }]);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "loss", heldSide: side, quantity: 2, validForSec: 300,
    stopLossPrice: side === "LONG" ? 105 : 106, rationale: "真实反向持续且恢复路径失效" }] }, f.market, f.task).plans;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitType, null);
  assert.equal(f.task.pendingAction.source, "rescue_loss_points");
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["loss"]);
});

test("legacy persisted fixed-amount stops cannot be confirmed after upgrade", async () => {
  const f = setup("retired-pending-stop", [{ ...long("loss"), orderPrice: 110 }]);
  f.task.pendingAction = buildPendingAction(f.task, { action: "SELL", exitType: "STOP_LOSS", targetSymbol: "DGKZ", targetPositionIds: ["loss"],
    exitGuard: { positionAmount: { threshold: -3 } } });
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /FIXED_AMOUNT_STOP_RETIRED/);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.pendingAction.status, "REJECTED");
});

for (const side of ["LONG", "SHORT"]) test(`${side}: two rescue orders block a third and ordinary entries even after restart`, async () => {
  const f = setup(`repeat-rescue-${side}`, [{ ...long("original"), side, orderPrice: side === "LONG" ? 108 : 102, roundTripFee: 0 }], { autoDecisionEnabled: true });
  const decision = { action: side === "LONG" ? "SELL" : "BUY", marketRegime: side === "LONG" ? "DOWN" : "UP", entryPurpose: "RESCUE",
    rescuePositionIds: ["original"], targetSymbol: "DGKZ", bullishProfitProbability: 0.6, bearishProfitProbability: 0.6 };
  f.task.pendingAction = buildPendingAction(f.task, decision);
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    f.submitted.push(input);
    f.market.account.positions.push({ ...long(`rescue-${f.submitted.length}`), side: side === "LONG" ? "SHORT" : "LONG", orderPrice: side === "LONG" ? 105 : 106, roundTripFee: 0 });
    return { ok: true, submitted: true };
  } };
  await confirmPendingAction(f.task.id, { source: "auto_timeout", runtime });
  assert.throws(() => buildPendingAction(f.task, decision), /RESCUE_ALREADY_PENDING/);
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.rescueSession.status, "ACTIVE");
  assert.equal(f.submitted.length, 2);
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.pendingAction.status, "CONFIRMED");
  assert.throws(() => buildPendingAction(f.task, decision), /RESCUE_ENTRY_LOCKED/);
  f.task.rescueSession = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime(f.task)))).rescueSession;
  f.market.orderBook = { bids: [{ price: side === "LONG" ? 104.8 : 105.2, volume: 100 }], asks: [{ price: side === "LONG" ? 105.8 : 106.2, volume: 100 }] };
  f.market.observedAt = new Date().toISOString();
  assert.throws(() => buildPendingAction(f.task, decision), /RESCUE_ENTRY_LOCKED/);
  assert.throws(() => buildPendingAction(f.task, { ...decision, entryPurpose: "NORMAL" }), /RESCUE_ENTRY_LOCKED/);
  f.task.rescueSession.status = "EXITING";
  assert.throws(() => buildPendingAction(f.task, decision), /RESCUE_EXIT_IN_PROGRESS/);
  assert.throws(() => buildPendingAction(f.task, { ...decision, entryPurpose: "NORMAL" }), /RESCUE_EXIT_IN_PROGRESS/);
});

for (const purpose of ["NORMAL", "RESCUE"]) test(`${purpose}: account break-even exits require a tagged and confirmed rescue fill`, async () => {
  const f = setup(`confirmed-rescue-zero-${purpose}`, [{ ...long("original"), orderPrice: 100.5, roundTripFee: 0.1 }], { autoDecisionEnabled: true });
  f.market.orderBook = { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] };
  f.task.pendingAction = buildPendingAction(f.task, { action: "SELL", marketRegime: "DOWN", targetSymbol: "DGKZ", entryPurpose: purpose,
    rescuePositionIds: ["original"], bullishProfitProbability: 0.5, bearishProfitProbability: 0.6 });
  await confirmPendingAction(f.task.id, { source: "auto_timeout", runtime: { ...f.runtime, submitSuggestionForm: async () => ({ ok: true, submitted: true }) } });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.rescueSession, undefined, "intent is not a filled rescue");
  f.market.account.positions.push({ ...long("rescue"), side: "SHORT", orderPrice: 100.8, roundTripFee: 0.1 });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  if (purpose === "NORMAL") {
    assert.equal(f.task.rescueSession, undefined);
    assert.deepEqual(f.submitted, []);
  } else {
    assert.equal(f.task.rescueSession.status, "ACTIVE", "one rescue cannot trigger the new three-leg recovery");
    assert.equal(f.task.pendingAction.rescueTrigger.rescueOrderNumber, 2);
    f.market.account.positions.push({ ...long("rescue-2"), side: "SHORT", orderPrice: 100, roundTripFee: 0.1 });
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.task.rescueSession.status, "EXITING");
    assert.ok(Math.abs(f.task.rescueSession.netPnl) < 1e-10);
    const exits = f.submitted.filter(p => p.exitType);
    assert.deepEqual(exits.map(p => p.targetPositionIds[0]), ["original", "rescue", "rescue-2"]);
    assert.ok(exits.every(p => p.exitGuard.rescueRecovery));
    await runPositionExitCycle(f.task.id, { runtime: f.runtime });
    assert.equal(f.task.rescueSession.status, "COMPLETE");
    assert.equal(f.submitted.length, 4);
  }
});

test("partial rescue fill remains active after cancellation of its aged remainder", async () => {
  const f = setup("partial-rescue-cancel", [{ ...long("original"), orderPrice: 108, roundTripFee: 0 }], { autoDecisionEnabled: true, entryQuantity: 2 });
  f.task.pendingAction = buildPendingAction(f.task, { action: "SELL", marketRegime: "DOWN", targetSymbol: "DGKZ", entryPurpose: "RESCUE", rescuePositionIds: ["original"], bullishProfitProbability: 0.5, bearishProfitProbability: 0.6 });
  await confirmPendingAction(f.task.id, { source: "auto_timeout", runtime: { ...f.runtime, submitSuggestionForm: async () => ({ ok: true, submitted: true }) } });
  f.task.pendingAction.entrustedOrderIds = ["remainder"];
  f.market.account.positions.push({ ...long("rescue"), side: "SHORT", orderPrice: 105, roundTripFee: 0 });
  f.market.account.openOrders = [{ orderId: "remainder", remainingQuantity: 1, orderTime: new Date(Date.now() - 121000).toISOString() }];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.cancelled, ["remainder"]);
  assert.equal(f.task.pendingAction.rescueTrigger.rescueOrderNumber, 2, "after auditing a partial first order, complete the second order once");
  assert.equal(f.task.rescueSession.status, "ACTIVE");
  assert.deepEqual(f.task.rescueSession.rescuePositionIds, ["rescue"]);
});

test("recovery liquidation retries failed losing legs after the profitable leg fills", async () => {
  const f = setup("rescue-retry-loss", [{ ...long("winner"), orderPrice: 101, roundTripFee: 0 }, { ...long("loser"), orderPrice: 109, roundTripFee: 0 }]);
  f.task.rescueSession = { status: "ACTIVE", originalPositionIds: ["loser"], rescuePositionIds: ["winner"] };
  let fail = true;
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    if (input.targetPositionIds.includes("loser") && fail) throw new Error("FIXTURE_CLICK_FAILED");
    return f.runtime.submitSuggestionForm(input);
  } };
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.rescueSession.status, "EXITING");
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["loser"]);
  fail = false;
  await runPositionExitCycle(f.task.id, { runtime });
  assert.deepEqual(f.submitted.map(p => p.targetPositionIds[0]), ["winner", "loser"]);
  assert.ok(f.task.rescueSession.netPnl < 0);
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.rescueSession.status, "COMPLETE");
});

test("an unnecessary repeat rescue is blocked without pausing monitoring or losing the AI forecast", async () => {
  const f = setup("repeat-rescue-keeps-monitoring", [{ ...long("original"), orderPrice: 108, roundTripFee: 0 }]);
  f.task.rescueSession = { status: "ACTIVE", originalPositionIds: ["original"], rescuePositionIds: ["old-rescue"],
    lastRescueByPosition: { original: { lossPoints: 3, entryPrice: 108, heldSide: "LONG" } } };
  const result = await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "SELL", marketRegime: "DOWN", targetSymbol: "DGKZ", entryPurpose: "RESCUE", rescuePositionIds: ["original"],
      bullishProfitProbability: 0.3, bearishProfitProbability: 0.7, riskFlags: [], evidenceIds: [], analysisSummary: "主判断：偏跌" }),
    fillSuggestionForm: async () => assert.fail("must not prepare a duplicate rescue"),
  } });
  assert.equal(result.execution.code, "RESCUE_ENTRY_LOCKED");
  assert.equal(f.task.status, "MONITORING");
  assert.equal(f.task.lastAnalysisSucceeded, true);
  assert.equal(f.task.decision.analysisSummary, "主判断：偏跌");
});

test("rescue submission uses the fresh rechecked book after a slow analysis", async () => {
  const f = setup("rescue-fresh-book", [{ ...long("original"), orderPrice: 108, roundTripFee: 0 }], { autoDecisionEnabled: true });
  f.market.observedAt = new Date(Date.now() - 6000).toISOString();
  const result = await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "SELL", marketRegime: "DOWN", targetSymbol: "DGKZ", entryPurpose: "RESCUE", rescuePositionIds: ["original"],
      bullishProfitProbability: 0.3, bearishProfitProbability: 0.7, riskFlags: [], evidenceIds: [] }),
  } });
  assert.equal(result.analysisTriggered, true);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.task.pendingAction.entryPurpose, "RESCUE");
  assert.ok(Date.parse(f.task.pendingAction.rescueLossReferences.original.observedAt) > Date.parse(f.market.observedAt));
});

for (const side of ["LONG", "SHORT"]) for (const loss of [2.99, 3, 10]) test(`${side} host rescue at ${loss} points ignores AI HOLD, regime and manual entry mode`, async () => {
  const original = { ...long("original", 2), side, orderPrice: side === "LONG" ? 105 + loss : 106 - loss };
  const f = setup(`host-rescue-${side}-${loss}`, [original], { entryQuantity: 2, decision: { action: "HOLD", marketRegime: "UNKNOWN" } });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, loss >= 3 ? 1 : 0);
  assert.deepEqual(f.market.account.positions, [original]);
  if (loss < 3) return;
  assert.equal(f.submitted[0].action, side === "LONG" ? "SELL" : "BUY");
  assert.equal(f.submitted[0].price, side === "LONG" ? 105 : 106);
  assert.equal(f.submitted[0].quantity, 2);
  assert.equal(f.submitted[0].exitType, null);
  assert.deepEqual(f.task.pendingAction.rescuePositionIds, ["original"]);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1, "unknown submission must not be duplicated");
});

test("automatic rescue retries a definite click failure and survives persistence", async () => {
  const f = setup("rescue-retry", [{ ...long("original"), orderPrice: 115 }]);
  let calls = 0;
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    calls++;
    if (calls === 1) return { ok: false, submitted: false, code: "SUBMIT_BUTTON_NOT_FOUND" };
    return f.runtime.submitSuggestionForm(input);
  } };
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.pendingAction.status, "WAITING");
  f.task.pendingAction = compactTaskRuntime(f.task).pendingAction;
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(calls, 2);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.task.pendingAction.status, "AWAITING_FILL");
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["original"]);
});

test("automatic rescue completes two orders and never appends a third after further loss", async () => {
  const f = setup("rescue-repeat-host", [{ ...long("original"), orderPrice: 108 }]);
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    f.submitted.push(input);
    f.market.account.positions.push({ ...long(`hedge-${f.submitted.length}`), side: "SHORT", orderPrice: input.price });
    return { ok: true, submitted: true };
  } };
  await runPositionExitCycle(f.task.id, { runtime });
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 2);
  assert.equal(f.task.rescueSession.status, "ACTIVE");
  f.market.orderBook.bids[0].price = 104.9;
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 2);
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 2);
  f.market.orderBook = { bids: [{ price: 108, volume: 100 }], asks: [{ price: 109, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.filter(s => !s.exitType).length, 2);
});

test("AI HOLD cannot cancel an automatic rescue while its browser submission is in flight", async () => {
  const f = setup("rescue-model-overlap", [{ ...long("original"), orderPrice: 108 }]);
  let releaseModel, modelStarted, releaseWrite, writeStarted;
  const modelReady = new Promise(resolve => { modelStarted = resolve; });
  const writeReady = new Promise(resolve => { writeStarted = resolve; });
  const analysis = runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => structuredClone(f.market),
    requestDecision: async () => { modelStarted(); return new Promise(resolve => { releaseModel = resolve; }); },
  } });
  await modelReady;
  const rescue = runPositionExitCycle(f.task.id, { runtime: { ...f.runtime, submitSuggestionForm: async input => {
    f.submitted.push(input); writeStarted(); return new Promise(resolve => { releaseWrite = resolve; });
  } } });
  await writeReady;
  const pendingId = f.task.pendingAction.id;
  f.task.pendingAction.createdAt = new Date(Date.now() - 120000).toISOString();
  releaseModel({ action: "HOLD", riskFlags: [], evidenceIds: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.task.pendingAction.id, pendingId);
  assert.equal(f.task.pendingAction.status, "SUBMITTING");
  releaseWrite({ ok: true, submitted: true });
  await Promise.all([rescue, analysis]);
  assert.equal(f.task.pendingAction.status, "AWAITING_FILL");
  assert.equal(f.submitted.length, 1);
});

test("rescue transport interruption remains unverified instead of creating duplicate orders", async () => {
  const f = setup("rescue-transport", [{ ...long("original"), orderPrice: 108 }]);
  let calls = 0;
  const runtime = { ...f.runtime, submitSuggestionForm: async () => { calls++; throw new Error("DESKTOP_DISCONNECTED_AFTER_DISPATCH"); } };
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.pendingAction.status, "UNVERIFIED");
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(calls, 1);
});

test("an unknown second rescue stays locked across restart and is never replaced by a third", async () => {
  const f = setup("second-rescue-transport", [{ ...long("original"), orderPrice: 108, roundTripFee: 0 }]);
  let calls = 0;
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    calls++;
    f.market.account.positions.push({ ...long(`rescue-${calls}`), side: "SHORT", orderPrice: input.price, roundTripFee: 0 });
    if (calls === 2) throw new Error("DESKTOP_DISCONNECTED_AFTER_DISPATCH");
    return { ok: true, submitted: true };
  } };
  await runPositionExitCycle(f.task.id, { runtime });
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(calls, 2);
  assert.equal(f.task.pendingAction.status, "UNVERIFIED");
  Object.assign(f.task, JSON.parse(JSON.stringify(compactTaskRuntime(f.task))));
  for (let i = 0; i < 3; i++) await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(calls, 2);
  assert.equal(f.task.pendingAction.status, "CONFIRMED");
  assert.equal(f.task.rescueSession.groups[0].rescueOrders.length, 2);
  assert.throws(() => buildPendingAction(f.task, { action: "BUY", targetSymbol: "DGKZ" }), /RESCUE_ENTRY_LOCKED/);
});

for (const side of ["LONG", "SHORT"]) test(`${side} rescue group ignores ordinary single-leg profit without an AI plan`, async () => {
  const original = { ...long("original", 2), side, orderPrice: side === "LONG" ? 104 : 100, roundTripFee: 0 };
  const hedge = { ...long("rescue", 2), side: side === "LONG" ? "SHORT" : "LONG", orderPrice: 102, roundTripFee: 0 };
  const f = setup(`rescue-profit-per-unit-${side}`, [original, hedge], { rescueSession: { status: "ACTIVE", originalPositionIds: ["original"], rescuePositionIds: ["rescue"],
    lastRescueByPosition: { original: { lossPoints: 4, entryPrice: original.orderPrice, heldSide: side } } } });
  f.market.orderBook = { bids: [{ price: side === "LONG" ? 100 : 103, volume: 100 }], asks: [{ price: side === "LONG" ? 101 : 104, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.ok(f.task.rescueSession.netPnl < 0);
  assert.equal(f.submitted.length, 0);
  f.market.account.positions.push({ ...long("ordinary"), orderPrice: side === "LONG" ? 99 : 102, roundTripFee: 0 });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 0);
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["original", "rescue", "ordinary"]);
});

test("an earlier queued individual profit exit cannot close a newly confirmed rescue group leg", async () => {
  const f = setup("queued-rescue-profit", [{ ...long("rescue"), roundTripFee: 0 }]);
  f.task.pendingAction = buildPendingAction(f.task, { action: "SELL", exitType: "TAKE_PROFIT", targetSymbol: "DGKZ", targetPositionIds: ["rescue"] });
  f.task.rescueSession = { status: "ACTIVE", originalPositionIds: ["original"], rescuePositionIds: ["rescue"], netPnl: -2 };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /RESCUE_GROUP_EXIT_HELD/);
  assert.equal(f.submitted.length, 0);
});

test("AI batch profit exits retain only ordinary holdings and matching browser guards during rescue", async () => {
  const positions = [
    { ...long("original"), side: "SHORT", orderPrice: 90, roundTripFee: 0 },
    { ...long("rescue"), roundTripFee: 0 }, { ...long("ordinary"), roundTripFee: 0 },
  ];
  const f = setup("rescue-mixed-profit", positions, { autoDecisionEnabled: true, rescueSession: { status: "ACTIVE",
    originalPositionIds: ["original"], rescuePositionIds: ["rescue"], lastRescueByPosition: { original: { lossPoints: 16, entryPrice: 90, heldSide: "SHORT" } } } });
  await runAnalysis(f.task.id, "", { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "SELL", exitType: "TAKE_PROFIT", targetSymbol: "DGKZ", targetPositionIds: ["rescue", "ordinary"], riskFlags: [], evidenceIds: [],
      exitPlans: ["rescue", "ordinary"].map(positionId => ({ positionId, heldSide: "LONG", quantity: 1, validForSec: 300, takeProfitPrice: 101 })) }),
  } });
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.submitted[0].targetPositionIds, ["ordinary"]);
  assert.deepEqual(f.submitted[0].exitGuard.positions.map(p => p.positionId), ["ordinary"]);
  assert.deepEqual(f.market.account.positions.map(p => p.positionOrderId), ["original", "rescue"]);
});

test("an initial batch of n losing holdings receives exactly 2n opposite rescues, then all new entries stay locked", async () => {
  const originals = Array.from({ length: 3 }, (_, i) => ({ ...long(`original-${i}`), orderPrice: 108 + i, roundTripFee: 0 }));
  const f = setup("initial-rescue-batch", originals);
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    f.submitted.push(input);
    f.market.account.positions.push({ ...long(`hedge-${f.submitted.length}`), side: "SHORT", orderPrice: input.price, roundTripFee: 0 });
    return { ok: true, submitted: true };
  } };
  for (let i = 0; i < 8; i++) await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 6);
  assert.ok(f.submitted.every(input => input.action === "SELL" && input.quantity === 1 && !input.exitType));
  assert.equal(f.market.account.positions.length, 9);
  assert.equal(f.task.rescueSession.originalPositionIds.length, 3);
  assert.ok(f.task.rescueSession.groups.every(g => g.rescueOrders.length === 2 && g.rescuePositionIds.length === 2));
  f.market.orderBook.bids[0].price = 90;
  for (let i = 0; i < 3; i++) await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 6);
  const result = await runAnalysis(f.task.id, "", { runtime: { ...runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "BUY", targetSymbol: "DGKZ", marketRegime: "UP", bullishProfitProbability: 0.7, bearishProfitProbability: 0.3, riskFlags: [], evidenceIds: [] }),
    fillSuggestionForm: async () => assert.fail("rescue lock must prevent even filling a new entry form"),
  } });
  assert.equal(result.execution.code, "RESCUE_ENTRY_LOCKED");
  assert.equal(f.task.status, "MONITORING");
});

test("an older ordinary entry cannot be confirmed after a rescue starts", async () => {
  const f = setup("queued-normal-during-rescue", [long("original")], { autoDecisionEnabled: true });
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", targetSymbol: "DGKZ", marketRegime: "UP", bullishProfitProbability: 0.7, bearishProfitProbability: 0.3 });
  f.task.rescueSession = { status: "ACTIVE", originalPositionIds: ["original"], rescuePositionIds: ["rescue"] };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /RESCUE_ENTRY_LOCKED/);
  assert.equal(f.submitted.length, 0);
});

test("each three-order group recovers independently while ordinary profit exits continue and entries stay locked", async () => {
  const f = setup("independent-three-leg-groups", [
    { ...long("original-a"), orderPrice: 108, roundTripFee: 0 },
    { ...long("original-b"), orderPrice: 114, roundTripFee: 0 },
  ]);
  const runtime = { ...f.runtime, submitSuggestionForm: async input => {
    if (input.exitType) return f.runtime.submitSuggestionForm(input);
    f.submitted.push(input);
    f.market.account.positions.push({ ...long(`rescue-${f.submitted.length}`), side: "SHORT", orderPrice: input.price, roundTripFee: 0 });
    return { ok: true, submitted: true };
  } };
  for (let i = 0; i < 6; i++) await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.submitted.length, 4);
  const [a, b] = ["original-a", "original-b"].map(id => f.task.rescueSession.groups.find(g => g.originalPositionIds.includes(id)));
  f.market.orderBook = { bids: [{ price: 100, volume: 100 }], asks: [{ price: 101, volume: 100 }] };
  f.market.account.positions.push({ ...long("ordinary"), side: "\u5356\u51fa", orderPrice: 103, roundTripFee: 0 });
  f.market.account.realtimeValueChange = -999;
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(a.status, "EXITING");
  assert.equal(a.triggerNetPnl, 0);
  assert.equal(b.status, "ACTIVE");
  assert.equal(b.netPnl, -6);
  assert.deepEqual(f.submitted.filter(p => p.exitType).map(p => p.targetPositionIds[0]).sort(),
    ["original-a", ...a.rescuePositionIds].sort());
  assert.ok(f.market.account.positions.every(p => ["original-b", ...b.rescuePositionIds, "ordinary"].includes(p.positionOrderId)));
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(a.status, "COMPLETE");
  const normal = { action: "BUY", targetSymbol: "DGKZ", marketRegime: "UP", bullishProfitProbability: 0.7, bearishProfitProbability: 0.3 };
  assert.throws(() => buildPendingAction(f.task, normal), /RESCUE_ENTRY_LOCKED/);
  f.market.orderBook = { bids: [{ price: 94, volume: 100 }], asks: [{ price: 95, volume: 100 }] };
  await runPositionExitCycle(f.task.id, { runtime });
  await runPositionExitCycle(f.task.id, { runtime });
  assert.equal(f.task.rescueSession.status, "COMPLETE");
  assert.doesNotThrow(() => buildPendingAction(f.task, normal));
  assert.equal(f.submitted.filter(p => !p.exitType).length, 4);
});

test("startup opposing positions lock entries until every leg and order clears, then permit a fresh rescue cycle", async () => {
  const f = setup("startup-rescue-then-next-cycle", [
    { ...long("initial-long"), orderPrice: 108, roundTripFee: 0 },
    { ...long("initial-short"), side: "SHORT", orderPrice: 105, roundTripFee: 0 },
  ], { rescueStartupScanned: false });
  const normal = { action: "BUY", targetSymbol: "DGKZ", marketRegime: "UP", bullishProfitProbability: 0.7, bearishProfitProbability: 0.3 };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.rescueSession.source, "startup_positions");
  assert.equal(f.submitted.length, 0);
  assert.throws(() => buildPendingAction(f.task, normal), /RESCUE_ENTRY_LOCKED/);
  f.market.account.positions = [f.market.account.positions[0]];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.throws(() => buildPendingAction(f.task, normal), /RESCUE_ENTRY_LOCKED/);
  f.market.account.positions = [];
  f.market.account.openOrders = [{ orderId: "still-open", remainingQuantity: 1 }];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.throws(() => buildPendingAction(f.task, normal), /RESCUE_ENTRY_LOCKED/);
  f.market.account.openOrders = [];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.rescueSession.status, "COMPLETE");
  assert.doesNotThrow(() => buildPendingAction(f.task, normal));
  f.market.account.positions = [{ ...long("next-original"), orderPrice: 110 }];
  await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime, submitSuggestionForm: async input => {
    f.submitted.push(input);
    return { ok: true, submitted: true };
  } } });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.task.pendingAction.entryPurpose, "RESCUE");
  assert.deepEqual(f.task.pendingAction.rescueBatchPositionIds, ["next-original"]);
  assert.throws(() => buildPendingAction(f.task, normal), /RESCUE_ENTRY_LOCKED/);
});
