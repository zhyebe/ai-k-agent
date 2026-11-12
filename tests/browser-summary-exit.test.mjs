import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import { chromium } from 'playwright';
import { closeAllBrowserSessions, openBrowserPage, setBrowserSessionFactory, readVisiblePage } from '../server/browser.mjs';
import { summarySignature, summaryKey } from '../server/summary-exit-policy.mjs';
import { submitSuggestionForm } from '../server/tools.mjs';
import { parseHaohanAccount } from '../server/haohan.mjs';
import { parseHaohanPageSnapshot } from '../server/haohan.mjs';
import { runPositionExitCycle, startController, stopAllControllers } from '../server/engine.mjs';
import { state } from '../server/store.mjs';
import { tradeFixture } from './fixtures/trade-page.mjs';
import { tradingPlan } from './fixtures/trading-plan.mjs';
import { observeExecutionMarket } from '../server/market.mjs';
let browser, page;
const fixture = tradeFixture.replace('<body>', '<body><div>DGKZ | 测试商品</div>')
  .replace("['positions','orders','history']", "['positions','orders','history','summary']")
  .replace('<div class="head_l_btns" onclick="orderPane(\'orders\')">', '<div class="head_l_btns" onclick="orderPane(\'summary\')">持仓汇总</div><div class="head_l_btns" onclick="orderPane(\'orders\')">')
  .replace('</body>', `<section id="summary" style="display:none"><table><thead><tr><th>商品名称</th><th>买 | 卖</th><th>订立均价</th><th>存货数量</th><th>委托冻结数量</th><th>实时货值变化</th><th>转让</th></tr></thead><tbody>
<tr data-side="LONG"><td>测试商品</td><td>买入</td><td>99</td><td>3</td><td>0</td><td>1.5</td><td><span class="spotS" onclick="summaryTransfer('LONG',3)">转让</span></td></tr>
<tr data-side="SHORT"><td>测试商品</td><td>卖出</td><td>102</td><td>1</td><td>0</td><td>0.5</td><td><span class="spotS" onclick="summaryTransfer('SHORT',1)">转让</span></td></tr>
</tbody></table></section><script>
window.summaryExits=[];
function summaryTransfer(side,quantity){
 const box=document.createElement('div');box.className='el-dialog';
 box.innerHTML='<div>转让 测试商品</div><div class="inputWrap"><p>转让价格</p><input type="number" value="'+(side==='LONG'?100:101)+'"></div><div class="inputWrap"><p>转让数量</p><input type="number" value="'+quantity+'"></div><button>确定</button><button>取消</button>';
 box.querySelector('button').onclick=()=>{window.summaryExits.push({side,quantity:Number(box.querySelectorAll('input')[1].value),price:Number(box.querySelector('input').value)});box.remove();notice('转让成功')};
 box.querySelectorAll('button')[1].onclick=()=>box.remove();document.body.append(box);
 if(window.summaryFault==='stalePrice')box.querySelector('input').value=side==='LONG'?'500':'1';
 if(window.summaryFault==='movingPrice')box.querySelector('input').addEventListener('input',()=>{document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent='99.99'});
 if(window.summaryFault==='quantity')box.querySelectorAll('input')[1].value='1';
 if(window.summaryFault==='quote')document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent='99.9';
 if(window.summaryFault==='average')document.querySelector('#summary [data-side="LONG"]').cells[2].textContent='99.6';
 if(window.summaryFault==='frozen')document.querySelector('#summary [data-side="LONG"]').cells[4].textContent='1';
}
</script></body>`);
before(async () => {
 browser=await chromium.launch({ ...(process.platform==='darwin'?{channel:'chrome'}:{}),headless:true });
 const context=await browser.newContext();page=await context.newPage();
 await page.route('https://smyw.haohandahan.cn/client/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
 setBrowserSessionFactory(async()=>({browser,context,page,ownsBrowser:false,mode:'test'}));
 await openBrowserPage({sessionId:'summary-browser',url:'https://smyw.haohandahan.cn/client/#/transcc',waitMs:0});
});
beforeEach(async()=>page.reload());
after(async()=>{await closeAllBrowserSessions();setBrowserSessionFactory(null);await browser?.close();});
const input = (side='LONG', extras={}) => {
 const targetSummary={symbol:'DGKZ',symbolName:'测试商品',side,quantity:side==='LONG'?3:1,averagePrice:side==='LONG'?99:102};
 const value={sessionId:'summary-browser',action:side==='LONG'?'SELL':'BUY',symbol:'DGKZ',symbolName:'测试商品',exitType:'TAKE_PROFIT',targetSummary,...extras};
 const expiresAt=new Date(Date.now()+30000).toISOString();
 const average=value.targetSummary.averagePrice,direction=side==='LONG'?1:-1;
 const plan=tradingPlan(side,average,{takeProfitPrice:average+direction,
   profitProtection:{activationPrice:average+direction*0.8,floorPrice:average+direction*0.5,trailingDistance:0.2}});
 const record={id:'ai-review',key:summaryKey(value.targetSummary),signature:summarySignature(value.targetSummary),summary:value.targetSummary,
   plan,bestPrice:average,profitArmed:false,maxHoldAt:new Date(Date.now()+300000).toISOString(),expiresAt};
 value.exitGuard={summary:true,expiresAt,aiAuthorization:{id:'ai-review',decision:'EXIT',signature:record.signature,trigger:'TAKE_PROFIT',record,expiresAt}};
 return value;
};
for(const side of ['LONG','SHORT']) test(`${side} transfers once from the summary row, immediately without AI or detail controls`,async()=>{
 const result=await submitSuggestionForm(input(side,{browserProvider:{baseUrl:'https://must-not-call.invalid',apiKey:'test',model:'test'}}));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.submittedPrice,side==='LONG'?100:101);
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side,quantity:side==='LONG'?3:1,price:side==='LONG'?100:101}]);
 assert.deepEqual(await page.evaluate(()=>window.exits),[]);
 assert.equal(await page.evaluate(()=>window.historyVisits+window.wrongGlobalExit+window.wrongStopDialog),0);
});
for (const side of ['LONG', 'SHORT']) for (const trigger of ['TOTAL_PROFIT', 'HEDGE_LOSS', 'HEDGE_WINNER_DEADLINE', 'HEDGE_WINNER_PULLBACK']) {
 test(`${side} executes the user-authorized ${trigger} through the final dialog`, async () => {
  const value = input(side);
  value.exitGuard.aiAuthorization = { id: 'user-batch-leg', batchId: 'user-batch', source: 'USER_RULE',
   decision: 'EXIT', trigger, signature: summarySignature(value.targetSummary), expiresAt: value.exitGuard.expiresAt };
  const result = await submitSuggestionForm(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.summaryExits),
   [{ side, quantity: side === 'LONG' ? 3 : 1, price: side === 'LONG' ? 100 : 101 }]);
  assert.equal(await page.locator('.el-dialog:visible').count(), 0);
 });
}
for(const fault of ['quote','average','quantity','frozen'])test(`summary ${fault} change before confirmation cancels the entire action`,async()=>{
 await page.evaluate(fault=>{window.summaryFault=fault},fault);
 const result=await submitSuggestionForm(input());
 assert.equal(result.ok,false,JSON.stringify(result));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[]);
 assert.deepEqual(await page.evaluate(()=>window.exits),[]);
 assert.equal(await page.locator('.el-dialog:visible').count(),0);
});
test('missing summary tab fails explicitly without falling back to individual transfers',async()=>{
 await page.locator('.head_l_btns').filter({hasText:'持仓汇总'}).evaluate(node=>node.remove());
 const result=await submitSuggestionForm(input());
 assert.equal(result.ok,false);
 assert.equal(result.code,'EXIT_SUMMARY_NOT_FOUND');
 assert.deepEqual(await page.evaluate(()=>window.exits),[]);
});
test('full account observation collects both summary directions independently of detail IDs',async()=>{
 const snapshot=await readVisiblePage('summary-browser',{quick:true,inspectPositions:true});
 const account=parseHaohanAccount(snapshot.visibleText,snapshot.tables);
 assert.equal(account.positionSummariesVerified,true,JSON.stringify(snapshot.tables));
 assert.equal(account.positionSummaries.length,2);
 assert.equal(account.positionSummaries[0].averagePrice,99);
});

