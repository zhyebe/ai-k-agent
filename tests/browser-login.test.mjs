import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, resolveSnapshotControl, setBrowserSessionFactory } from "../server/browser.mjs";
import { browserLoginStatus, browserLoginWithCredential, browserScanControls } from "../server/tools.mjs";
import { parseHaohanPageSnapshot } from "../server/haohan.mjs";
import { createProvider } from "../server/provider.mjs";
import { loginFixture } from "./fixtures/login-page.mjs";

const target = "https://smyw.haohandahan.cn/client/#/transcc";
const sessionId = "login-fixture";
const input = { sessionId, adapterId: "haohan-readonly", targetUrl: target, submit: true };
let browser, page;
before(async () => {
  browser = await chromium.launch({ ...(process.platform === "darwin" ? { channel: "chrome" } : {}), headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<style>
    .el-checkbox { display: inline-block; cursor: pointer; }
    .el-checkbox__input { display: inline-block; position: relative; }
    .el-checkbox__inner { display: inline-block; width: 14px; height: 14px; border: 1px solid; }
    .el-checkbox__original { opacity: 0; position: absolute; width: 0; height: 0; margin: 0; }
    .note { cursor: pointer; }
  </style><div id="view"></div><script>
    sessionStorage.setItem('sessionStr', 'expired-fixture'); sessionStorage.setItem('userId', 'fixture');
    function render() {
      document.getElementById('view').innerHTML = location.hash === '#/login'
        ? (sessionStorage.getItem('ai-fixture') ? '<section aria-label="账户登录"><label>账号<input name="account" type="text"></label><label>登录密码<input name="secret" type="password"></label>' +
          (sessionStorage.getItem('checkbox-style') === 'element'
            ? '<label class="el-checkbox"><span class="el-checkbox__input"><span class="el-checkbox__inner"></span><input type="checkbox" aria-hidden="false" class="el-checkbox__original" value="1"></span><span class="el-checkbox__label">阅读并同意 <span class="note">《风险告知》</span><span class="note">《入市须知》</span><span class="note">《用户协议》</span><span class="note">《隐私政策》</span></span></label>'
            : '<label><input type="checkbox">我已阅读并同意协议</label>') +
          '<button type="button" data-action="signin">进入系统</button></section>' : '<input placeholder="请输入手机号码"><input type="password" placeholder="请输入密码"><button id="login-submit">登录</button>')
        : '<div id="v-content">最新价 103 持仓明细</div>';
      document.getElementById('login-submit')?.addEventListener('click', () => { location.hash = '#/transcc'; });
      const consent = document.querySelector('input[type="checkbox"]');
      if (consent) consent.checked = sessionStorage.getItem('consent-checked') === 'true';
      window.consentChanges = 0; window.documentOpens = 0; window.submissions = 0;
      consent?.addEventListener('change', () => { window.consentChanges += 1; });
      document.querySelectorAll('.note').forEach(node => node.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); window.documentOpens += 1;
      }));
      document.querySelector('[data-action="signin"]')?.addEventListener('click', () => {
        window.submissions += 1;
        if (consent.checked && document.querySelector('[name="account"]').value === 'fixture' && document.querySelector('[name="secret"]').value === 'fixture-password') location.hash = '#/transcc';
      });
    }
    addEventListener('hashchange', render); render();
  </script>` }));
  setBrowserSessionFactory(async () => ({ browser, context, page, ownsBrowser: false, mode: "test" }));
  await openBrowserPage({ sessionId, url: target, waitMs: 0 });
});
after(async () => { await closeAllBrowserSessions(); setBrowserSessionFactory(null); await browser?.close(); });

test("visible expiry overrides a trading URL, stale quote and stored session keys", async () => {
  await page.goto(target);
  await page.locator("#view").evaluate(el => el.insertAdjacentHTML("beforeend", '<div role="alert">登录已过期，请重新登录</div>'));
  assert.equal((await browserLoginStatus(input)).authenticated, false);
  assert.equal(parseHaohanPageSnapshot({ url: target, visibleText: await page.locator("body").innerText() }).code, "REAUTH_REQUIRED");
});

test("expired trading screen opens the known login route, fills saved credentials and returns to monitoring", async () => {
  await page.goto(target);
  await page.locator("#view").evaluate(el => el.insertAdjacentHTML("beforeend", '<div role="alert">登录状态失效，请重新登录</div>'));
  const result = await browserLoginWithCredential(input, { username: "fixture", password: "fixture-password", target: { url: target } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authenticated, true);
  assert.equal(page.url(), target);
  assert.equal((await browserLoginStatus(input)).authenticated, true);
});

test("recognized login completes without a response from the configured browser model", async () => {
  await page.goto(target.replace("transcc", "login"));
  await page.evaluate(() => sessionStorage.removeItem("ai-fixture"));
  await page.reload();
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = createProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "unresponsive-fixture", apiKey: "synthetic" });
  try {
    const started = Date.now();
    const result = await browserLoginWithCredential({ ...input, browserProvider: provider }, { username: "fixture", password: "fixture-password", target: { url: target } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(requests, 0, "verified login controls must not wait on the language model");
    assert.ok(Date.now() - started < 8000);
    assert.equal((await browserLoginStatus(input)).authenticated, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("hidden old error and a trade-password dialog do not expire a valid trading session", async () => {
  await page.goto(target);
  await page.locator("#v-content").waitFor();
  await page.locator("#view").evaluate(el => el.insertAdjacentHTML("beforeend", '<div hidden>登录已过期，请重新登录</div><div>请输入交易密码<input type="password"><button>确认买入</button></div>'));
  assert.equal((await browserLoginStatus(input)).authenticated, true);
  assert.notEqual(parseHaohanPageSnapshot({ url: target, visibleText: await page.locator("body").innerText() }).code, "REAUTH_REQUIRED");
});

test("last-login information on a valid quotation page is not an expired session", async () => {
  await page.goto(target.replace("transcc", "quotationList"));
  await page.locator("#view").evaluate(el => { el.innerHTML = '<div id="v-content">商品列表 上次登录时间：2026-10-17</div>'; });
  assert.equal((await browserLoginStatus(input)).authenticated, true);
});

for (const style of ["native", "element"]) for (const checked of [false, true]) test(`AI login accepts ${style} consent initially ${checked ? "checked" : "unchecked"}`, async () => {
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const message = payload.messages.at(-1);
    const context = JSON.parse(message.content).context;
    const controls = context.page.controls;
    const username = controls.find((control) => control.role === "textbox" && control.type !== "password");
    const password = controls.find((control) => control.type === "password");
    const consent = controls.find((control) => control.role === "checkbox");
    const submit = controls.find((control) => control.role === "button" && /进入系统/.test(control.label));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ goal: "LOGIN", actions: [
      { type: "fill", field: "username", controlId: username.id, label: username.label },
      { type: "fill", field: "password", controlId: password.id, label: password.label },
      { type: "accept_agreement", field: "consent", controlId: consent.id, label: consent.label },
      { type: "click", field: "submit", controlId: submit.id, label: submit.label },
    ] }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const provider = createProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fixture", apiKey: "key" });
  try {
    await page.goto(target.replace("transcc", "login"));
    await page.evaluate(({ style, checked }) => {
      sessionStorage.setItem("ai-fixture", "1");
      sessionStorage.setItem("checkbox-style", style);
      sessionStorage.setItem("consent-checked", String(checked));
    }, { style, checked });
    await page.reload();
    const scanned = await browserScanControls({ sessionId });
    assert.equal(scanned.ok, true);
    assert.ok(scanned.controls.some((control) => control.type === "password"));
    const checkboxes = scanned.controls.filter(control => control.role === "checkbox");
    assert.equal(checkboxes.length, 1);
    assert.match(checkboxes[0].label, /同意/);
    assert.equal(checkboxes[0].checked, checked);
    const filled = await browserLoginWithCredential({ ...input, submit: false, browserProvider: provider }, { username: "fixture", password: "fixture-password", target: { url: target } });
    assert.equal(filled.code, "LOGIN_FILLED_NOT_SUBMITTED", JSON.stringify(filled));
    assert.equal(await page.locator('input[type="checkbox"]').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => ({ changes: window.consentChanges, opens: window.documentOpens, submissions: window.submissions })), { changes: checked ? 0 : 1, opens: 0, submissions: 0 });
    const result = await browserLoginWithCredential({ ...input, browserProvider: provider }, { username: "fixture", password: "fixture-password", target: { url: target } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authenticated, true);
    assert.equal(page.url(), target);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("snapshot checkbox rejects a disabled associated input or a replaced label", async () => {
  await page.goto(target.replace("transcc", "login"));
  await page.evaluate(() => { sessionStorage.setItem("ai-fixture", "1"); sessionStorage.setItem("checkbox-style", "element"); });
  await page.reload();
  const snapshot = await browserScanControls({ sessionId });
  const consent = snapshot.controls.find(control => control.role === "checkbox");
  assert.ok(consent);
  await page.locator('input[type="checkbox"]').evaluate(node => { node.disabled = true; });
  assert.equal(await resolveSnapshotControl(page, consent.id, { role: "checkbox" }), null);
  assert.equal((await browserScanControls({ sessionId })).controls.some(control => control.role === "checkbox"), false);
  await page.reload();
  assert.equal(await resolveSnapshotControl(page, consent.id, { role: "checkbox" }), null);
});

for (const scenario of ["redraw", "rejected", "ambiguous", "expired", "quotation-landing"]) test(`current public login form: ${scenario}`, async t => {
  const pattern = "https://smyw.haohandahan.cn/client/**";
  await page.route(pattern, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: scenario === "quotation-landing" ? loginFixture.replace("location.hash = '#/transcc'", "location.hash = '#/quotationList'") : loginFixture }));
  t.after(() => page.unroute(pattern));
  await page.goto(target.replace("transcc", "login"));
  await page.reload();
  if (scenario === "ambiguous") await page.locator('input[type="text"]').evaluate(node => node.after(node.cloneNode(true)));
  if (scenario === "expired") {
    await page.goto(target);
    await page.locator("#view").evaluate(node => node.insertAdjacentHTML("beforeend", '<div role="alert">登录已过期，请重新登录</div>'));
  }
  const started = Date.now();
  const result = await browserLoginWithCredential(input, { username: "fixture", password: scenario === "rejected" ? "wrong-fixture-password" : "fixture-password", target: { url: target } });
  assert.equal(result.ok, !["rejected", "ambiguous"].includes(scenario), JSON.stringify(result));
  assert.ok(Date.now() - started < 8000, "known controls and explicit rejection do not wait for the model or full success timeout");
  // Navigation to a new document resets fixture counters after quotation landing.
  if (scenario === "quotation-landing") {
    assert.equal(page.url(), target);
    assert.equal(result.targetReached, true);
    return;
  }
  assert.equal(await page.evaluate(() => window.loginAttempts), scenario === "ambiguous" ? 0 : 1);
  assert.equal(await page.evaluate(() => window.documentOpens), 0);
  if (scenario === "ambiguous") assert.equal(await page.locator('input[type="password"]').inputValue(), "");
  else {
    assert.equal(await page.evaluate(() => window.agreementChanges), 1);
    assert.equal(await page.evaluate(() => window.redraws), 2);
  }
  if (scenario === "rejected") { assert.equal(result.code, "LOGIN_REJECTED"); assert.equal(result.stage, "verify"); }
});
