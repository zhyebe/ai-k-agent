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
<div class="header_l_item" onclick="document.querySelector('#positions').style.display=''">持仓明细</div>
<table id="positions"><thead><tr><th>商品名称</th><th>买 | 卖</th><th>存货数量</th><th>持仓单号</th><th>转让</th><th>止盈 | 止损</th></tr></thead><tbody>
<tr><td>测试商品</td><td>卖出</td><td>1</td><td>P-10</td><td><span class="spotS" onclick="transfer('P-10',1)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
<tr><td>测试商品</td><td>买入</td><td>2</td><td>P-1</td><td><span class="spotS" onclick="transfer('P-1',2)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
<tr><td>测试商品</td><td>买入</td><td>1</td><td>P-2</td><td><span class="spotS" onclick="transfer('P-2',1)">转让</span></td><td><span class="spotS" onclick="window.wrongStopDialog++">止盈止损</span></td></tr>
</tbody></table>
<script>
window.entries=[];window.exits=[];window.agreementChanges=0;window.wrongStopDialog=0;window.wrongGlobalExit=0;
function direction(side){document.querySelector('#buy').style.display=side==='BUY'?'':'none';document.querySelector('#sell').style.display=side==='SELL'?'':'none'}
function pane(name){document.querySelector('#entry').style.display=name==='entry'?'':'none';document.querySelector('#transfer').style.display=name==='transfer'?'':'none'}
function notice(text){document.querySelector('.el-message')?.remove();const div=document.createElement('div');div.className='el-message';div.textContent=text;document.body.append(div)}
function enter(side){const root=document.querySelector(side==='BUY'?'#buy':'#sell');if(!root.querySelector('[type=checkbox]').checked){notice('协议未勾选，提交失败');return}setTimeout(()=>{const box=document.createElement('div');box.className='el-message-box';box.innerHTML='确认下单，是否继续？<button>确 定</button><button>取消</button>';box.querySelector('button').onclick=()=>{window.entries.push({side,price:root.querySelector('input[type=number]').value,quantity:root.querySelectorAll('input[type=number]')[1].value});box.remove();notice('提交成功')};document.body.append(box)},500)}
function transfer(id,quantity){setTimeout(()=>{const box=document.createElement('div');box.className='el-dialog';box.innerHTML='<div>转让 测试商品</div><div class="inputWrap"><p>转让价格</p><div><input type="number" value="19"></div></div><div class="inputWrap"><p>转让数量</p><div><input type="number" value="'+quantity+'" disabled></div></div><button>确 定</button><button>取 消</button>';box.querySelector('button').onclick=()=>{window.exits.push({id,price:box.querySelector('input').value,quantity:box.querySelectorAll('input')[1].value});box.remove();notice('转让成功 '+id)};document.body.append(box);setTimeout(()=>{if(box.isConnected)box.querySelector('input').value='19.5'},200)},500)}
</script></body></html>`;
