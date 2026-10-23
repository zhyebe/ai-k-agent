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
 value.exitGuard={summary:true,programProfit:true,expiresAt,unusedLegacyAuthorization:{id:'ai-review',decision:'EXIT',key:summaryKey(value.targetSummary),signature:summarySignature(value.targetSummary),reviewType:'TAKE_PROFIT',expiresAt}};
 return value;
};
for(const side of ['LONG','SHORT']) test(`${side} transfers once from the summary row, immediately without AI or detail controls`,async()=>{
 const result=await submitSuggestionForm(input(side,{browserProvider:{baseUrl:'https://must-not-call.invalid',apiKey:'test',model:'test'}}));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side,quantity:side==='LONG'?3:1,price:side==='LONG'?100:101}]);
 assert.deepEqual(await page.evaluate(()=>window.exits),[]);
 assert.equal(await page.evaluate(()=>window.historyVisits+window.wrongGlobalExit+window.wrongStopDialog),0);
});
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

test('loss at -2 points requires matching fresh AI EXIT authorization before browser transfer', async () => {
 await page.evaluate(() => { document.querySelector('#summary [data-side="LONG"]').cells[2].textContent='102'; });
 const targetSummary={symbol:'DGKZ',symbolName:'测试商品',side:'LONG',quantity:3,averagePrice:102};
 const expiresAt=new Date(Date.now()+30000).toISOString();
 const value={...input('LONG'),exitType:'STOP_LOSS',targetSummary,exitGuard:{summary:true,expiresAt,aiAuthorization:{id:'loss-ai',decision:'EXIT',signature:summarySignature(targetSummary),reviewType:'STOP_LOSS',expiresAt}}};
 assert.equal((await submitSuggestionForm({...value,exitGuard:{summary:true}})).code,'AI_SUMMARY_EXIT_REQUIRED');
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[]);
 const result=await submitSuggestionForm(value);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(await page.evaluate(()=>window.summaryExits),[{side:'LONG',quantity:3,price:100}]);
});

test('engine profit trigger reaches a real isolated summary transfer without any AI request', async t => {
 await page.evaluate(() => { document.querySelector('#summary [data-side="SHORT"]').cells[2].textContent='101.5'; document.querySelector('#orders tbody').innerHTML='<tr><td colspan="11">暂无数据</td></tr>'; });
 const id='browser-profit-round';
 const task={id,mode:'LIVE',autoDecisionEnabled:false,status:'MONITORING',monitoringEnabled:true,rules:[],workflow:[],metrics:{},decision:{action:'HOLD'},target:{browserSessionId:'summary-browser',connectorId:'connector_haohan_readonly'}};
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
