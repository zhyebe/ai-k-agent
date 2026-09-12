import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let browser;
let baseUrl;
let workspace;
const user = { id: "loading-user", username: "loading-user", displayName: "加载测试用户" };
const summary = { scope: "accounts_audit", users: 1, activeUsers: 1, disabledUsers: 0, auditEvents: 0, accounts: [{ ...user, status: "ACTIVE" }], events: [], persistence: { mode: "memory", available: true } };
const emptyWorkspace = { tasks: [], skills: [], providers: [], events: [], runs: [], connectors: [], orders: [], agentRuns: [], credentials: [] };

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  workspace = (await server.ssrLoadModule("/src/data/demo.ts")).demoWorkspace;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function openPage(t, { admin = false, width = 1440 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => {
    localStorage.setItem("axiom.user.token", "loading-test");
    sessionStorage.setItem("axiom.admin.token", "loading-test");
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = {
      "/api/user/session": { authenticated: true, user },
      "/api/admin/session": { authenticated: true, username: "admin" },
      "/api/workspace": workspace,
      "/api/admin/summary": summary,
    }[path];
    return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, json: { error: "UNEXPECTED_TEST_REQUEST" } });
  });
  return { page, navigate: () => page.goto(`${baseUrl}/${admin ? "admin.html" : ""}`) };
}

async function capture(page, name) {
  if (!process.env.AXIOM_LOADING_SCREENSHOTS) return;
  await mkdir(process.env.AXIOM_LOADING_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.AXIOM_LOADING_SCREENSHOTS, `${name}.png`), fullPage: true });
}

for (const width of [1440, 390]) {
  test(`workspace skeleton replaces empty states at ${width}px`, async (t) => {
    const { page, navigate } = await openPage(t, { width });
    const gate = deferred();
    await page.route("**/api/workspace", async (route) => { await gate.promise; await route.fulfill({ json: workspace }); });
    await navigate();
    await page.getByText("正在加载工作区", { exact: true }).waitFor();
    assert.equal(await page.locator(".empty-task, .empty-state, .metric-card").count(), 0);
    assert.equal(await page.getByRole("progressbar", { name: "请求处理中" }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(".skeleton-block").first().evaluate((node) => getComputedStyle(node).animationName), "skeleton-pulse");
    await capture(page, `workspace-${width}`);
    if (width === 1440) {
      for (const name of ["任务管理", "经验与 Skills", "连接器", "运行记录"]) {
        await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true }).click();
        assert.equal(await page.locator(".data-skeleton").count(), 1);
        assert.equal(await page.locator(".empty-state").count(), 0);
      }
      await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "任务控制台", exact: true }).click();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".loading-spinner").first().evaluate((node) => getComputedStyle(node).animationName), "none");
    gate.resolve();
    await page.getByRole("heading", { name: "任务工作台", exact: true }).waitFor();
    assert.equal(await page.locator(".data-skeleton, .request-progress").count(), 0);
  });
}

