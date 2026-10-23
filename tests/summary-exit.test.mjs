import './fixtures/open-market-clock.mjs';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { summaryExitCandidates, summaryKey, rescueForecastContexts, validateRescueExitForecast,
  RESCUE_FORECAST_AFTER_MS, RESCUE_FORECAST_HORIZON_MS } from '../server/summary-exit-policy.mjs';
import { parseHaohanAccount } from '../server/haohan.mjs';
import { automaticRescueCandidates } from '../server/rescue-policy.mjs';
import { compactTaskRuntime } from '../server/persistence.mjs';
import { runPositionExitCycle, stopAllControllers, confirmPendingAction, runAnalysis, stopTask } from '../server/engine.mjs';
import { state } from '../server/store.mjs';
// Explicit cycles own test progress; action completion must not start a real
// background controller while a deferred model promise is being resolved.
beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(stopAllControllers);
const row = (side = 'LONG', extra = {}) => ({ symbol: 'A', symbolName: '商品A', side, quantity: 3, frozenQuantity: 0, averagePrice: 100, realtimeValueChange: 0, ...extra });
const snapshot = (rows, bid = 100.5, ask = 100.6) => ({ ok: true, symbol: 'A', symbolName: '商品A', observedAt: new Date().toISOString(),
  account: { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: rows, openOrdersVerified: true, openOrders: [] },
  orderBook: { bids: [{ price: bid, volume: 100 }], asks: [{ price: ask, volume: 100 }] } });
