// Current public login contract: visible Element UI label wraps a hidden input.
// Synthetic credentials only; no network requests or production login.
export const loginFixture = `<!doctype html><html><head><title>Login fixture</title><style>
.el-checkbox { display:inline-block; }
.el-checkbox__original { position:absolute;opacity:0;width:0;height:0; }
</style></head><body><div id="view"></div><script>
window.loginAttempts = 0; window.agreementChanges = 0; window.documentOpens = 0;
window.redraws = 0; window.redrawLogin = true;
function renderLogin() {
  if (location.hash !== '#/login') {
    document.querySelector('#view').innerHTML = '<div id="v-content">商品列表 最新价 100 持仓明细</div>';
    return;
  }
  document.querySelector('#view').innerHTML = '<h4>登录</h4><input placeholder="请输入手机号码" type="text"><input placeholder="请输入密码" type="password"><label class="el-checkbox"><input type="checkbox" class="el-checkbox__original">阅读并同意 <a href="#">《用户协议》</a></label><button type="button">登录</button>';
  const inputs = document.querySelectorAll('#view > input');
  const submit = () => {
    window.loginAttempts++;
    if (!document.querySelector('[type=checkbox]').checked || inputs[0].value !== 'fixture' || inputs[1].value !== 'fixture-password') {
      const alert = document.createElement('div'); alert.className='el-message'; alert.textContent='账号或密码错误'; document.body.append(alert); return;
    }
    sessionStorage.setItem('sessionStr','synthetic-session'); sessionStorage.setItem('userId','synthetic-user');
    location.hash = '#/transcc';
  };
  document.querySelector('button').onclick = submit;
  for (const input of inputs) input.oninput = () => {
    if (!window.redrawLogin) return;
    const old = document.querySelector('button'); const fresh = old.cloneNode(true);
    fresh.removeAttribute('data-axiom-control'); fresh.onclick = submit; old.replaceWith(fresh); window.redraws++;
  };
  document.querySelector('[type=checkbox]').onchange = () => { window.agreementChanges++; };
  document.querySelector('a').onclick = event => { event.preventDefault(); event.stopPropagation(); window.documentOpens++; };
}
addEventListener('hashchange',renderLogin); renderLogin();
</script></body></html>`;