test("workspace failure stays distinct from empty success and supports retry", async (t) => {
  const { page, navigate } = await openPage(t);
  await page.route("**/api/workspace", (route) => route.fulfill({ status: 503, json: { error: "TEST_UNAVAILABLE" } }));
  await navigate();
  await page.getByText("工作区加载失败", { exact: true }).waitFor();
  assert.equal(await page.locator(".empty-state, .data-skeleton, .request-progress").count(), 0);
  const gate = deferred();
  await page.route("**/api/workspace", async (route) => { await gate.promise; await route.fulfill({ json: emptyWorkspace }); });
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByRole("button", { name: "重试中" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重试中" }).isDisabled(), true);
  gate.resolve();
  await page.getByRole("button", { name: "新建任务", exact: true }).waitFor();
  assert.equal(await page.locator(".data-load-error, .request-progress").count(), 0);
});

test("background refresh preserves data, stays quiet and never overlaps", async (t) => {
  const { page, navigate } = await openPage(t);
  await page.clock.install();
  const gate = deferred();
  let requests = 0;
  await page.route("**/api/workspace", async (route) => {
    requests++;
    if (requests > 1) await gate.promise;
    await route.fulfill({ json: workspace });
  });
  await navigate();
  await page.getByRole("heading", { name: "任务工作台", exact: true }).waitFor();
  await page.clock.fastForward(5001);
  await page.waitForFunction(async () => (await import("/src/lib/api.ts")).getPendingRequests() === 0);
  assert.equal(requests, 2);
  await page.clock.fastForward(15000);
  assert.equal(requests, 2);
  assert.equal(await page.locator(".data-skeleton, .request-progress").count(), 0);
  assert.equal(await page.getByRole("heading", { name: "任务工作台", exact: true }).isVisible(), true);
  gate.resolve();
});

test("admin initial load, refresh and failure keep accurate data states", async (t) => {
  const { page, navigate } = await openPage(t, { admin: true });
  const gate = deferred();
  await page.route("**/api/admin/summary", async (route) => { await gate.promise; await route.fulfill({ json: summary }); });
  await navigate();
  await page.getByText("正在加载管理数据", { exact: true }).waitFor();
  assert.equal(await page.locator(".admin-metric, .empty-state").count(), 0);
  await capture(page, "admin-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, "admin-390");
  gate.resolve();
  await page.getByRole("heading", { name: "账号授权概览" }).waitFor();
  const refresh = deferred();
  await page.route("**/api/admin/summary", async (route) => { await refresh.promise; await route.fulfill({ status: 503, json: { error: "TEST_REFRESH_FAILED" } }); });
  await page.getByRole("button", { name: "刷新状态" }).click();
  await page.getByRole("button", { name: "刷新中" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "刷新中" }).isDisabled(), true);
  assert.equal(await page.locator(".data-skeleton").count(), 0);
  assert.equal(await page.locator(".admin-metric").count(), 4);
  refresh.resolve();
  await page.getByText("同步失败，当前显示上次数据", { exact: true }).waitFor();
  assert.equal(await page.locator(".admin-metric").count(), 4);
  assert.equal(await page.locator(".request-progress").count(), 0);
});

test("admin failure offers retry without false zero counts", async (t) => {
  const { page, navigate } = await openPage(t, { admin: true });
  await page.route("**/api/admin/summary", (route) => route.fulfill({ status: 503, json: { error: "TEST_UNAVAILABLE" } }));
  await navigate();
  await page.getByText("管理数据加载失败", { exact: true }).waitFor();
  assert.equal(await page.locator(".admin-metric, .empty-state").count(), 0);
  await page.route("**/api/admin/summary", (route) => route.fulfill({ json: summary }));
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByRole("heading", { name: "账号授权概览" }).waitFor();
  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByPlaceholder("至少 8 位", { exact: true }).fill("test-password");
  const gate = deferred();
  let creates = 0;
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() === "POST") { creates++; await gate.promise; }
    await route.fulfill({ json: { users: summary.accounts, user: summary.accounts[0] } });
  });
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  const button = page.getByRole("button", { name: "创建中", exact: true });
  await button.waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.equal(await button.locator(".loading-spinner").count(), 1);
  assert.equal(creates, 1);
  gate.resolve();
  await page.getByRole("button", { name: "创建用户", exact: true }).waitFor();
});

test("Agent output shows loading, scoped failure and successful empty state", async (t) => {
  const { page, navigate } = await openPage(t);
  let gate = deferred();
  await page.route("**/agent-stream?*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/agent-output", async (route) => { await gate.promise; await route.fulfill({ status: 503, json: { error: "TEST_OUTPUT_FAILED" } }); });
  await navigate();
  await page.getByRole("button", { name: "查看 Agent 输出流" }).click();
  await page.getByText("正在加载 Agent 输出", { exact: true }).waitFor();
  assert.equal(await page.getByText("等待开始", { exact: true }).count(), 0);
  await capture(page, "agent-output");
  gate.resolve();
  await page.getByText("Agent 输出加载失败", { exact: true }).waitFor();
  assert.equal(await page.locator(".content-scroll .data-load-error").count(), 0);
  await page.route("**/agent-output", (route) => route.fulfill({ json: { runs: [], output: [] } }));
  await page.getByRole("button", { name: "重新加载" }).click();
  await page.getByText("还没有输出。点击「立即分析」开始。", { exact: true }).waitFor();
  assert.equal(await page.locator(".request-progress").count(), 0);
});

