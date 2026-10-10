// Mirrors the public Haohan templates: input buttons, div tabs, span row actions,
// delayed transfer dialog, and native/Vue-style input/change handlers.
export const tradeFixture = `<!doctype html><html><head><title>Trade controls fixture</title></head><body>
<table><tr><td>销售①</td><td>101</td><td>20</td></tr><tr><td>采购①</td><td>100</td><td>30</td></tr></table>
<div class="trade_btn" onclick="direction('BUY')">买入</div>
<div class="trade_btn" onclick="direction('SELL')">卖出</div>
<div class="tab_btn" onclick="pane('entry')">订立</div>
<div class="tab_btn" onclick="pane('transfer')">转让</div>
<div style="display:none"><li><span>买价</span><input value="hidden"></li></div>
<section id="entry">
  <div id="buy"><li><span>买价</span><input id="buy-price" type="number"></li><li><span>买量</span><input id="buy-qty" type="number"></li>
    <input type="button" value="买入订立" onclick="enter('BUY')">
    <div class="cotract"><label class="el-checkbox"><input type="checkbox" onchange="window.agreementChanges++"></label>我已同意签署<span>《订单商品销售协议》</span></div>
  </div>
  <div id="sell" style="display:none"><li><span>卖价</span><input id="sell-price" type="number"></li><li><span>卖量</span><input id="sell-qty" type="number"></li>
    <input type="button" value="卖出订立" onclick="enter('SELL')">
    <div class="cotract"><label class="el-checkbox"><input type="checkbox" onchange="window.agreementChanges++"></label>我已同意签署<span>《订单商品销售协议》</span></div>
  </div>
</section>
<section id="transfer" style="display:none"><li><span>转让价</span><input></li><li><span>转让量</span><input></li><input type="button" value="卖出转让" onclick="window.wrongGlobalExit++"></section>
<div class="header_l_item" onclick="orderPane('positions')">持仓明细</div>
<div class="head_l_btns" onclick="orderPane('orders')">当前委托</div>
<div class="head_l_btns" onclick="orderPane('history')">历史委托</div>
<section id="orders" style="display:none"><div class="head_l_btns" onclick="cancelSelected()">撤单</div><div onclick="window.wrongCancelAll++">全撤</div>
<table><thead><tr><th></th><th>委托单号</th><th>商品名称</th><th>买 | 卖</th><th>委托价格</th><th>订立 | 转让</th><th>委托数量</th><th>已成交数量</th><th>未成交数量</th><th>状态</th><th>委托时间</th></tr></thead><tbody>
<tr><td><input type="checkbox"></td><td>O-10</td><td>测试商品</td><td>卖出</td><td>20</td><td>订立</td><td>1</td><td>0</td><td>1</td><td>已委托</td><td>2026-10-10 10:00:00</td></tr>
<tr><td><input type="checkbox"></td><td>O-1</td><td>测试商品</td><td>买入</td><td>20</td><td>订立</td><td>3</td><td>1</td><td>2</td><td>部分成交</td><td>2026-10-10 10:00:00</td></tr>
<tr><td><input type="checkbox" checked></td><td>O-2</td><td>测试商品</td><td>买入</td><td>21</td><td>订立</td><td>1</td><td>0</td><td>1</td><td>已委托</td><td>2026-10-10 10:01:00</td></tr>
</tbody></table></section>
<section id="history" style="display:none"><table><thead><tr><th></th><th>委托单号</th><th>商品名称</th><th>买 | 卖</th><th>委托价格</th><th>订立 | 转让</th><th>委托数量</th><th>已成交数量</th><th>未成交数量</th><th>状态</th><th>委托时间</th></tr></thead><tbody></tbody></table></section>
<table id="positions"><thead><tr><th>商品名称</th><th>买 | 卖</th><th>存货数量</th><th>持仓单号</th><th>转让</th><th>止盈 | 止损</th></tr></thead><tbody>
<tr><td>测试商品</td><td>卖出</td><td>1</td><td>P-10</td><td><span class="spotS" onclick="transfer('P-10',1)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
<tr><td>测试商品</td><td>买入</td><td>2</td><td>P-1</td><td><span class="spotS" onclick="transfer('P-1',2)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
<tr><td>测试商品</td><td>买入</td><td>1</td><td>P-2</td><td><span class="spotS" onclick="transfer('P-2',1)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
</tbody></table>
<script>
window.entries=[];window.exits=[];window.agreementChanges=0;window.wrongStopDialog=0;window.wrongGlobalExit=0;
window.cancelled=[];window.wrongCancelAll=0;
function orderPane(name){for(const id of ['positions','orders','history'])document.querySelector('#'+id).style.display=id===name?'':'none'}
function cancelSelected(){const selected=[...document.querySelectorAll('#orders tbody tr')].filter(row=>row.querySelector('input').checked);if(selected.length!==1){notice('撤单失败，选单错误');return}const row=selected[0];const box=document.createElement('div');box.className='el-dialog';box.innerHTML='您确定要撤单吗?<button>确认</button><button>取消</button>';box.querySelector('button').onclick=()=>{box.remove();if(window.cancelRejected){notice('撤单失败');return}if(window.fillDuringCancel){row.cells[9].textContent='已成交';row.cells[8].textContent='0';document.querySelector('#history tbody').append(row);notice('委托已成交');return}window.cancelled.push({id:row.cells[1].textContent,remaining:Number(row.cells[8].textContent)});row.cells[9].textContent=Number(row.cells[7].textContent)>0?'部分成交后撤单':'已撤单';document.querySelector('#history tbody').append(row);if(!window.silentCancellation)notice('撤单成功')};document.body.append(box)}
function direction(side){document.querySelector('#buy').style.display=side==='BUY'?'':'none';document.querySelector('#sell').style.display=side==='SELL'?'':'none'}
function pane(name){document.querySelector('#entry').style.display=name==='entry'?'':'none';document.querySelector('#transfer').style.display=name==='transfer'?'':'none'}
function notice(text){document.querySelector('.el-message')?.remove();const div=document.createElement('div');div.className='el-message';div.textContent=text;document.body.append(div)}
function enter(side){const root=document.querySelector(side==='BUY'?'#buy':'#sell');if(!root.querySelector('[type=checkbox]').checked){notice('协议未勾选，提交失败');return}setTimeout(()=>{const box=document.createElement('div');box.className='el-message-box';box.innerHTML='确认下单，是否继续？<button>确 定</button><button>取消</button>';box.querySelector('button').onclick=()=>{window.entries.push({side,price:root.querySelector('input[type=number]').value,quantity:root.querySelectorAll('input[type=number]')[1].value});box.remove();notice('提交成功')};document.body.append(box)},500)}
function transfer(id,quantity){setTimeout(()=>{const box=document.createElement('div');box.className='el-dialog';box.innerHTML='<div>转让 测试商品</div><div class="inputWrap"><p>转让价格</p><div><input type="number" value="19"></div></div><div class="inputWrap"><p>转让数量</p><div><input type="number" value="'+quantity+'" disabled></div></div><button>确 定</button><button>取 消</button>';box.querySelector('button').onclick=()=>{window.exits.push({id,price:box.querySelector('input').value,quantity:box.querySelectorAll('input')[1].value});box.remove();notice('转让成功 '+id)};document.body.append(box);setTimeout(()=>{if(box.isConnected)box.querySelector('input').value='19.5'},200)},500)}
</script></body></html>`;
