import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import { chromium } from 'playwright';
import { closeAllBrowserSessions, openBrowserPage, setBrowserSessionFactory, readVisiblePage } from '../server/browser.mjs';
import { submitSuggestionForm } from '../server/tools.mjs';
import { parseHaohanAccount } from '../server/haohan.mjs';
import { tradeFixture } from './fixtures/trade-page.mjs';
let browser, page;
const fixture = tradeFixture.replace('<body>', '<body><div>DGKZ | 测试商品</div>')
  .replace("['positions','orders','history']", "['positions','orders','history','summary']")
  .replace('<div class="head_l_btns" onclick="orderPane(\'orders\')">', '<div class="head_l_btns" onclick="orderPane(\'summary\')">持仓汇总</div><div class="head_l_btns" onclick="orderPane(\'orders\')">')
  .replace('</body>', `<section id="summary" style="display:none"><table><thead><tr><th>商品名称</th><th>买 | 卖</th><th>订立均价</th><th>存货数量</th><th>委托冻结数量</th><th>实时货值变化</th><th>转让</th></tr></thead><tbody>
<tr data-side="LONG"><td>测试商品</td><td>买入</td><td>99.5</td><td>3</td><td>0</td><td>1.5</td><td><span class="spotS" onclick="summaryTransfer('LONG',3)">转让</span></td></tr>
<tr data-side="SHORT"><td>测试商品</td><td>卖出</td><td>101.5</td><td>1</td><td>0</td><td>0.5</td><td><span class="spotS" onclick="summaryTransfer('SHORT',1)">转让</span></td></tr>
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
const input = (side='LONG', extras={}) => ({sessionId:'summary-browser',action:side==='LONG'?'SELL':'BUY',symbol:'DGKZ',symbolName:'测试商品',exitType:'TAKE_PROFIT',
 targetSummary:{symbol:'DGKZ',symbolName:'测试商品',side,quantity:side==='LONG'?3:1,averagePrice:side==='LONG'?99.5:101.5},
 exitGuard:{summary:true,expiresAt:new Date(Date.now()+30000).toISOString()},...extras});
for(const side of ['LONG','SHORT']) test(`${side} transfers once from the summary row, with no detail controls or AI`,async()=>{
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
 assert.equal(account.positionSummaries[0].averagePrice,99.5);
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