test("request progress tracks concurrent requests through decoding, failures, aborts and deduplication", async (t) => {
  const { page, navigate } = await openPage(t);
  await navigate();
  await page.getByRole("heading", { name: "任务工作台", exact: true }).waitFor();
  const results = await page.evaluate(async () => {
    const api = await import("/src/lib/api.ts");
    const originalFetch = window.fetch;
    const resolvers = [];
    window.fetch = () => new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
    const counts = [];
    const unsubscribe = api.subscribeRequests(() => counts.push(api.getPendingRequests()));
    try {
      const first = api.fetchApiHealth();
      const second = api.fetchApiHealth().catch((error) => error.message);
      let finishJson;
      resolvers[0].resolve({ ok: true, json: () => new Promise((resolve) => { finishJson = resolve; }) });
      await Promise.resolve();
      const whileDecoding = api.getPendingRequests();
      finishJson({ ok: true });
      await first;
      resolvers[1].reject(new DOMException("Aborted", "AbortError"));
      await second;
      const one = api.createTask({ name: "dedupe" }).catch((error) => error.message);
      const two = api.createTask({ name: "dedupe" }).catch((error) => error.message);
      const dedupeCount = resolvers.length;
      resolvers[2].resolve({ ok: false, status: 503, json: async () => ({ error: "TEST_FAILURE" }) });
      const failures = await Promise.all([one, two]);
      const silent = api.fetchWorkspace({ background: true });
      const backgroundCount = api.getPendingRequests();
      resolvers[3].resolve({ ok: true, json: async () => ({ tasks: [] }) });
      await silent;
      return { counts, whileDecoding, dedupeCount, failures, backgroundCount, finalCount: api.getPendingRequests() };
    } finally { unsubscribe(); window.fetch = originalFetch; }
  });
  assert.deepEqual(results, { counts: [1, 2, 1, 0, 1, 0], whileDecoding: 2, dedupeCount: 3, failures: ["TEST_FAILURE", "TEST_FAILURE"], backgroundCount: 0, finalCount: 0 });
});

test("live Agent snapshot completes loading and survives a late HTTP response", async (t) => {
  const { page, navigate } = await openPage(t);
  const gate = deferred();
  const line = { id: "live-line", level: "info", stage: "analyze", message: "实时输出已到达", createdAt: new Date().toISOString() };
  await page.route("**/agent-stream?*", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({ runs: [], output: [line] })}\n\n` }));
  await page.route("**/agent-output", async (route) => { await gate.promise; await route.fulfill({ json: { runs: [], output: [] } }); });
  await navigate();
  await page.getByRole("button", { name: "查看 Agent 输出流" }).click();
  await page.getByText(line.message, { exact: true }).waitFor();
  assert.equal(await page.locator(".agent-drawer .data-skeleton").count(), 0);
  gate.resolve();
  await page.locator(".request-progress").waitFor({ state: "detached" });
  assert.equal(await page.getByText(line.message, { exact: true }).count(), 1);
  await page.getByRole("button", { name: "关闭输出流" }).click();
  await page.route("**/agent-stream?*", (route) => route.fulfill({ status: 204 }));
  const reopened = deferred();
  await page.route("**/agent-output", async (route) => { await reopened.promise; await route.fulfill({ json: { runs: [], output: [] } }); });
  await page.getByRole("button", { name: "查看 Agent 输出流" }).click();
  await page.getByText("正在加载 Agent 输出", { exact: true }).waitFor();
  assert.equal(await page.getByText(line.message, { exact: true }).count(), 0);
  await page.getByRole("button", { name: "关闭输出流" }).click();
  await page.locator(".request-progress").waitFor({ state: "detached" });
  reopened.resolve();
});