const rescueTask = () => ({ rescueSession: { status: 'ACTIVE', originalPositionIds: ['original'], rescuePositionIds: ['hedge'] } });
function rescuedMarket(net) {
  const market = snapshot([row('LONG', { realtimeValueChange: -4 }), row('SHORT', { averagePrice: 102, realtimeValueChange: net + 4 })]);
  market.account.positions = [{ positionOrderId: 'original', symbol: 'A', symbolName: '商品A', side: 'LONG', quantity: 3, orderPrice: 100 }];
  return market;
}
for (const side of ['LONG', 'SHORT']) for (const points of [0.499999, 0.5, 1, 1.5]) {
  test(`${side} summary exits at ${points} points using average cost and whole-row quantity`, () => {
    const price = 100 + (side === 'LONG' ? points : -points);
    const result = summaryExitCandidates({}, snapshot([row(side)], price, price));
    assert.equal(result.length, points >= 0.5 ? 1 : 0);
    if (result.length) {
      assert.equal(result[0].decision.targetSummary.quantity, 3);
      assert.deepEqual(result[0].decision.targetPositionIds, []);
      assert.equal(result[0].decision.action, side === 'LONG' ? 'SELL' : 'BUY');
    }
  });
}
test('summary parser reads the actual platform headers and keeps unknown values unknown', () => {
  const tables = [{ kind: 'positionSummaries', rows: [['商品名称', '买 | 卖', '订立均价', '存货数量', '委托冻结数量', '实时货值变化'],
    ['商品A', '买入', '1,000.25', '3', '0', '-2.5'], ['商品A', '卖出', '1,001', '2', '0', '--']] }];
  const account = parseHaohanAccount('', tables);
  assert.equal(account.positionSummariesVerified, true);
  assert.equal(account.positionSummaries[0].averagePrice, 1000.25);
  assert.equal(account.positionSummaries[1].realtimeValueChange, null);
  assert.equal(parseHaohanAccount('', [{ ...tables[0], loading: true }]).positionSummariesVerified, false);
});
for (const fault of ['unverified', 'stale', 'frozen', 'quote']) test(`summary ${fault} cannot authorize an exit or a guessed detail fallback`, () => {
  const market = snapshot([row()]);
  if (fault === 'unverified') market.account.positionSummariesVerified = false;
  if (fault === 'stale') market.observedAt = new Date(Date.now() - 6000).toISOString();
  if (fault === 'frozen') market.account.positionSummaries[0].frozenQuantity = 1;
  if (fault === 'quote') market.orderBook = {};
  assert.deepEqual(summaryExitCandidates({}, market), []);
});
for (const net of [-1.01, -1, 0, 3]) test(`rescue commodity recovers at combined displayed amount ${net}`, () => {
  const task = rescueTask(), market = rescuedMarket(net);
  market.account.realtimeValueChange = net < -1 ? 999 : -999;
  const exits = summaryExitCandidates(task, market);
  assert.equal(exits.length, net >= -1 ? 2 : 0);
  if (exits.length) assert.equal(task.rescueSession.status, 'EXITING');
});
test('rescue recovery does not wait for missing fee fields, but requires each displayed summary amount', () => {
  const market = rescuedMarket(-1);
  market.account.positionSummaries[0].realtimeValueChange = null;
  assert.deepEqual(summaryExitCandidates(rescueTask(), market), []);
});
test('recovery latch survives restart and completes the losing side after the winning side fills', () => {
  const task = rescueTask(), market = rescuedMarket(-1);
  assert.equal(summaryExitCandidates(task, market).length, 2);
  const restored = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime(task))));
  market.account.positionSummaries = [row('LONG', { realtimeValueChange: -99 })];
  const remaining = summaryExitCandidates(restored, market);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].decision.exitGuard.recovery, true);
  market.account.positions = [];
  market.account.positionSummaries = [];
  summaryExitCandidates(restored, market);
  assert.equal(restored.rescueSession.status, 'COMPLETE');
});
for (const loss of [2.999, 3, 3.001]) test(`original ${loss}-point loss independently triggers rescue at 3`, () => {
  const market = snapshot([], 100 - loss, 100 - loss);
  market.account.positions = [{ positionOrderId: 'original', symbol: 'A', symbolName: '商品A', side: 'LONG', orderPrice: 100, quantity: 1 }];
  assert.equal(automaticRescueCandidates({}, market).length, loss >= 3 ? 1 : 0);
});
function engineFixture(id, market, extras = {}) {
  const task = { id, ownerUserId: 'summary-test', mode: 'LIVE', status: 'MONITORING', monitoringEnabled: true, stopLocked: false,
    rescueStartupScanned: true, monitorGeneration: 0, market, rules: [], workflow: [], metrics: {}, decision: { action: 'HOLD' },
    target: { browserSessionId: `task:${id}`, connectorId: 'connector_haohan_readonly', url: 'https://smyw.haohandahan.cn/client/#/transcc' }, ...extras };
  state.tasks.unshift(task);
  const submitted = [], cancelled = [];
  const runtime = { observeExecutionMarket: async () => ({ ...market, observedAt: new Date().toISOString() }),
    submitSuggestionForm: async input => { submitted.push(input); return { ok: true, submitted: true, submittedQuantity: input.quantity }; },
    cancelOpenOrders: async ({ orderIds }) => { cancelled.push(...orderIds); market.account.openOrders = []; return { ok: true, results: orderIds.map(orderId => ({ orderId, cancelled: true })) }; },
    requestDecision: async () => { throw Error('AI must not be called by summary exits'); } };
  return { task, runtime, submitted, cancelled };
}
test('engine submits one whole summary with no AI or detail IDs and deduplicates an unfilled transfer', async () => {
  const market = snapshot([row()]);
  const f = engineFixture('summary-once', market);
  const result = await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(result.submitted, [summaryKey(row())]);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].quantity, 3);
  assert.equal(f.submitted[0].targetSummary.averagePrice, 100);
  assert.deepEqual(f.submitted[0].targetPositionIds, []);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  market.account.positionSummaries = [];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'CONFIRMED');
});
test('engine cancels fresh rescue entry remainder before closing both summary rows', async () => {
  const market = rescuedMarket(-1);
  market.account.openOrders = [{ orderId: 'rescue-pending', symbol: 'A', symbolName: '商品A', side: 'SHORT', orderKind: '订立', remainingQuantity: 1, orderTime: new Date().toISOString(), quantity: 1, orderPrice: 100.6 }];
  const f = engineFixture('summary-rescue', market, rescueTask());
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.cancelled, ['rescue-pending']);
  assert.equal(f.submitted.length, 2);
  assert.deepEqual(f.submitted.map(s => s.targetSummary.side), ['LONG', 'SHORT']);
});
test('persisted AI per-position exits are rejected after the policy change', async () => {
  const f = engineFixture('retired-ai-exit', snapshot([row()]));
  f.task.pendingAction = { status: 'WAITING', action: 'SELL', exitType: 'TAKE_PROFIT', targetPositionIds: ['old'] };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /SUMMARY_EXIT_REQUIRED/);
  assert.equal(f.submitted.length, 0);
});

