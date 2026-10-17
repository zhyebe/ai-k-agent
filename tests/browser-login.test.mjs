import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, setBrowserSessionFactory } from "../server/browser.mjs";
import { browserLoginStatus, browserLoginWithCredential } from "../server/tools.mjs";
import { parseHaohanPageSnapshot } from "../server/haohan.mjs";

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
        ? '<input placeholder="请输入手机号码"><input type="password" placeholder="请输入密码"><button id="login-submit">登录</button>'
        : '<div id="v-content">最新价 103 持仓明细</div>';
      document.getElementById('login-submit')?.addEventListener('click', () => { location.hash = '#/transcc'; });
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