for(const side of ['LONG','SHORT']) test(`${side} refreshes stale numeric dialog price to executable counterparty price`,async()=>{
 await page.evaluate(()=>{window.summaryFault='stalePrice'});
 const result=await submitSuggestionForm(input(side));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side,quantity:side==='LONG'?3:1,price:side==='LONG'?100:101}]);
});
test('market price moving after fill cancels an unmarketable summary limit even when profit remains',async()=>{
 await page.evaluate(()=>{window.summaryFault='movingPrice';document.querySelector('#summary [data-side=\"LONG\"]').cells[2].textContent='99'});
 const result=await submitSuggestionForm(input('LONG',{targetSummary:{symbol:'DGKZ',symbolName:'测试商品',side:'LONG',quantity:3,averagePrice:99}}));
 assert.equal(result.ok,false);
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[]);
});

for (const side of ['LONG','SHORT']) test(`${side} summary exit refreshes a moving executable price while the AI target remains valid`, async () => {
 await page.evaluate(side => {
  const long=side==='LONG';
  document.querySelector('body > table tr:first-child td:nth-child(2)').textContent=long?'103':'99';
  document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent=long?'102':'98';
  const transfer = window.summaryTransfer;
  window.summaryTransfer = (...args) => {
   transfer(...args);
   document.querySelector('.el-dialog input').addEventListener('input', () => {
    document.querySelector(long?'body > table tr:nth-child(2) td:nth-child(2)':'body > table tr:first-child td:nth-child(2)').textContent=long?'101.99':'99.01';
   }, { once: true });
  };
 },side);
 const result = await submitSuggestionForm(input(side));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.submittedPrice,side==='LONG'?101.99:99.01);
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side,quantity:side==='LONG'?3:1,price:side==='LONG'?101.99:99.01}]);
 assert.equal(await page.locator('.el-dialog:visible').count(),0);
});

