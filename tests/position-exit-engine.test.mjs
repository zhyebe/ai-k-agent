import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { buildPendingAction, confirmPendingAction, runAnalysis, runPositionExitCycle, startTask, stopAllControllers, stopController, stopTask } from "../server/engine.mjs";
import { validateExitPlans } from "../server/exit-policy.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";
import { state } from "../server/store.mjs";

afterEach(stopAllControllers);

function setup(id, positions, extras = {}) {
  const now = Date.now();
  const history = Array.from({ length: 30 }, (_, i) => ({ timestamp: now - (29 - i) * 60000, open: 100, high: 106, low: 99, close: 105, volume: 10 }));
  const market = { ok: true, symbol: "DGKZ", symbolName: "测试商品", observedAt: new Date(now).toISOString(), source: "test", evidenceId: "market:test", fingerprint: id, history, historyCount: history.length, timeframe: "1m", quote: { price: 105 }, latest: { price: 105 }, account: { positionsVerified: true, positions, openOrdersVerified: true, openOrders: [], availableFunds: 10000 }, orderBook: { bids: [{ price: 105, volume: 100 }], asks: [{ price: 106, volume: 100 }] }, books: [], missingFields: [], indicators: {} };
  const task = { id, ownerUserId: "exit-test-owner", name: id, mode: "LIVE", autoDecisionEnabled: false, status: "MONITORING", monitoringEnabled: true, stopLocked: false, monitorGeneration: 0, riskProfile: "Balanced", target: { type: "website", url: "https://smyw.haohandahan.cn/client/#/transcc", connectorId: "connector_haohan_readonly", browserSessionId: `task:${id}` }, market, rules: [], workflow: [], metrics: { equity: 10000 }, decision: { action: "HOLD", riskFlags: [], evidenceIds: [], confidence: 0 }, ...extras };
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

test("closing clears all three long/short positions and verifies actual flatness next observation", async () => {
  const f = setup("closing-three", [long("P1"), long("P2", 2), { ...long("P3"), side: "卖出" }]);
  f.market.account.openOrders = [{ orderId: "entry-old", orderKind: "订立", remainingQuantity: 1 }];
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
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", bullishProfitProbability: 0.8 });
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
    f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", bullishProfitProbability: 0.8 });
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
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", bullishProfitProbability: 0.8 });
  f.market.account.openOrders = [{ orderId: "entry-pending", orderKind: "订立", remainingQuantity: 1 }];
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
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", bullishProfitProbability: 0.8 });
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

test("AI conditions execute independently while the model is waiting; its late entry cannot overwrite the exit", async () => {
  const f = setup("exit-while-ai", [long("P1")]);
  f.task.exitPlans = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: "LONG", quantity: 1, validForSec: 120, takeProfitPrice: 105, stopLossPrice: 99 }] }, f.market, f.task).plans;
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
  releaseModel({ action: "BUY", bullishProfitProbability: 0.9, bearishProfitProbability: 0.1, riskFlags: [], evidenceIds: ["market:test"], holdingPlan: { decision: "HOLD_FOR_TARGET" } });
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
  f.market.account.openOrders = [{ orderId: "O1", orderKind: "转让", remainingQuantity: 1, positionOrderId: "P2" }];
  const now = Date.parse("2026-10-13T15:56:00+08:00");
  await runPositionExitCycle(f.task.id, { now, runtime: { ...f.runtime, cancelOpenOrders: async () => ({ ok: false, results: [] }) } });
  assert.deepEqual(f.submitted.map(s => s.targetPositionIds[0]), ["P1"]);
  assert.equal(f.task.sessionCloseState.status, "CLOSING");
  assert.equal(f.task.sessionCloseState.remainingOrders, 1);
});

test("a cancellation transport error still refreshes the account and closes free positions", async () => {
  const f = setup("closing-cancel-error", [long("P1"), { ...long("P2"), frozenQuantity: 1 }]);
  f.market.account.openOrders = [{ orderId: "O1", orderKind: "转让", positionOrderId: "P2" }];
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
  f.market.account.openOrders = [{ orderId: "O1", orderKind: "订立" }];
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
  f.task.pendingAction = buildPendingAction(f.task, { action: "BUY", bullishProfitProbability: 0.8 });
  let input;
  await runAnalysis(f.task.id, "", { runtime: {
    ...f.runtime, openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    continueManualEntry: async value => { input = value; return { ok: false, continued: false, code: "SESSION_CLOSING_NO_ENTRY" }; },
    observeMarket: async () => f.market,
    requestDecision: async () => ({ action: "BUY", bullishProfitProbability: 0.8, bearishProfitProbability: 0.2, riskFlags: [], evidenceIds: ["market:test"] }),
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
      assert.equal(f.submitted[0].exitType, ending);
      assert.equal(f.submitted[0].action, side === "LONG" ? "SELL" : "BUY");
      assert.deepEqual(f.submitted[0].targetPositionIds, [p.positionOrderId]);
      await runPositionExitCycle(f.task.id, { runtime: f.runtime });
      assert.equal(f.submitted.length, 1);
    });
  }
}
