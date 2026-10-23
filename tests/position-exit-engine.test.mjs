import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildPendingAction, confirmPendingAction, runAnalysis, runPositionExitCycle, startTask, stopAllControllers, stopController, stopTask } from "../server/engine.mjs";
import { exitNetPnl, validateExitPlans } from "../server/exit-policy.mjs";
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
  test(`${automatic ? "automatic" : "manual"} ${heldSide} ${regime}: AI rescue entry preserves the original and leaves exits to summary monitoring`, async () => {
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

    assert.deepEqual(f.task.exitPlans, []);
  });
}

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