test('summary repricing is bounded and never submits an obsolete limit', async () => {
 await page.evaluate(() => {
  document.querySelector('body > table tr:first-child td:nth-child(2)').textContent='105';
  document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent='104';
  window.priceRefreshes=0;
  const transfer=window.summaryTransfer;
  window.summaryTransfer=(...args)=>{
   transfer(...args);
   document.querySelector('.el-dialog input').addEventListener('input',()=>{
    window.priceRefreshes++;
    const bid=document.querySelector('body > table tr:nth-child(2) td:nth-child(2)');
    bid.textContent=String(Number(bid.textContent)-0.01);
   });
  };
 });
 const result=await submitSuggestionForm(input());
 assert.equal(result.ok,false,JSON.stringify(result));
 assert.equal(result.code,'EXIT_SUMMARY_PRICE_CHANGED');
 assert.equal(result.uncertain,false);
 assert.equal(await page.evaluate(()=>window.priceRefreshes),3);
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[]);
 assert.equal(await page.locator('.el-dialog:visible').count(),0);
});

test('AI immediate loss exit requires a matching fresh price authorization before transfer', async () => {
 await page.evaluate(() => { document.querySelector('#summary [data-side="LONG"]').cells[2].textContent='102'; });
 const targetSummary={symbol:'DGKZ',symbolName:'测试商品',side:'LONG',quantity:3,averagePrice:102};
 const expiresAt=new Date(Date.now()+30000).toISOString();
 const value={...input('LONG'),exitType:'STOP_LOSS',targetSummary,exitGuard:{summary:true,expiresAt,aiAuthorization:{id:'loss-ai',decision:'EXIT',
   signature:summarySignature(targetSummary),trigger:'AI_EXIT_NOW',exitPrice:100,expiresAt}}};
 assert.equal((await submitSuggestionForm({...value,exitGuard:{summary:true}})).code,'AI_SUMMARY_EXIT_REQUIRED');
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[]);
 const result=await submitSuggestionForm(value);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side:'LONG',quantity:3,price:100}]);
});

