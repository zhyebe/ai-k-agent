import './fixtures/open-market-clock.mjs';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { runAnalysis, runPositionExitCycle, stopAllControllers } from '../server/engine.mjs';
import { state } from '../server/store.mjs';
import { requestDecision, requestSummaryExitDecision } from '../server/provider.mjs';
beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(stopAllControllers);
function fixture(t, id, automatic = true, action = 'BUY', probability = 0.6) {
  const market = { ok: true, symbol: 'A', symbolName: '商品A', timeframe: '1m', observedAt: new Date().toISOString(), fingerprint: id, source: 'test', evidenceId: 'market:test',
    history: [], historyCount: 0, latest: { price: 100 }, quote: { price: 100 }, books: [], indicators: {}, missingFields: [],
    orderBook: { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] },
    account: { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: [], openOrdersVerified: true, openOrders: [], availableFunds: 10000 } };
  const task = { id, ownerUserId: id, mode: 'LIVE', autoDecisionEnabled: automatic, status: 'MONITORING', monitoringEnabled: true,
    target: { type: 'website', connectorId: 'connector_haohan_readonly', browserSessionId: id, url: 'https://smyw.haohandahan.cn/client/#/transcc' },
    market, rules: [], workflow: [], metrics: { equity: 10000 }, decision: { action: 'HOLD', riskFlags: [], evidenceIds: [] } };
  state.tasks.unshift(task); t.after(() => { state.tasks = state.tasks.filter(item => item !== task); });
  const submissions = [], forms = [], analyses = [];
  const runtime = { openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => ({ ...market, observedAt: new Date().toISOString() }), observeExecutionMarket: async () => ({ ...market, observedAt: new Date().toISOString() }),
    continueManualEntry: async () => ({ continued: false }),
    fillSuggestionForm: async input => { forms.push(input); return { ok: true, filled: true }; },
    submitSuggestionForm: async input => { submissions.push(input); return { ok: true, submitted: true }; },
    requestSummaryExitDecision: async () => ({ ok: true, decision: 'EXIT', rationale: '本轮兑现' }),
    requestDecision: async (_provider, context) => { analyses.push(context); return { action, marketRegime: 'UNKNOWN', targetSymbol: 'A',
      bullishProfitProbability: action === 'BUY' ? probability : 0.9, bearishProfitProbability: action === 'SELL' ? probability : 0.9,
      orderType: 'MARKET', riskFlags: [], evidenceIds: [], decisionTtlSec: 300 }; } };
  return { task, market, runtime, submissions, forms, analyses };
}
for (const automatic of [false, true]) for (const action of ['BUY', 'SELL']) for (const probability of [0.3999, 0.4, 0.42, 0.45, 0.6]) {
  test(`${automatic ? 'automatic' : 'manual'} ${action} selected probability ${probability}`, async t => {
    const f = fixture(t, `entry-${automatic}-${action}-${probability}`, automatic, action, probability);
    await runAnalysis(f.task.id, '', { runtime: f.runtime });
    assert.equal((automatic ? f.submissions : f.forms).length, probability >= 0.4 ? 1 : 0);
    assert.equal(f.task.decision.action, probability >= 0.4 ? action : 'HOLD');
    assert.equal(f.analyses[0].strategy.loop.entry.emptyOnly, true);
    assert.equal(f.analyses[0].strategy.loop.entry.minimumProbability, 0.4);
    if (probability >= 0.4) {
      await runAnalysis(f.task.id, '', { runtime: f.runtime });
      assert.equal(f.analyses.length, 1, 'pending entry owns the current round');
      assert.equal((automatic ? f.submissions : f.forms)[0].action, action, 'program never chooses the higher probability side');
    }
  });
}
for (const stateName of ['positions', 'summaries', 'orders', 'unverified']) test(`${stateName} blocks additional entry analysis`, async t => {
  const f = fixture(t, `round-${stateName}`);
  if (stateName === 'positions') f.market.account.positions = [{ positionOrderId: 'p', side: 'LONG', quantity: 1, orderPrice: 100 }];
  if (stateName === 'summaries') f.market.account.positionSummaries = [{ side: 'LONG', quantity: 1, averagePrice: 100 }];
  if (stateName === 'orders') f.market.account.openOrders = [{ orderId: 'o', remainingQuantity: 1, orderTime: new Date().toISOString() }];
  if (stateName === 'unverified') f.market.account.positionSummariesVerified = false;
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.analyses.length, 0);
  assert.equal(f.submissions.length, 0);
});

