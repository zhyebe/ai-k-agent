import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { runAnalysis, runPositionExitCycle, startController, stopController } from "../server/engine.mjs";
import { state } from "../server/store.mjs";

function setup(t) {
  const id = `login-${t.name}`;
  const task = { id, ownerUserId: "login-owner", mode: "LIVE", autoDecisionEnabled: true,
    status: "MONITORING", monitoringEnabled: true, stopLocked: false, monitorGeneration: 0,
    target: { type: "website", connectorId: "connector_haohan_readonly", adapterId: "haohan-readonly", browserSessionId: id,
      url: "https://smyw.haohandahan.cn/client/#/transcc", credentialRef: "stored-credential" },
    rules: [], workflow: [], metrics: {}, decision: { action: "HOLD", evidenceIds: [], riskFlags: [] } };
  const position = { positionOrderId: "P1", symbol: "DGKZ", side: "买入", quantity: 1, frozenQuantity: 0, orderPrice: 100 };
  const market = { ok: true, symbol: "DGKZ", timeframe: "1m", observedAt: new Date().toISOString(),
    source: "test", evidenceId: "market:test", fingerprint: id, history: [], historyCount: 0, books: [], indicators: {},
    latest: { price: 103 }, quote: { price: 103 }, orderBook: { bids: [{ price: 103, volume: 10 }], asks: [{ price: 104, volume: 10 }] },
    account: { positionsVerified: true, positions: [position], openOrdersVerified: true, openOrders: [{ orderTime: "2020-01-01T00:00:00Z", orderId: "O1", remainingQuantity: 1 }], availableFunds: 10000 } };
  task.market = market;
  state.tasks.unshift(task);
  t.after(() => { stopController(id); state.tasks = state.tasks.filter(item => item !== task); });
  const calls = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    browserLogin: async input => { calls.push("login"); assert.equal(input.credentialRef, "stored-credential"); assert.equal(input.submit, true); return { ok: true, authenticated: true }; },
    observeMarket: async () => market,
    observeExecutionMarket: async () => market,
    requestDecision: async (_provider, context) => {
      calls.push("analyze");
      assert.equal(context.account.positions[0].positionOrderId, "P1");
      assert.deepEqual(context.account.openOrders, []);
      return { action: "HOLD", riskFlags: [], evidenceIds: [], orderAssessments: [{ orderId: "O1", decision: "KEEP" }] };
    },
    cancelOpenOrders: async () => { calls.push("cancel"); market.account.openOrders = []; return { ok: true, results: [{ orderId: "O1", cancelled: true }] }; },
    submitSuggestionForm: async () => { calls.push("submit"); return { ok: true, submitted: true }; },
  };
  return { task, market, runtime, calls };
}
const expired = { ok: false, code: "REAUTH_REQUIRED", message: "登录已过期" };

test("expiry during collection reauthenticates and reads fresh positions/orders in the same cycle", async t => {
  const f = setup(t);
  let reads = 0;
  f.runtime.observeMarket = async () => { f.calls.push("read"); return ++reads === 1 ? expired : f.market; };
  await runAnalysis(f.task.id, "", { runtime: f.runtime });
  assert.deepEqual(f.calls, ["read", "login", "read", "cancel", "analyze"]);
  assert.equal(f.task.target.loginStatus, "authenticated");
  assert.equal(f.task.monitoringEnabled, true);
});

test("fast position monitor recovers login and executes the still-valid AI exit without waiting for another analysis", async t => {
  const f = setup(t);
  f.market.account.positions[0].roundTripFee = 2; // Net profit is 1; profit realization must also survive login recovery.
  f.task.exitPlans = [{ positionId: "P1", heldSide: "LONG", quantity: 1, entryPrice: 100, takeProfitPrice: 102,
    status: "ARMED", expiresAt: new Date(Date.now() + 60000).toISOString() }];
  let reads = 0;
  f.runtime.observeExecutionMarket = async () => { f.calls.push("read"); return ++reads === 1 ? expired : f.market; };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.calls, ["read", "login", "read", "cancel", "read", "submit"]);
  assert.equal(f.task.lastPositionAudit.positions[0].positionId, "P1");
});