test('duplicate commodity-side summary rows cannot be treated as a verified account', () => {
  const rows = [['商品名称', '买 | 卖', '订立均价', '存货数量', '委托冻结数量', '实时货值变化'], ['商品A', '买入', '100', '3', '0', '1']];
  const account = parseHaohanAccount('', [{ kind: 'positionSummaries', rows: [...rows, rows[1]] }]);
  assert.equal(account.positionSummariesVerified, false);
});
test('a summary average controls all underlying entries, including a currently losing detail', async () => {
  const market = snapshot([row('LONG', { averagePrice: 100, quantity: 2 })]);
  market.account.positions = [99, 101].map((orderPrice, i) => ({ positionOrderId: `detail-${i}`, symbol: 'A', symbolName: '商品A', side: 'LONG', quantity: 1, orderPrice }));
  const f = engineFixture('whole-average', market);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].quantity, 2);
  assert.deepEqual(f.submitted[0].targetPositionIds, []);
});
test('rescue pending confirmation suppresses an otherwise profitable ordinary summary exit', () => {
  const task = { pendingAction: { action: 'SELL', entryPurpose: 'RESCUE', targetSymbol: 'A', status: 'UNVERIFIED' } };
  assert.deepEqual(summaryExitCandidates(task, snapshot([row()])), []);
});
test('rescue recovery is isolated per commodity and does not suppress another commodity profit', () => {
  const task = rescueTask(), market = rescuedMarket(-2);
  market.account.positionSummaries.push(row('LONG', { symbol: 'B', symbolName: '商品B' }));
  market.books = [{ symbol: 'A', observedAt: market.observedAt, orderBook: market.orderBook }, { symbol: 'B', observedAt: market.observedAt, orderBook: market.orderBook }];
  assert.deepEqual(summaryExitCandidates(task, market).map(c => c.summary.symbol), ['B']);
  market.account.positionSummaries[1].realtimeValueChange++;
  assert.deepEqual(summaryExitCandidates(task, market).map(c => c.summary.symbol), ['A', 'A', 'B']);
});
test('recovery entry lock persists until all latched summaries and current orders are verified clear', () => {
  const task = rescueTask(), market = rescuedMarket(-1);
  summaryExitCandidates(task, market);
  market.account.positions = [];
  market.account.positionSummaries = [row('SHORT', { realtimeValueChange: -50 })];
  summaryExitCandidates(task, market);
  assert.equal(task.rescueSession.status, 'EXITING');
  market.account.positionSummaries = [];
  market.account.openOrdersVerified = false;
  summaryExitCandidates(task, market);
  assert.equal(task.rescueSession.status, 'EXITING');
  market.account.openOrdersVerified = true;
  summaryExitCandidates(task, market);
  assert.equal(task.rescueSession.status, 'COMPLETE');
});
test('partial summary fills and unverified empty observations do not prove completion or allow duplicate transfers', async () => {
  const market = snapshot([row()]), f = engineFixture('partial-summary-fill', market);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  market.account.positionSummaries[0].quantity = 2;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'AWAITING_FILL');
  assert.equal(f.submitted.length, 1);
  market.account.positionSummaries = [];
  market.account.positionSummariesVerified = false;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'AWAITING_FILL');
  market.account.positionSummariesVerified = true;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'CONFIRMED');
});
for (const fault of ['exception', 'uncertain']) test(`${fault} summary submission stays unverified and is never replayed`, async () => {
  const f = engineFixture(`summary-unknown-${fault}`, snapshot([row()]));
  let calls = 0;
  f.runtime.submitSuggestionForm = async () => { calls++; if (fault === 'exception') throw Error('DESKTOP_BROWSER_DISCONNECTED'); return { ok: false, submitted: false, uncertain: true }; };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, fault === 'exception' ? 'UNVERIFIED' : 'AWAITING_FILL');
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(calls, 1);
});
test('definite summary rejection does not block another direction and retries only the rejected summary', async () => {
  const market = snapshot([row('LONG'), row('SHORT', { averagePrice: 102 })]);
  const f = engineFixture('summary-rejected', market);
  let rejectLong = true;
  f.runtime.submitSuggestionForm = async input => {
    f.submitted.push(input);
    return rejectLong && input.targetSummary.side === 'LONG' ? { ok: false, submitted: false, code: 'TRADE_REJECTED' } : { ok: true, submitted: true };
  };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  rejectLong = false;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.submitted.map(input => input.targetSummary.side), ['LONG', 'SHORT', 'LONG']);
});
test('recovery cancellation failure holds that commodity while another commodity can still exit', async () => {
  const market = rescuedMarket(-1);
  market.account.openOrders = [{ orderId: 'fresh-entry', symbol: 'A', symbolName: '商品A', orderKind: '订立', remainingQuantity: 1, orderTime: new Date().toISOString() }];
  market.account.positionSummaries.push(row('LONG', { symbol: 'B', symbolName: '商品B' }));
  market.books = ['A', 'B'].map(symbol => ({ symbol, observedAt: market.observedAt, orderBook: market.orderBook }));
  const f = engineFixture('recovery-cancel-failure', market, rescueTask());
  f.runtime.cancelOpenOrders = async () => ({ ok: false, results: [{ orderId: 'fresh-entry', cancelled: false }] });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.submitted.map(input => input.targetSummary.symbol), ['B']);
  assert.equal(f.task.rescueSession.status, 'EXITING');
});
for (const field of ['positionSummariesVerified', 'openOrdersVerified']) test(`closing never reports flat with ${field}=false`, async () => {
  const market = snapshot([]); market.account[field] = false;
  const f = engineFixture(`summary-close-unverified-${field}`, market);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime, now: Date.parse('2026-10-23T15:56:00+08:00') });
  assert.notEqual(f.task.sessionCloseState.status, 'FLAT_VERIFIED');
});
test('closing transfers whole long and short summaries at a loss, then verifies both rows gone', async () => {
  const market = snapshot([row('LONG', { averagePrice: 110 }), row('SHORT', { averagePrice: 90 })]);
  const f = engineFixture('summary-close-both', market);
  const now = Date.parse('2026-10-23T15:56:00+08:00');
  await runPositionExitCycle(f.task.id, { runtime: f.runtime, now });
  assert.equal(f.submitted.length, 2);
  assert.ok(f.submitted.every(input => input.exitType === 'SCHEDULED_CLOSE' && input.quantity === 3 && input.targetPositionIds.length === 0));
  assert.equal(f.task.sessionCloseState.status, 'CLOSING');
  market.account.positionSummaries = [];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime, now });
  assert.equal(f.task.sessionCloseState.status, 'FLAT_VERIFIED');
});