for (const orderType of ['MARKET', 'LIMIT']) test(`40% AI-selected short ${orderType} submits once at the AI price`, async t => {
  const f = fixture(t, `ai-price-40-${orderType}`);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      action: 'SELL', bullish_profit_probability: 0.8, bearish_profit_probability: 0.4,
      order_type: orderType, ...(orderType === 'LIMIT' ? { entry_price: 101, target_price: 101 } : {}),
      target_symbol: 'A', analysis_summary: '主判断：偏跌，AI选择有盈利空间的入场价',
    }) } }] }));
  });
  f.runtime.requestDecision = (_provider, context, options) => requestDecision({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'fixture' }, context, options);
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(calls, 1);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].action, 'SELL');
  assert.equal(f.submissions[0].orderType, orderType);
  if (orderType === 'LIMIT') assert.equal(f.submissions[0].targetPrice, 101);
});

for (const probability of [0.4, 0.42, 0.45, 0.8]) test(`AI HOLD at eligible ${probability} is successful observation with no entry`, async t => {
  const f = fixture(t, `ai-hold-${probability}`);
  f.runtime.requestDecision = async () => ({ action: 'HOLD', bullishProfitProbability: probability, bearishProfitProbability: probability,
    analysisSummary: '当前无合适盈利空间，继续观察', riskFlags: [], evidenceIds: [] });
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.submissions.length, 0);
  assert.equal(f.forms.length, 0);
  assert.equal(f.task.lastAnalysisSucceeded, true);
  assert.equal(f.task.decision.action, 'HOLD');
  assert.equal(f.task.decision.riskFlags.includes('INCONSISTENT_ACTION_PROBABILITY'), false);
});
test('AI entry, holdings, immediate profit exit, verified flat, next entry completes a full round in the same K', async t => {
  const f = fixture(t, 'whole-round');
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.submissions.length, 1);
  f.market.account.positions = [{ positionOrderId: 'p', symbol: 'A', symbolName: '商品A', side: 'LONG', quantity: 1, orderPrice: 100, frozenQuantity: 0 }];
  f.market.account.positionSummaries = [{ symbol: 'A', symbolName: '商品A', side: 'LONG', quantity: 1, averagePrice: 100, frozenQuantity: 0 }];
  f.market.orderBook.bids[0].price = 101; f.market.orderBook.asks[0].price = 101;
  await runPositionExitCycle(f.task.id, { runtime: f.runtime }); await new Promise(resolve => setImmediate(resolve));
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[1].exitType, 'TAKE_PROFIT');
  f.market.account.positions = []; f.market.account.positionSummaries = [];
  await runPositionExitCycle(f.task.id, { runtime: f.runtime });
  await runAnalysis(f.task.id, '', { runtime: f.runtime, skipIfUnchanged: true });
  assert.equal(f.submissions.length, 3);
  assert.equal(f.submissions[2].exitType, null);
});
test('old unresolved rescue cannot lock a freshly verified flat account forever', async t => {
  const f = fixture(t, 'old-unresolved');
  f.task.unsettledActions = [{ id: 'old', status: 'AWAITING_FILL', source: 'auto_timeout', action: 'BUY', entryPurpose: 'RESCUE',
    createdAt: new Date(Date.now() - 86400000).toISOString(), baselinePositionsVerified: true, baselinePositions: {}, suggestedQty: 2 }];
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.task.unsettledActions, []);
  assert.ok(state.orders.some(order => order.idempotencyKey === 'pending:old' && order.status === 'reconciled_flat'));
});
for (const apiFormat of ['chat', 'responses', 'anthropic', 'gemini']) test(`${apiFormat} receives one consistent round policy and dedicated exit decision`, async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const messages = body.input || body.messages || body.contents;
    const prompt = body.system || body.systemInstruction?.parts[0].text || messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(prompt, /盈利.*>=1|盈利点差>=1/);
    assert.match(prompt, /亏损.*<=-2|亏损点差<=-2/);
    const value = calls.length === 1 ? { action: 'SELL', bullish_profit_probability: 0.8, bearish_profit_probability: 0.46, analysis_summary: '主判断：偏跌' }
      : { decision: 'HOLD', rationale: '价格仍有恢复机会，继续监控风险' };
    const text = JSON.stringify(value);
    return new Response(JSON.stringify(apiFormat === 'anthropic' ? { content: [{ type: 'text', text }] }
      : apiFormat === 'responses' ? { output_text: text } : apiFormat === 'gemini' ? { candidates: [{ content: { parts: [{ text }] } }] }
      : { choices: [{ message: { content: text } }] }));
  });
  const provider = { apiKey: 'fixture', apiFormat, baseUrl: 'https://fixture.invalid', model: 'fixture' };
  const entry = await requestDecision(provider, { market: {} });
  assert.equal(entry.action, 'SELL');
  const exit = await requestSummaryExitDecision(provider, { reviewType: 'STOP_LOSS', pnlPoints: -2 });
  assert.equal(exit.decision, 'HOLD');
  assert.equal(calls.length, 2);
});