for (const entryPrice of [102, 102.01, 106, 105.99]) test(`fast position monitor recovers login and rechecks price-point profit and amount stop without an AI plan: entry ${entryPrice}`, async t => {
  const f = setup(t);
  f.market.account.positions[0].orderPrice = entryPrice;
  let reads = 0, submitted;
  f.runtime.observeExecutionMarket = async () => { f.calls.push("read"); return ++reads === 1 ? expired : f.market; };
  f.runtime.submitSuggestionForm = async input => { f.calls.push("submit"); submitted = input; return { ok: true, submitted: true }; };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  if (entryPrice === 102) {
    assert.deepEqual(f.calls, ["read", "login", "read", "cancel", "read", "submit"]);
    assert.equal(submitted.exitType, entryPrice === 102 ? "TAKE_PROFIT" : "STOP_LOSS");
    assert.deepEqual(submitted.targetPositionIds, ["P1"]);
    assert.equal((submitted.exitGuard.positionPoints || submitted.exitGuard.positionAmount).threshold, entryPrice === 102 ? 1 : -3);
  } else {
    assert.deepEqual(f.calls, ["read", "login", "read", "cancel", "read"]);
    assert.equal(submitted, undefined);
  }
});

test("simultaneous collection and exit expiry share one automatic login", async t => {
  const f = setup(t);
  let finishLogin, loginStarted;
  const started = new Promise(resolve => { loginStarted = resolve; });
  const complete = new Promise(resolve => { finishLogin = resolve; });
  let authenticated = false;
  f.runtime.browserLogin = async () => { f.calls.push("login"); loginStarted(); await complete; authenticated = true; return { ok: true, authenticated: true }; };
  f.runtime.observeMarket = f.runtime.observeExecutionMarket = async () => authenticated ? f.market : expired;
  const analysis = runAnalysis(f.task.id, "", { runtime: f.runtime });
  await started;
  const exit = runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await new Promise(resolve => setImmediate(resolve));
  finishLogin();
  await Promise.all([analysis, exit]);
  assert.equal(f.calls.filter(call => call === "login").length, 1);
  assert.ok(f.calls.includes("analyze"));
});

test("failed reauthentication keeps monitoring enabled and never analyzes stale account data", async t => {
  const f = setup(t);
  f.runtime.observeMarket = async () => expired;
  f.runtime.browserLogin = async () => { f.calls.push("login"); return { ok: false, code: "LOGIN_NOT_CONFIRMED" }; };
  await runAnalysis(f.task.id, "", { runtime: f.runtime });
  assert.deepEqual(f.calls, ["login"]);
  assert.equal(f.task.monitoringEnabled, true);
  assert.equal(f.task.stopLocked, false);
  assert.ok(f.task.nextPollAt);
});

test("a second expiry is retried next cycle, without unbounded login loops", async t => {
  const f = setup(t);
  f.runtime.observeMarket = async () => expired;
  await runAnalysis(f.task.id, "", { runtime: f.runtime });
  assert.deepEqual(f.calls, ["login"]);
  assert.equal(f.task.monitoringEnabled, true);
  assert.ok(f.task.nextPollAt);
});

test("relogin during slow analysis discards old-session actions and resumes with fresh account data", async t => {
  const f = setup(t);
  f.market.account.positions[0].orderPrice = 102.5; // Profit below 1 isolates stale-session entry/cancel behavior.
  let first = true;
  f.runtime.requestDecision = async () => {
    if (first) {
      first = false;
      let reads = 0;
      await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime,
        observeExecutionMarket: async () => ++reads === 1 ? expired : f.market,
      } });
    }
    return { action: "BUY", marketRegime: "UP", bullishProfitProbability: 0.65, bearishProfitProbability: 0.3,
      targetSymbol: "DGKZ", riskFlags: [], evidenceIds: [], cancelOrderIds: ["O1"] };
  };
  f.runtime.cancelOpenOrders = async () => { f.calls.push("cancel"); f.market.account.openOrders = []; return { ok: true, results: [{ orderId: "O1", cancelled: true }] }; };
  const stale = await runAnalysis(f.task.id, "", { runtime: f.runtime });
  assert.equal(stale.execution.code, "SESSION_CHANGED_DURING_ANALYSIS");
  assert.deepEqual(f.calls, ["cancel", "login"]);
  await runAnalysis(f.task.id, "", { runtime: f.runtime });
  assert.deepEqual(f.calls, ["cancel", "login", "submit"]);
});

test("fast relogin wakes analysis immediately instead of retaining an old retry backoff", async t => {
  const f = setup(t);
  f.task.monitorFailureCount = 7;
  f.task.nextPollAt = new Date(Date.now() + 120000).toISOString();
  let ran = false, done;
  const resumed = new Promise(resolve => { done = resolve; });
  startController(f.task.id, { runtime: f.runtime, runCycle: async () => {
    ran = true;
    stopController(f.task.id);
    done();
  } });
  let reads = 0;
  await runPositionExitCycle(f.task.id, { runtime: { ...f.runtime,
    observeExecutionMarket: async () => ++reads === 1 ? expired : f.market,
  } });
  let timer;
  await Promise.race([resumed, new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
  clearTimeout(timer);
  assert.equal(ran, true);
  assert.equal(f.task.monitorFailureCount, 0);
});
