import './fixtures/open-market-clock.mjs';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { summaryExitCandidates, summaryExitReviewContexts, summaryReviewType, summarySignature, summaryKey, observeSummaryLosses, confirmedSummaryLoss, summaryExitAllowsPrice } from '../server/summary-exit-policy.mjs';
import { parseHaohanAccount } from '../server/haohan.mjs';
import { compactTaskRuntime } from '../server/persistence.mjs';
import { runPositionExitCycle, stopAllControllers, confirmPendingAction, stopTask } from '../server/engine.mjs';
import { state } from '../server/store.mjs';
beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(stopAllControllers);
const row = (side = 'LONG', extra = {}) => ({ symbol: 'A', symbolName: '商品A', side, quantity: 3, frozenQuantity: 0, averagePrice: 100, ...extra });
const snapshot = (rows, price = 101) => ({ ok: true, symbol: 'A', symbolName: '商品A', observedAt: new Date().toISOString(),
  account: { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: rows, openOrdersVerified: true, openOrders: [] },
  orderBook: { bids: [{ price, volume: 100 }], asks: [{ price, volume: 100 }] } });
const lossEvidence = (summary, end = Date.now(), price = summary.side === 'SHORT' ? 102 : 98) => ({ key: summaryKey(summary), signature: summarySignature(summary), startedAt: end - 30000, lastObservedAt: end, samples: [-30000, -20000, -10000, 0].map(offset => ({ observedAt: end + offset, price, pnlPoints: -2 })) });
const authorization = (summary, reviewType = 'TAKE_PROFIT', decision = 'EXIT', end = Date.now()) => ({ id: 'ai-review', key: summaryKey(summary),
  signature: summarySignature(summary), lossObservation: lossEvidence(summary, end), reviewType, decision, status: 'REVIEWED', expiresAt: new Date(Date.now() + 60000).toISOString() });
