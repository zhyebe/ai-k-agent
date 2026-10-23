import './fixtures/open-market-clock.mjs';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { summaryExitCandidates, summaryExitReviewContexts, summaryReviewType, summarySignature, summaryKey } from '../server/summary-exit-policy.mjs';
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
const authorization = (summary, reviewType = 'TAKE_PROFIT', decision = 'EXIT') => ({ id: 'ai-review', key: summaryKey(summary),
  signature: summarySignature(summary), reviewType, decision, status: 'REVIEWED', expiresAt: new Date(Date.now() + 60000).toISOString() });
for (const side of ['LONG', 'SHORT']) for (const points of [-3, -2, -1.999, 0.5, 0.999, 1, 1.5]) {
  test(`${side} ${points} points: profit exits immediately, loss requires AI`, () => {
    const summary = row(side), price = 100 + points * (side === 'LONG' ? 1 : -1), market = snapshot([summary], price);
    assert.equal(summaryReviewType(summary, price), points >= 1 ? 'TAKE_PROFIT' : points <= -2 ? 'STOP_LOSS' : null);
    assert.equal(summaryExitReviewContexts(market).length, points >= 1 || points <= -2 ? 1 : 0);
    assert.equal(summaryExitCandidates({}, market).length, points >= 1 ? 1 : 0);
    const record = authorization(summary, points >= 1 ? 'TAKE_PROFIT' : 'STOP_LOSS');
    const exits = summaryExitCandidates({ summaryExitReviews: [record] }, market);
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
    const record = authorization(summary, 'STOP_LOSS');
    if (fault === 'HOLD') record.decision = 'HOLD';
    if (fault === 'unverified') market.account.positionSummariesVerified = false;
    if (fault === 'stale') market.observedAt = new Date(Date.now() - 6000).toISOString();
    if (fault === 'frozen') summary.frozenQuantity = 1;
    if (fault === 'missing-quote') market.orderBook = {};
    if (fault === 'expired') record.expiresAt = new Date(Date.now() - 1).toISOString();
    if (fault === 'changed-average') summary.averagePrice = 101;
    if (fault === 'changed-quantity') summary.quantity = 2;
    if (fault === 'threshold-receded') market.orderBook.bids[0].price = 98.1;
    assert.deepEqual(summaryExitCandidates({ summaryExitReviews: [record] }, market), []);
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
for (const automatic of [false, true]) for (const points of [1, -2]) test(`${automatic ? 'automatic' : 'manual'} entry: ${points} points transfers whole summary once with the correct decision authority`, async t => {
  const summary = row(), market = snapshot([summary], 100 + points);
  const f = fixture(t, `review-${automatic}-${points}`, market, { autoDecisionEnabled: automatic });
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
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
  await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await flush();
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
  await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await flush();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.task.summaryExitReviews[0].status, 'FAILED');
});
test('AI exit authorization survives persistence without retired rescue state', () => {
  const review = authorization(row());
  const saved = compactTaskRuntime({ summaryExitReviews: [review], rescueSession: { status: 'ACTIVE' } });
  assert.deepEqual(saved.summaryExitReviews, [review]);
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
  await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await flush();
  market.orderBook.bids[0].price = 101; market.orderBook.asks[0].price = 101;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submitted.length, 1);
  release({ ok: true, decision: 'HOLD', rationale: 'stale' }); await flush();
  assert.deepEqual(f.task.summaryExitReviews, []);
});