for (const action of ['HOLD', 'BUY', 'SELL', 'failure']) test(`ordinary entry ownership: AI ${action}`, async () => {
  const market = { ...snapshot([], 100, 100.1), timeframe: '1m', fingerprint: `entry-${action}`, evidenceId: 'market:entry', history: [], historyCount: 0, indicators: {}, latest: { price: 100 }, missingFields: [] };
  const f = engineFixture(`ai-only-entry-${action}`, market, { autoDecisionEnabled: true });
  const result = await runAnalysis(f.task.id, '', { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    requestDecision: async () => {
      if (action === 'failure') throw Error('model offline');
      return { action, marketRegime: 'UP', targetSymbol: 'A', bullishProfitProbability: 0.9, bearishProfitProbability: 0.8,
        boardAssessments: [{ symbol: 'A', action: 'BUY', bullishProfitProbability: 0.99 }], riskFlags: [], evidenceIds: [] };
    },
  } });
  assert.equal(f.submitted.length, ['BUY', 'SELL'].includes(action) ? 1 : 0);
  assert.equal(result.task.decision.action, action === 'failure' ? 'HOLD' : action);
  if (f.submitted.length) {
    assert.equal(f.submitted[0].action, action);
    assert.equal(f.submitted[0].rescueTrigger, null);
    assert.equal(f.submitted[0].exitType, null);
  }
});
test('summary profit exits while AI is still waiting; a late AI entry cannot overwrite the exit', { timeout: 3000 }, async () => {
  const market = { ...snapshot([row()], 100.4, 100.5), timeframe: '1m', fingerprint: 'slow-ai', evidenceId: 'market:slow', history: [], historyCount: 0, indicators: {}, latest: { price: 100.4 }, missingFields: [] };
  market.account.positions = [{ positionOrderId: 'detail', symbol: 'A', symbolName: '商品A', side: 'LONG', quantity: 3, orderPrice: 100 }];
  const f = engineFixture('summary-during-slow-ai', market, { autoDecisionEnabled: true });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const analysis = runAnalysis(f.task.id, '', { runtime: { ...f.runtime,
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => structuredClone(market),
    requestDecision: async (_provider, _context, { signal }) => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
  } });
  await ready;
  market.orderBook.bids[0].price = 100.5;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  const result = await analysis;
  assert.equal(result.reason, 'MARKET_CHANGED_DURING_ANALYSIS');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].targetSummary.quantity, 3);
  assert.equal(f.task.pendingAction.source, 'summary_profit');
});
test('stopping during a summary read never submits the late result', async () => {
  const f = engineFixture('summary-stop-late', snapshot([row()]));
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.runtime.observeExecutionMarket = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const operation = runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await ready;
  stopTask(f.task.id);
  release(snapshot([row()]));
  await assert.rejects(operation, /EXIT_MONITOR_STOPPED|TASK_STOPPED|CYCLE/);
  assert.equal(f.submitted.length, 0);
});