for (const side of ['LONG', 'SHORT']) for (const points of [-3, -2, -1.999, 0.5, 0.999, 1, 1.5]) {
  test(`${side} ${points} points: profit exits immediately, loss requires AI`, () => {
    const summary = row(side), price = 100 + points * (side === 'LONG' ? 1 : -1), market = snapshot([summary], price);
    assert.equal(summaryReviewType(summary, price), points >= 1 ? 'TAKE_PROFIT' : points <= -2 ? 'STOP_LOSS' : null);
    assert.equal(summaryExitReviewContexts(market).length, points >= 1 || points <= -2 ? 1 : 0);
    assert.equal(summaryExitCandidates({}, market).length, points >= 1 ? 1 : 0);
    const record = authorization(summary, points >= 1 ? 'TAKE_PROFIT' : 'STOP_LOSS', 'EXIT', Date.parse(market.observedAt));
    const exits = summaryExitCandidates({ summaryExitReviews: [record], summaryLossObservations: [record.lossObservation] }, market);
    assert.equal(exits.length, points >= 1 || points <= -2 ? 1 : 0);
    if (exits.length) {
      assert.equal(exits[0].decision.targetSummary.quantity, 3);
      assert.deepEqual(exits[0].decision.targetPositionIds, []);
      assert.equal(exits[0].decision.action, side === 'LONG' ? 'SELL' : 'BUY');
    }
  });
}
for (const fault of ['HOLD', 'unverified', 'stale', 'frozen', 'missing-quote', 'expired', 'changed-average', 'changed-quantity', 'threshold-receded']) {
  test(`AI summary exit rejects ${fault}`, () => {
    const summary = row(), market = snapshot([summary], 98);
    const record = authorization(summary, 'STOP_LOSS', 'EXIT', Date.parse(market.observedAt));
    if (fault === 'HOLD') record.decision = 'HOLD';
    if (fault === 'unverified') market.account.positionSummariesVerified = false;
    if (fault === 'stale') market.observedAt = new Date(Date.now() - 6000).toISOString();
    if (fault === 'frozen') summary.frozenQuantity = 1;
    if (fault === 'missing-quote') market.orderBook = {};
    if (fault === 'expired') record.expiresAt = new Date(Date.now() - 1).toISOString();
    if (fault === 'changed-average') summary.averagePrice = 101;
    if (fault === 'changed-quantity') summary.quantity = 2;
    if (fault === 'threshold-receded') market.orderBook.bids[0].price = 98.1;
    assert.deepEqual(summaryExitCandidates({ summaryExitReviews: [record], summaryLossObservations: [record.lossObservation] }, market), []);
  });
}
test('summary parser reads actual average/quantity and rejects duplicate or loading rows', () => {
  const rows = [['商品名称', '买 | 卖', '订立均价', '存货数量', '委托冻结数量', '实时货值变化'], ['商品A', '买入', '1,000.25', '3', '0', '--']];
  const table = { kind: 'positionSummaries', rows };
  const account = parseHaohanAccount('', [table]);
  assert.equal(account.positionSummariesVerified, true);
  assert.equal(account.positionSummaries[0].averagePrice, 1000.25);
  assert.equal(account.positionSummaries[0].realtimeValueChange, null);
  assert.equal(parseHaohanAccount('', [{ ...table, loading: true }]).positionSummariesVerified, false);
  assert.equal(parseHaohanAccount('', [{ ...table, rows: [...rows, rows[1]] }]).positionSummariesVerified, false);
});
function fixture(t, id, market, extras = {}) {
  const task = { id, ownerUserId: 'summary-test', mode: 'LIVE', status: 'MONITORING', monitoringEnabled: true, stopLocked: false,
    monitorGeneration: 0, market, rules: [], workflow: [], metrics: {}, decision: { action: 'HOLD' },
    target: { browserSessionId: id, connectorId: 'connector_haohan_readonly' }, ...extras };
  state.tasks.unshift(task);
  t.after(() => { state.tasks = state.tasks.filter(item => item !== task); });
  const submitted = [], reviews = [];
  const runtime = { observeExecutionMarket: async () => ({ ...market, observedAt: new Date().toISOString() }),
    submitSuggestionForm: async input => { submitted.push(input); return { ok: true, submitted: true, submittedQuantity: input.quantity }; },
    requestSummaryExitDecision: async (_provider, context) => { reviews.push(context); return { ok: true, decision: 'EXIT', rationale: '兑现当前可成交收益' }; } };
  return { task, runtime, submitted, reviews };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function observeLossWindow(f) {
  const end = Date.now(), original = f.runtime.observeExecutionMarket;
  for (const offset of [-30000, -20000, -10000, 0]) {
    const now = end + offset;
    f.runtime.observeExecutionMarket = async () => ({ ...f.task.market, observedAt: new Date(now).toISOString() });
    await runPositionExitCycle(f.task.id, { runtime: f.runtime, now }); await flush();
    if (offset < 0) assert.equal(f.reviews.length, 0, 'loss cannot call AI before 30 seconds');
  }
  f.runtime.observeExecutionMarket = original;
}
for (const automatic of [false, true]) for (const points of [1, -2]) test(`${automatic ? 'automatic' : 'manual'} entry: ${points} points transfers whole summary once with the correct decision authority`, async t => {
  const summary = row(), market = snapshot([summary], 100 + points);
  const f = fixture(t, `review-${automatic}-${points}`, market, { autoDecisionEnabled: automatic });
  if (points < 0) await observeLossWindow(f);
  else await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await flush();
  assert.equal(f.reviews.length, points < 0 ? 1 : 0);
  assert.equal(f.submitted.length, points < 0 ? 0 : 1, 'profit must submit in the first observation without AI');
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].quantity, 3);
  assert.equal(f.submitted[0].targetSummary.averagePrice, 100);
  assert.deepEqual(f.submitted[0].targetPositionIds, []);
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1, 'unverified transfer cannot be repeated');
  market.account.positionSummaries = [];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'CONFIRMED');
});
test('AI HOLD keeps holdings; a changed executable price requests another decision', async t => {
  const market = snapshot([row()], 98);
  const f = fixture(t, 'ai-hold', market);
  f.runtime.requestSummaryExitDecision = async (_p, context) => { f.reviews.push(context); return { ok: true, decision: 'HOLD', rationale: '短线延续但需持续复核' }; };
  await observeLossWindow(f);
  for (let i = 0; i < 2; i++) { await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await flush(); }
  assert.equal(f.reviews.length, 1);
  assert.equal(f.submitted.length, 0);
  market.orderBook.bids[0].price = 97; market.orderBook.asks[0].price = 97;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await flush();
  assert.equal(f.reviews.length, 2);
  assert.equal(f.submitted.length, 0);
});
for (const change of ['stop', 'average', 'quantity', 'receded']) test(`slow AI result discarded after ${change}`, async t => {
  const market = snapshot([row()], 98);
  const f = fixture(t, `slow-${change}`, market);
  const releases = [];
  f.runtime.requestSummaryExitDecision = () => new Promise(resolve => { releases.push(resolve); });
  await observeLossWindow(f);
  if (change === 'stop') stopTask(f.task.id);
  if (change === 'average') market.account.positionSummaries[0].averagePrice = 101;
  if (change === 'quantity') market.account.positionSummaries[0].quantity = 2;
  if (change === 'receded') market.orderBook.bids[0].price = 98.5;
  if (change !== 'stop') await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  releases[0]({ ok: true, decision: 'EXIT', rationale: 'old result' }); await flush();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.summaryExitReviews?.some(r => r.decision === 'EXIT') || false, false);
});
test('model failure or a large loss cannot start rescue or fabricate an exit', async t => {
  const market = snapshot([row()], 90), f = fixture(t, 'model-failure', market);
  f.runtime.requestSummaryExitDecision = async () => { throw Error('PROVIDER_REQUEST_FAILED'); };
  await observeLossWindow(f);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.summaryExitReviews[0].status, 'FAILED');
});
test('AI exit authorization survives persistence without retired rescue state', () => {
  const review = authorization(row());
  const saved = compactTaskRuntime({ summaryLossObservations: [review.lossObservation], summaryExitReviews: [review], rescueSession: { status: 'ACTIVE' } });
  assert.deepEqual(saved.summaryExitReviews, [review]);
  assert.deepEqual(saved.summaryLossObservations, [review.lossObservation]);
  assert.equal(Object.hasOwn(saved, 'rescueSession'), false);
});
test('persisted old program exit requires a current AI decision', async t => {
  const f = fixture(t, 'retired-program-exit', snapshot([row()]));
  f.task.pendingAction = { status: 'WAITING', action: 'SELL', exitType: 'TAKE_PROFIT', targetSummary: row(), exitGuard: { summary: true, recovery: true } };
  await assert.rejects(confirmPendingAction(f.task.id, { runtime: f.runtime }), /SUMMARY_EXIT_AUTHORIZATION_REQUIRED/);
  assert.equal(f.submitted.length, 0);
});

