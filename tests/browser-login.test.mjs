import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, setBrowserSessionFactory } from "../server/browser.mjs";
import { browserLoginStatus, browserLoginWithCredential, browserScanControls } from "../server/tools.mjs";
import { parseHaohanPageSnapshot } from "../server/haohan.mjs";
import { createProvider } from "../server/provider.mjs";

const target = "https://smyw.haohandahan.cn/client/#/transcc";
const sessionId = "login-fixture";
const input = { sessionId, adapterId: "haohan-readonly", targetUrl: target, submit: true };
let browser, page;
before(async () => {
  browser = await chromium.launch({ ...(process.platform === "darwin" ? { channel: "chrome" } : {}), headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<div id="view"></div><script>
    sessionStorage.setItem('sessionStr', 'expired-fixture'); sessionStorage.setItem('userId', 'fixture');
    function render() {
      document.getElementById('view').innerHTML = location.hash === '#/login'
        ? (sessionStorage.getItem('ai-fixture') ? '<section aria-label="账户登录"><label>账号<input name="account" type="text"></label><label>登录密码<input name="secret" type="password"></label><label><input type="checkbox">我已阅读并同意协议</label><button type="button" data-action="signin">进入系统</button></section>' : '<input placeholder="请输入手机号码"><input type="password" placeholder="请输入密码"><button id="login-submit">登录</button>')
        : '<div id="v-content">最新价 103 持仓明细</div>';
      document.getElementById('login-submit')?.addEventListener('click', () => { location.hash = '#/transcc'; });
      document.querySelector('[data-action="signin"]')?.addEventListener('click', () => { location.hash = '#/transcc'; });
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

test("AI snapshot selects updated login controls without adapter selectors", async () => {
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
    await page.evaluate(() => sessionStorage.setItem("ai-fixture", "1"));
    await page.reload();
    const scanned = await browserScanControls({ sessionId });
    assert.equal(scanned.ok, true);
    assert.ok(scanned.controls.some((control) => control.type === "password"));
    const result = await browserLoginWithCredential({ ...input, browserProvider: provider }, { username: "fixture", password: "fixture-password", target: { url: target } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authenticated, true);
    assert.equal(page.url(), target);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