const predicted = (extra = {}) => ({ ok: true, prediction: { quoteSide: 'BID', comparison: 'GTE', targetPrice: 101,
  estimatedMinutes: 5, rationale: '真实盘口支持未来5分钟到达', ...extra } });
const settlePrediction = () => new Promise(resolve => setImmediate(resolve));
function timedRescue(ageMs = RESCUE_FORECAST_AFTER_MS) {
  const task = rescueTask();
  task.rescueSession.startedAt = new Date(Date.now() - ageMs).toISOString();
  return task;
}
function armPrediction(task, market, result = predicted(), now = Date.now()) {
  const context = rescueForecastContexts(task, market, now)[0];
  task.rescueExitForecasts = [{ key: context.key, signature: context.signature, status: 'ARMED',
    forecast: validateRescueExitForecast(result, market.observedAt, now) }];
}
for (const side of ['BID', 'ASK']) for (const comparison of ['GTE', 'LTE']) {
  test(`${side} ${comparison}: rescue forecast crossing closes both summaries and latches remaining loss`, () => {
    const now = Date.now(), task = timedRescue(), market = rescuedMarket(-8);
    const price = side === 'BID' ? 100.5 : 100.6;
    armPrediction(task, market, predicted({ quoteSide: side, comparison, targetPrice: price + (comparison === 'GTE' ? 0.1 : -0.1) }), now);
    assert.equal(summaryExitCandidates(task, market, now).length, 0);
    if (comparison === 'GTE') { market.orderBook.bids[0].price += 0.2; market.orderBook.asks[0].price += 0.2; }
    else { market.orderBook.bids[0].price -= 0.2; market.orderBook.asks[0].price -= 0.2; }
    assert.equal(summaryExitCandidates(task, market, now).length, 2);
    assert.equal(task.summaryRecoveryExits[0].reason, 'AI_TIMEOUT_PRICE');
    market.account.positionSummaries = [row('SHORT', { realtimeValueChange: -99 })];
    assert.equal(summaryExitCandidates(task, market, now).length, 1);
  });
}
test('rescue forecast starts at exactly ten minutes and expires at exactly five minutes', () => {
  const now = Date.now(), task = timedRescue(), market = rescuedMarket(-8);
  armPrediction(task, market, predicted({ targetPrice: 100.5 }), now);
  task.rescueSession.startedAt = new Date(now - RESCUE_FORECAST_AFTER_MS + 1).toISOString();
  armPrediction(task, market, predicted({ targetPrice: 100.5 }), now);
  assert.equal(summaryExitCandidates(task, market, now).length, 0);
  task.rescueSession.startedAt = new Date(now - RESCUE_FORECAST_AFTER_MS).toISOString();
  armPrediction(task, market, predicted({ targetPrice: 100.5 }), now);
  assert.equal(summaryExitCandidates(task, market, now).length, 2);
  const expiredTask = timedRescue();
  armPrediction(expiredTask, market, predicted({ targetPrice: 100.5 }), now);
  const expiry = Date.parse(market.observedAt) + RESCUE_FORECAST_HORIZON_MS;
  market.observedAt = new Date(expiry).toISOString();
  assert.equal(summaryExitCandidates(expiredTask, market, expiry).length, 0);
});
for (const mutation of [{ estimatedMinutes: 5.01 }, { estimatedMinutes: -1 }, { targetPrice: 0 }, { targetPrice: '100' },
  { targetPrice: Infinity }, { quoteSide: 'LAST' }, { comparison: 'UNKNOWN' }, { rationale: '' }]) {
  test(`invalid rescue target rejected: ${JSON.stringify(mutation)}`, () => {
    assert.throws(() => validateRescueExitForecast(predicted(mutation), new Date().toISOString()), /INVALID_RESCUE_EXIT_FORECAST/);
  });
}
test('forecast deadline is anchored to source observation, not model completion', () => {
  const now = Date.now(), observedAt = new Date(now - 120000).toISOString();
  const forecast = validateRescueExitForecast(predicted(), observedAt, now);
  assert.equal(Date.parse(forecast.expiresAt), now + 180000);
  assert.throws(() => validateRescueExitForecast(predicted(), observedAt, now + 180000), /INVALID_RESCUE_EXIT_FORECAST/);
});
for (const fault of ['quantity', 'average', 'participants', 'unverified', 'stale']) test(`forecast cannot exit changed or unverified holdings: ${fault}`, () => {
  const now = Date.now(), task = timedRescue(), market = rescuedMarket(-8);
  armPrediction(task, market, predicted({ targetPrice: 100.5 }), now);
  if (fault === 'quantity') market.account.positionSummaries[0].quantity++;
  if (fault === 'average') market.account.positionSummaries[0].averagePrice++;
  if (fault === 'participants') market.account.positions[0].positionOrderId = 'unrelated';
  if (fault === 'unverified') market.account.positionsVerified = false;
  if (fault === 'stale') market.observedAt = new Date(now - 6000).toISOString();
  const candidates = summaryExitCandidates(task, market, now);
  if (fault === 'participants') assert.ok(candidates.every(c => !c.decision.exitGuard.recovery));
  else assert.equal(candidates.length, 0);
});
test('ordinary minus-one recovery preempts a missing or unreachable AI target', () => {
  const task = timedRescue(), market = rescuedMarket(-1);
  armPrediction(task, market, predicted({ targetPrice: 999 }));
  assert.equal(summaryExitCandidates(task, market).length, 2);
  assert.equal(task.summaryRecoveryExits[0].reason, 'RESCUE_RECOVERED');
});
test('forecast persists for the same rescue and cannot apply to a new rescue of the same commodity', () => {
  const task = timedRescue(), market = rescuedMarket(-8);
  armPrediction(task, market, predicted({ targetPrice: 100.5 }));
  const restored = compactTaskRuntime(structuredClone(compactTaskRuntime(task)));
  assert.equal(summaryExitCandidates(restored, market).length, 2);
  task.rescueSession.startedAt = new Date(Date.now() - 2 * RESCUE_FORECAST_AFTER_MS).toISOString();
  assert.equal(summaryExitCandidates(task, market).length, 0);
});
for (const age of [RESCUE_FORECAST_AFTER_MS - 1000, RESCUE_FORECAST_AFTER_MS + 1000]) test(`engine schedules rescue prediction after ${age}ms without entering an ordinary order`, async () => {
  const market = rescuedMarket(-8), f = engineFixture(`forecast-age-${age}`, market, timedRescue(age));
  let calls = 0;
  f.runtime.requestRescueExitPrediction = async (_provider, context) => {
    calls++;
    assert.equal(context.horizonMinutes, 5);
    assert.equal(context.summaries.length, 2);
    return predicted({ targetPrice: 101 });
  };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await settlePrediction();
  assert.equal(calls, age > RESCUE_FORECAST_AFTER_MS ? 1 : 0);
  assert.equal(f.submitted.length, 0);
  if (!calls) return;
  assert.equal(f.task.rescueExitForecasts[0].status, 'ARMED');
  market.orderBook.bids[0].price = 101;
  market.orderBook.asks[0].price = 101.1;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.submitted.map(s => s.targetSummary.side), ['LONG', 'SHORT']);
  assert.ok(f.submitted.every(s => s.exitType && s.targetPositionIds.length === 0));
});
test('slow rescue prediction never blocks another commodity summary exit; recovery cancels prediction', async () => {
  const market = rescuedMarket(-8), f = engineFixture('forecast-slow', market, timedRescue());
  market.account.positionSummaries.push(row('LONG', { symbol: 'B', symbolName: '商品B' }));
  market.books = ['A', 'B'].map(symbol => ({ symbol, observedAt: market.observedAt, orderBook: market.orderBook }));
  let finish, signal;
  f.runtime.requestRescueExitPrediction = (_provider, _context, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].targetSummary.symbol, 'B');
  market.account.positionSummaries[1].realtimeValueChange = 3;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(signal.aborted, true);
  finish(predicted());
  await settlePrediction();
  assert.deepEqual(f.task.rescueExitForecasts, []);
  assert.equal(f.submitted.filter(s => s.targetSummary.symbol === 'A').length, 2);
});
test('stopping discards a late rescue prediction', async () => {
  const f = engineFixture('forecast-stop', rescuedMarket(-8), timedRescue());
  let finish, signal;
  f.runtime.requestRescueExitPrediction = (_p, _c, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  stopAllControllers();
  assert.equal(signal.aborted, true);
  finish(predicted({ targetPrice: 100.5 }));
  await settlePrediction();
  assert.notEqual(f.task.rescueExitForecasts[0].status, 'ARMED');
  assert.equal(f.submitted.length, 0);
});
test('expired forecast requests a new five-minute target; invalid result is explicit and rate limited', async () => {
  const market = rescuedMarket(-8), f = engineFixture('forecast-expiry', market, timedRescue());
  armPrediction(f.task, market);
  f.task.rescueExitForecasts[0].forecast.observedAt = new Date(Date.now() - RESCUE_FORECAST_HORIZON_MS).toISOString();
  f.task.rescueExitForecasts[0].forecast.expiresAt = new Date(Date.now() - 1).toISOString();
  let calls = 0;
  f.runtime.requestRescueExitPrediction = async () => { calls++; return predicted({ estimatedMinutes: 6 }); };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await settlePrediction();
  assert.equal(calls, 1);
  assert.equal(f.task.rescueExitForecasts[0].status, 'FAILED');
  assert.equal(f.task.rescueExitForecasts[0].code, 'INVALID_RESCUE_EXIT_FORECAST');
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(calls, 1);
  assert.equal(f.submitted.length, 0);
});

test('holdings change during prediction discards the old result and binds the new one', async () => {
  const market = rescuedMarket(-8), f = engineFixture('forecast-changed-during-ai', market, timedRescue());
  let finish, calls = 0, firstSignal;
  f.runtime.requestRescueExitPrediction = (_p, _c, { signal }) => {
    calls++;
    if (calls === 1) { firstSignal = signal; return new Promise(resolve => { finish = resolve; }); }
    return predicted({ targetPrice: 999 });
  };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  market.account.positionSummaries[0].quantity++;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(firstSignal.aborted, true);
  finish(predicted({ targetPrice: 100.5 }));
  await settlePrediction();
  assert.equal(calls, 2);
  assert.equal(f.task.rescueExitForecasts[0].forecast.targetPrice, 999);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 0);
});
test('another commodity reaching the same price cannot trigger the rescued commodity forecast', () => {
  const now = Date.now(), task = timedRescue(), market = rescuedMarket(-8);
  armPrediction(task, market, predicted({ targetPrice: 101 }), now);
  market.account.positionSummaries.push(row('LONG', { symbol: 'B', symbolName: '商品B' }));
  market.books = [{ symbol: 'A', observedAt: market.observedAt, orderBook: market.orderBook },
    { symbol: 'B', observedAt: market.observedAt, orderBook: { bids: [{ price: 101, volume: 10 }], asks: [{ price: 101.1, volume: 10 }] } }];
  assert.deepEqual(summaryExitCandidates(task, market, now).map(c => c.summary.symbol), ['B']);
  assert.equal(task.summaryRecoveryExits.length, 0);
});