for (const side of ['LONG', 'SHORT']) test(`${side} profit exit ignores unavailable AI and an old HOLD review`, async t => {
  const summary = row(side), market = snapshot([summary], side === 'LONG' ? 101.5 : 98.5);
  market.flashK = { suspected: true, price: side === 'LONG' ? 101.5 : 98.5, reason: 'UNCONFIRMED_SPIKE', observedAt: Date.now() };
  const f = fixture(t, `profit-no-ai-${side}`, market, { summaryExitReviews: [authorization(summary, 'STOP_LOSS', 'HOLD')] });
  f.runtime.requestSummaryExitDecision = async () => { assert.fail('profit must not request AI'); };
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].exitGuard.programProfit, true);
  assert.equal(f.submitted[0].exitGuard.aiAuthorization, undefined);
});
test('profit exits while a loss AI request is still pending, and discards its late HOLD', async t => {
  const market = snapshot([row()], 98), f = fixture(t, 'profit-preempts-loss', market);
  let release;
  f.runtime.requestSummaryExitDecision = () => new Promise(resolve => { release = resolve; });
  await observeLossWindow(f);
  market.orderBook.bids[0].price = 101; market.orderBook.asks[0].price = 101;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  release({ ok: true, decision: 'HOLD', rationale: 'stale' }); await flush();
  assert.deepEqual(f.task.summaryExitReviews, []);
});

for (const side of ['LONG', 'SHORT']) test(`${side} loss observations require continuous fresh quotes and reset on recovery, gaps and flash events`, () => {
  const summary = row(side), task = {}, base = Date.now() - 100000;
  const price = side === 'LONG' ? 98 : 102;
  const sample = (offset, quote = price, extra = {}) => {
    const market = { ...snapshot([summary], quote), ...extra, observedAt: new Date(base + offset).toISOString() };
    observeSummaryLosses(task, market, base + offset);
    return task.summaryLossObservations[0];
  };
  let observation = sample(0);
  assert.equal(confirmedSummaryLoss(observation, summary, base), false);
  for (const offset of [10000, 20000, 30000]) observation = sample(offset);
  assert.equal(confirmedSummaryLoss(observation, summary, base + 30000), true);
  assert.equal(sample(31000, 100), undefined, 'recovery clears the loss episode');
  observation = sample(32000);
  assert.equal(observation.startedAt, base + 32000);
  observation = sample(43001);
  assert.equal(observation.startedAt, base + 43001, 'sample gap restarts observation');
  for (const offset of [53000, 63000]) sample(offset);
  const flashK = { suspected: true, reason: 'TRANSIENT_REVERTED', observedAt: base + 65000, timestamp: base, price: 90 };
  observation = sample(65000, price, { flashK });
  assert.equal(observation.startedAt, base + 65000);
  for (const offset of [75000, 85000, 95000]) observation = sample(offset, price, { flashK });
  assert.equal(confirmedSummaryLoss(observation, summary, base + 95000), true, 'same retained event must not cause endless waiting');
  assert.equal(sample(96000, price, { account: { positionSummariesVerified: false } }), undefined);
});