for (const outcome of ['flat', 'partial-fill', 'unverified', 'cancel-failed']) test(`expired current order: ${outcome} follows verified account state`, async t => {
  const f = fixture(t, `expired-order-${outcome}`);
  f.market.account.openOrders = [{ orderId: 'o', orderTime: new Date(Date.now() - 121000).toISOString(), remainingQuantity: 2 }];
  const cancellations = [];
  f.runtime.cancelOpenOrders = async ({ orderIds }) => {
    cancellations.push(orderIds);
    if (outcome === 'cancel-failed') return { ok: false, results: [{ orderId: 'o', cancelled: false }] };
    f.market.account.openOrders = [];
    if (outcome === 'partial-fill') f.market.account.positions = [{ positionOrderId: 'p', quantity: 1, side: 'LONG', orderPrice: 100 }];
    if (outcome === 'unverified') f.market.account.positionSummariesVerified = false;
    return { ok: true, results: [{ orderId: 'o', cancelled: true }] };
  };
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.deepEqual(cancellations, [['o']]);
  assert.equal(f.analyses.length, outcome === 'flat' ? 1 : 0);
  assert.equal(f.submissions.length, outcome === 'flat' ? 1 : 0);
});
test('unknown entry write stays unresolved and cannot submit again', async t => {
  const f = fixture(t, 'unknown-entry-write');
  f.runtime.submitSuggestionForm = async () => { f.submissions.push('started'); throw Error('CONNECTION_LOST'); };
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.task.pendingAction.status, 'UNVERIFIED');
  await runAnalysis(f.task.id, '', { runtime: f.runtime });
  assert.equal(f.submissions.length, 1);
});

for (const oldPurpose of ['RESCUE', 'LOW_PROBABILITY']) test(`old waiting ${oldPurpose} cannot keep a flat round locked`, async t => {
 const f=fixture(t,`old-waiting-${oldPurpose}`);
 f.task.pendingAction={id:'old-waiting',status:'WAITING',action:'BUY',entryPurpose:oldPurpose==='RESCUE'?'RESCUE':'NORMAL',bullishProfitProbability:0.3999,bearishProfitProbability:0.3};
 await runAnalysis(f.task.id,'',{runtime:f.runtime});
 assert.equal(f.submissions.length,1);
 assert.equal(f.submissions[0].exitType,null);
});
test('retiring an old flat unresolved action updates its existing order record without inventing a fill', async t => {
 const f=fixture(t,'old-existing-order');
 f.task.unsettledActions=[{id:'existing-old',status:'UNVERIFIED',createdAt:new Date(Date.now()-121000).toISOString(),suggestedQty:1,action:'BUY',baselinePositionsVerified:true,baselinePositions:{}}];
 const order={id:'existing-order',taskId:f.task.id,idempotencyKey:'pending:existing-old',status:'submitted'};
 state.orders.unshift(order);t.after(()=>{state.orders=state.orders.filter(item=>item!==order);});
 await runAnalysis(f.task.id,'',{runtime:f.runtime});
 assert.equal(order.status,'reconciled_flat');
 assert.deepEqual(f.task.unsettledActions,[]);
});