test('engine AI target reaches a real isolated summary transfer while model is unavailable', async t => {
 await page.evaluate(() => { document.querySelector('#summary [data-side="SHORT"]').cells[4].textContent='1'; document.querySelector('#orders tbody').innerHTML='<tr><td colspan="11">暂无数据</td></tr>'; });
 const id='browser-profit-round';
 const task={id,mode:'LIVE',autoDecisionEnabled:false,status:'MONITORING',monitoringEnabled:true,rules:[],workflow:[],metrics:{},decision:{action:'HOLD'},target:{browserSessionId:'summary-browser',connectorId:'connector_haohan_readonly'}};
 task.summaryTradingPlans=[input().exitGuard.aiAuthorization.record];
 state.tasks.unshift(task);
 t.after(()=>{stopAllControllers();state.tasks=state.tasks.filter(item=>item!==task);});
 const runtime={observeExecutionMarket:async()=>{
  const snapshot=await readVisiblePage('summary-browser',{quick:true,inspectPositions:true});
  return {...parseHaohanPageSnapshot(snapshot,{symbol:'DGKZ'}),ok:true,observedAt:new Date().toISOString()};
 },submitSuggestionForm,requestSummaryExitDecision:async()=>assert.fail('profit cannot wait for AI')};
 task.nextPollAt=new Date(Date.now()+60000).toISOString();
 startController(id,{runtime,runCycle:async()=>{}});
 const result=await runPositionExitCycle(id,{runtime});
 assert.equal(result.submitted.length,1,JSON.stringify(task.exitMonitor));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side:'LONG',quantity:3,price:100}]);
 assert.deepEqual(await page.evaluate(()=>window.exits),[]);
});
for (const side of ['LONG', 'SHORT']) test(`${side} confirmed stop still transfers when price reaches the hard stop inside the dialog`, async () => {
 const long = side === 'LONG', average = 1327, direction = long ? 1 : -1;
 await page.evaluate(({ side, average }) => {
  document.querySelector(`#summary [data-side="${side}"]`).cells[2].textContent = String(average);
 }, { side, average });
 const value = input(side, { exitType: 'STOP_LOSS', targetSummary: {
  symbol: 'DGKZ', symbolName: '测试商品', side, quantity: long ? 3 : 1, averagePrice: average } });
 const record = value.exitGuard.aiAuthorization.record;
 record.plan = tradingPlan(side, average, { takeProfitPrice: average + direction * 2,
  stopLossPrice: average - direction, hardStopPrice: average - direction * 2 });
 record.lossObservation = { startedAt: Date.now() - 31000, lastObservedAt: Date.now(), price: average - direction };
 value.exitGuard.aiAuthorization.trigger = 'STOP_LOSS';
 await page.evaluate(({ side, average, direction }) => {
  const setPrice = price => {
   document.querySelector('body > table tr:first-child td:nth-child(2)').textContent = String(price + 0.1);
   document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = String(price);
  };
  setPrice(average - direction - (side === 'SHORT' ? 0.1 : 0));
  const transfer = window.summaryTransfer;
  window.summaryTransfer = (...args) => {
   transfer(...args);
   setPrice(average - direction * 2 - (side === 'SHORT' ? 0.1 : 0));
  };
 }, { side, average, direction });
 const result = await submitSuggestionForm(value);
 assert.equal(result.ok, true, JSON.stringify(result));
 assert.deepEqual(await page.evaluate(() => window.summaryExits),
  [{ side, quantity: long ? 3 : 1, price: average - direction * 2 }]);
});
for (const side of ['LONG', 'SHORT']) for (const trigger of ['STOP_LOSS', 'HARD_STOP']) {
 test(`${side} summary fill executes ${trigger} through the actual dialog without detail rows or model`, async t => {
  const average = 1327, direction = side === 'LONG' ? 1 : -1, quantity = side === 'LONG' ? 3 : 1;
  const price = average - direction * (trigger === 'HARD_STOP' ? 2 : 1);
  await page.evaluate(({ side, average, price }) => {
   document.querySelector(`#summary [data-side="${side}"]`).cells[2].textContent = String(average);
   document.querySelector(`#summary [data-side="${side === 'LONG' ? 'SHORT' : 'LONG'}"]`).remove();
   document.querySelector('#orders tbody').innerHTML = '<tr><td colspan="11">暂无数据</td></tr>';
   document.querySelector('body > table tr:first-child td:nth-child(2)').textContent = String(side === 'LONG' ? price + 0.1 : price);
   document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = String(side === 'LONG' ? price : price - 0.1);
  }, { side, average, price });
  const id = `browser-stop-${side}-${trigger}`, observedAt = new Date().toISOString();
  const plan = tradingPlan(side, average, { takeProfitPrice: average + direction * 2,
   stopLossPrice: average - direction, hardStopPrice: average - direction * 2, stopConfirmationSec: 1 });
  const pending = { id: 'entry-risk', action: side === 'LONG' ? 'BUY' : 'SELL', targetSymbol: 'DGKZ', targetSymbolName: '测试商品',
   tradePlan: plan, forecastObservedAt: observedAt, createdAt: observedAt, source: 'auto_takeover',
   status: 'AWAITING_FILL', baselineSummaryQty: 0, suggestedQty: quantity };
  const task = { id, mode: 'LIVE', autoDecisionEnabled: true, status: 'MONITORING', monitoringEnabled: true,
   rules: [], workflow: [], metrics: {}, decision: { action: 'HOLD' }, pendingAction: pending,
   entryForecast: { pendingId: pending.id, action: pending.action, symbol: 'DGKZ', tradePlan: plan, observedAt, confirmedAt: null },
   target: { browserSessionId: 'summary-browser', connectorId: 'connector_haohan_readonly' } };
  state.tasks.unshift(task);
  t.after(() => { stopAllControllers(); state.tasks = state.tasks.filter(item => item !== task); });
  const runtime = { observeExecutionMarket: async () => {
   const snapshot = await readVisiblePage('summary-browser', { quick: true, inspectPositions: true });
   const market = parseHaohanPageSnapshot(snapshot, { symbol: 'DGKZ' });
   return { ...market, ok: true, observedAt: new Date().toISOString(), account: { ...market.account, positionsVerified: false } };
  }, submitSuggestionForm, requestSummaryExitDecision: async () => { throw Error('MODEL_OFFLINE'); } };
  await runPositionExitCycle(id, { runtime });
  if (trigger === 'STOP_LOSS') {
   assert.deepEqual(await page.evaluate(() => window.summaryExits), []);
   await page.waitForTimeout(1100);
   await runPositionExitCycle(id, { runtime });
  }
  assert.equal(task.pendingAction.exitGuard?.aiAuthorization?.trigger, trigger, JSON.stringify(task.exitMonitor));
  assert.deepEqual(await page.evaluate(() => window.summaryExits), [{ side, quantity, price }]);
  assert.deepEqual(await page.evaluate(() => window.exits), []);
 });
}
test('confirmed ordinary stop survives dialog delay but still cancels on an actual recovery', async () => {
 const value = input('LONG', { exitType: 'STOP_LOSS' });
 const record = value.exitGuard.aiAuthorization.record;
 record.plan = tradingPlan('LONG', 99, { stopLossPrice: 100, hardStopPrice: 95 });
 record.lossObservation = { startedAt: Date.now() - 42000, lastObservedAt: Date.now() - 11000, price: 100 };
 value.exitGuard.aiAuthorization.trigger = 'STOP_LOSS';
 const result = await submitSuggestionForm(value);
 assert.equal(result.ok, true, JSON.stringify(result));
 assert.deepEqual(await page.evaluate(() => window.summaryExits), [{ side: 'LONG', quantity: 3, price: 100 }]);
 await page.reload();
 await page.evaluate(() => {
  document.querySelector('body > table tr:first-child td:nth-child(2)').textContent = '101.1';
  document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = '101';
 });
 const recovered = await submitSuggestionForm(value);
 assert.equal(recovered.ok, false);
 assert.deepEqual(await page.evaluate(() => window.summaryExits), []);
});
for (const side of ['LONG', 'SHORT']) for (const insideDialog of [false, true]) {
 test(`${side} flash ${insideDialog ? 'inside the exit dialog cancels before confirmation' : 'waits for real chart confirmation before transfer'}`, async t => {
  const sessionId = `flash-exit-${side}-${insideDialog}`;
  await openBrowserPage({ sessionId, url: 'https://smyw.haohandahan.cn/client/#/transcc', waitMs: 0 });
  const minute = Math.floor(Date.now() / 60000) * 60000 + 120000;
  let now = minute + 50000;
  t.mock.method(Date, 'now', () => now);
  await page.evaluate(({ minute, insideDialog }) => {
   const chart = document.createElement('div'); chart.id = 'hqchart_kline';
   const row = timestamp => ({ timestamp, Date: 20261112, Open: 100, High: 100, Low: 100, Close: 100, Vol: 10 });
   chart.JSChart = { JSChartContainer: { Symbol: 'DGKZ', Period: 4, SourceData: { Data: [row(minute - 60000), row(minute)] } } };
   document.body.append(chart);
   if (insideDialog) {
    const transfer = window.summaryTransfer;
    window.summaryTransfer = (...args) => {
     chart.JSChart.JSChartContainer.SourceData.Data.at(-1).High = 110;
     chart.JSChart.JSChartContainer.SourceData.Data.at(-1).Close = 110;
     transfer(...args);
    };
   }
  }, { minute, insideDialog });
  const value = { ...input(side), sessionId };
  const task = { timeframe: '1m', target: { browserSessionId: sessionId } };
  const connector = { adapterId: 'haohan-readonly', reviewStatus: 'APPROVED', capabilities: ['read_visible_market'] };
  const sample = async seconds => {
   now = minute + seconds * 1000;
   await observeExecutionMarket(task, connector, { target: { symbol: 'DGKZ', symbolName: '测试商品' } });
  };
  if (insideDialog) for (const second of [50, 52, 54, 56]) await sample(second);
  const first = await submitSuggestionForm(value);
  assert.equal(first.code, 'EXIT_AWAITING_CONFIRMED_PRICE', JSON.stringify(first));
  assert.equal(first.submitted, false);
  assert.notEqual(first.uncertain, true);
  assert.deepEqual(await page.evaluate(() => window.summaryExits), []);
  assert.equal(await page.locator('.el-dialog:visible').count(), 0);
  if (!insideDialog) {
   value.exitGuard.requireConfirmedPrice = true;
   for (const second of [52, 54, 56]) await sample(second);
   const fixed = await submitSuggestionForm(value);
   assert.equal(fixed.ok, true, JSON.stringify(fixed));
   assert.equal((await page.evaluate(() => window.summaryExits)).length, 1);
  }
 });
}
test('a deferred exit cannot submit when its chart has disappeared', async () => {
 const value = input();
 value.exitGuard.requireConfirmedPrice = true;
 const result = await submitSuggestionForm(value);
 assert.equal(result.code, 'EXIT_AWAITING_CONFIRMED_PRICE');
 assert.equal(result.submitted, false);
 assert.deepEqual(await page.evaluate(() => window.summaryExits), []);
});
