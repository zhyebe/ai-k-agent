import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let browser;
let baseUrl;
let sample;
const userA = { id: "user-a", username: "user-a", displayName: "用户 A" };
const userB = { id: "user-b", username: "user-b", displayName: "用户 B" };
const emptyWorkspace = { tasks: [], skills: [], providers: [], events: [], runs: [], connectors: [], orders: [], agentRuns: [], credentials: [] };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  sample = structuredClone((await server.ssrLoadModule("/src/data/demo.ts")).demoWorkspace);
  sample.tasks = [{ ...sample.tasks[0], id: "task-a", name: "A-private-task", providerId: "provider-a", ownerUserId: userA.id }];
  sample.providers = ["a", "other"].map((id) => ({ id: `provider-${id}`, name: `A-private-provider-${id}`, baseUrl: "https://example.test", model: "model", configured: true, owned: true, status: "模型可用" }));
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
});

after(async () => { await browser?.close(); await server?.close(); });

async function openPage(t, { failLogout = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const logoutStarted = deferred();
  const releaseLogout = deferred();
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    releaseProvider.resolve(); releaseLogout.resolve();
    await context.close();
    assert.deepEqual(errors, []);
  });
  await page.addInitScript(({ apiUrl }) => {
    localStorage.setItem("axiom.user.token", "session-A");
    window.disconnectCalls = 0;
    window.axiomDesktop = {
      apiBaseUrl: apiUrl, platform: "darwin",
      api: { setBaseUrl: async () => {} },
      ai: {
        connect: async () => ({ ok: true }),
        disconnect: async () => {
          window.disconnectCalls++;
          if (window.holdDisconnect) {
            window.disconnectWait ||= new Promise((resolve) => { window.releaseDisconnect = resolve; });
            await window.disconnectWait;
          }
          return { ok: true };
        },
      },
    };
    const originalFetch = window.fetch;
    window.fetch = (url, options) => originalFetch(url, String(url).endsWith("/task-a/provider") ? { ...options, signal: undefined } : options);
  }, { apiUrl: baseUrl });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const token = request.headers()["x-user-token"];
    if (path === "/api/user/session") return route.fulfill({ json: { authenticated: true, user: userA } });
    if (path === "/api/health") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace") return route.fulfill({ json: { ...(token === "session-A" ? sample : emptyWorkspace), auth: { user: token === "session-A" ? userA : userB } } });
    if (path === "/api/user/login") return route.fulfill({ json: { token: "session-B", user: userB } });
    if (path === "/api/tasks/task-a/provider") {
      assert.equal(token, "session-A");
      providerStarted.resolve();
      await releaseProvider.promise;
      return route.fulfill({ json: { task: { ...sample.tasks[0], providerId: "provider-other" } } });
    }
    if (path === "/api/user/logout") {
      assert.equal(token, "session-A");
      logoutStarted.resolve();
      await releaseLogout.promise;
      return route.fulfill(failLogout ? { status: 503, json: { error: "USER_LOGOUT_FAILED" } } : { json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "UNEXPECTED_TEST_REQUEST" } });
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "连接器", exact: true }).first().click();
  await page.locator(".provider-row").filter({ hasText: "A-private-provider-other" }).waitFor();
  return { page, providerStarted, releaseProvider, logoutStarted, releaseLogout };
}

test("logout removes all workspace state, waits for task and browser shutdown, and rejects A's late response after B logs in", async (t) => {
  const { page, providerStarted, releaseProvider, logoutStarted, releaseLogout } = await openPage(t);
  await page.evaluate(() => { window.holdDisconnect = true; });
  await page.locator(".provider-row").filter({ hasText: "A-private-provider-other" }).getByRole("button", { name: "使用", exact: true }).click();
  await providerStarted.promise;
  await page.locator(".user-logout").click();
  await logoutStarted.promise;
  await page.getByRole("status").filter({ hasText: "正在退出并停止任务" }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("axiom.user.token")), null);
  assert.equal(await page.locator(".app-shell").count(), 0);
  assert.equal(await page.getByText(/A-private-/).count(), 0);
  assert.equal(await page.getByRole("button", { name: "登录任务工作台" }).count(), 0);
  releaseLogout.resolve();
  await page.waitForResponse("**/api/user/logout");
  assert.equal(await page.getByRole("button", { name: "登录任务工作台" }).count(), 0, "browser cleanup still pending");
  await page.evaluate(() => { window.releaseDisconnect(); });
  await page.getByPlaceholder("输入桌面账号").fill("user-b");
  await page.getByPlaceholder("输入登录密码").fill("password-B");
  await page.getByRole("button", { name: "登录任务工作台" }).click();
  await page.locator(".workspace-switcher").filter({ hasText: "用户 B" }).waitFor();
  await page.getByText("还没有任务", { exact: true }).waitFor();
  const response = page.waitForResponse("**/task-a/provider");
  releaseProvider.resolve();
  await response;
  await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'));
  assert.equal(await page.getByText(/A-private-/).count(), 0);
  assert.equal(await page.locator(".toast").count(), 0);
  await page.getByRole("button", { name: "任务管理", exact: true }).click();
  assert.equal(await page.getByText(/A-private-/).count(), 0);
  await page.getByRole("button", { name: "连接器", exact: true }).first().click();
  assert.equal(await page.locator(".provider-row").count(), 0);
  assert.equal(await page.getByRole("button", { name: "添加 Provider" }).isEnabled(), true, "old busy lock was cleared");
});

test("failed server logout clears local state and displays that task shutdown is unconfirmed", async (t) => {
  const { page, logoutStarted, releaseLogout } = await openPage(t, { failLogout: true });
  await page.locator(".user-logout").click();
  await logoutStarted.promise;
  releaseLogout.resolve();
  await page.getByText("服务端任务停止未确认：USER_LOGOUT_FAILED", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("axiom.user.token")), null);
  assert.equal(await page.locator(".app-shell").count(), 0);
  assert.equal(await page.getByPlaceholder("输入桌面账号").inputValue(), "");
  assert.equal(await page.getByPlaceholder("输入登录密码").inputValue(), "");
});