test('re-reading one cached loss quote never completes the observation window', () => {
  const summary = row(), task = {}, now = Date.now(), market = snapshot([summary], 98);
  for (const delta of [0, 1000, 2000, 3000, 4000]) observeSummaryLosses(task, market, now + delta);
  assert.equal(task.summaryLossObservations[0].samples.length, 1);
  observeSummaryLosses(task, market, now + 30000);
  assert.deepEqual(task.summaryLossObservations, []);
});

test('old or missing loss observation cannot authorize a browser transfer', () => {
  const summary = row(), record = authorization(summary, 'STOP_LOSS');
  assert.equal(summaryExitAllowsPrice(summary, 98, record), true);
  delete record.lossObservation;
  assert.equal(summaryExitAllowsPrice(summary, 98, record), false);
});

test('loss AI receives retained flash evidence and confirmed-only history', async t => {
  const now = Date.now();
  const flashK = { suspected: true, observedAt: now - 30000, price: 90, reason: 'UNCONFIRMED_SPIKE_DOWN' };
  const confirmed = { timestamp: now - 120000, open: 100, high: 101, low: 99, close: 100, confirmation: { status: 'CONFIRMED' } };
  const provisional = { timestamp: now - 30000, open: 100, high: 100, low: 90, close: 90, confirmation: { status: 'PROVISIONAL' } };
  const market = { ...snapshot([row()], 98), timeframe: '1m', history: [confirmed, provisional], flashK };
  const f = fixture(t, 'flash-evidence', market);
  await observeLossWindow(f);
  assert.equal(f.reviews.length, 1);
  const context = f.reviews[0];
  assert.equal(context.market.flashK.price, 90);
  assert.equal(context.market.intrabarEvidence.confirmed, false);
  assert.equal(context.market.history.length, 1);
  assert.equal(context.market.history[0].close, 100);
  assert.ok(context.lossObservation.lastObservedAt - context.lossObservation.startedAt >= 30000);
});

test('new flash during a slow AI review invalidates the result and restarts the loss window', async t => {
  const market = snapshot([row()], 98), f = fixture(t, 'flash-inflight', market);
  let release;
  f.runtime.requestSummaryExitDecision = () => new Promise(resolve => { release = resolve; });
  await observeLossWindow(f);
  market.flashK = { suspected: true, observedAt: Date.now(), timestamp: Date.now(), price: 95, reason: 'TRANSIENT_REVERTED' };
  // New read must have a distinct capture time, even if the test runs within one millisecond.
  const now = Date.now() + 2;
  f.runtime.observeExecutionMarket = async () => ({ ...market, observedAt: new Date(now).toISOString() });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime, now });
  release({ ok: true, decision: 'EXIT', rationale: 'stale decision' }); await flush();
  assert.deepEqual(f.task.summaryExitReviews, []);
  assert.equal(f.task.summaryLossObservations[0].startedAt, now);
  assert.equal(f.submitted.length, 0);
});

test('rotating another held instrument preserves the current loss episode and in-flight review', async t => {
  const market = snapshot([row()], 98), f = fixture(t, 'rotating-loss', market);
  let release;
  f.runtime.requestSummaryExitDecision = () => new Promise(resolve => { release = resolve; });
  await observeLossWindow(f);
  const original = f.task.summaryLossObservations[0];
  f.runtime.observeExecutionMarket = async () => ({ ...market, symbol: 'B', symbolName: '商品B', observedAt: new Date().toISOString() });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.deepEqual(f.task.summaryLossObservations[0], original);
  release({ ok: true, decision: 'HOLD', rationale: 'fresh continuous loss reviewed' }); await flush();
  assert.equal(f.task.summaryExitReviews[0].decision, 'HOLD');
  assert.equal(f.submitted.length, 0);
});
