import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { attachDesktopAiSocket, hasDesktopAi, invokeDesktopAi, resetDesktopAiForTests } from "../server/desktop-ai.mjs";
import { callBrowserMethod } from "../server/desktop-browser.mjs";
import { executableExitQuote } from "../server/exit-policy.mjs";
import { openBrowserPage } from "../server/browser.mjs";
import packageConfig from "../package.json" with { type: "json" };

test("packaged desktop unpacks ws beside ESM server modules", () => {
  assert.ok(packageConfig.build.asarUnpack.includes("node_modules/ws/**"));
});

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  ping() {}
  terminate() { this.readyState = 3; this.emit("close"); }
}

test("production browser calls require a capable desktop and never launch server Chromium", async (t) => {
  const previous = { AXIOM_REQUIRE_DESKTOP_BROWSER: process.env.AXIOM_REQUIRE_DESKTOP_BROWSER, AXIOM_DESKTOP_AI_WAIT_MS: process.env.AXIOM_DESKTOP_AI_WAIT_MS };
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
  process.env.AXIOM_DESKTOP_AI_WAIT_MS = "0";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.after(resetDesktopAiForTests);
  await assert.rejects(callBrowserMethod("openMarketBrowser", "owner", { task: { id: "t", target: { url: "http://localhost" } } }), /DESKTOP_BROWSER_OFFLINE/);
  const direct = await openBrowserPage({ url: "http://localhost", sessionId: "forbidden" });
  assert.equal(direct.ok, false);
  assert.match(direct.message, /SERVER_BROWSER_DISABLED/);
  const oldDesktop = new Socket();
  attachDesktopAiSocket("owner", oldDesktop);
  await assert.rejects(callBrowserMethod("observeMarket", "owner", {}), /DESKTOP_BROWSER_UPDATE_REQUIRED/);
  assert.equal(oldDesktop.sent.length, 0);
});

test("execution quote monitoring routes to an exit-capable desktop and rejects an older runtime", async (t) => {
  const previous = { AXIOM_REQUIRE_DESKTOP_BROWSER: process.env.AXIOM_REQUIRE_DESKTOP_BROWSER, AXIOM_DESKTOP_AI_WAIT_MS: process.env.AXIOM_DESKTOP_AI_WAIT_MS };
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
  process.env.AXIOM_DESKTOP_AI_WAIT_MS = "0";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.after(resetDesktopAiForTests);
  const capable = new Socket();
  attachDesktopAiSocket("owner", capable);
  capable.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1", "browser-exit-v1", "browser-summary-exit-v1", "browser-ai-summary-exit-v1"] }));
  const older = new Socket();
  attachDesktopAiSocket("owner", older);
  older.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
  const task = { id: "t", symbol: "DGKZ", exitObservationIndex: [{ positionOrderId: "P-1" }] };
  const operation = callBrowserMethod("observeExecutionMarket", "owner", { task }, { accountScope: "full" });
  await Promise.resolve();
  const message = capable.sent[0];
  assert.equal(message.type, "browser.call");
  assert.equal(message.method, "observeExecutionMarket");
  assert.deepEqual(message.input.task.exitObservationIndex, task.exitObservationIndex);
  assert.equal(message.options.accountScope, "full");
  assert.equal(older.sent.length, 0);
  const result = { ok: true, observedAt: "2026-10-14T07:00:00Z", positionsVerified: true };
  capable.emit("message", JSON.stringify({ type: "browser.result", id: message.id, ok: true, result }));
  const observed = await operation;
  assert.equal(observed.desktopObservedAt, result.observedAt);
  assert.ok(Date.now() - Date.parse(observed.observedAt) < 1000);
  assert.equal(observed.positionsVerified, true);
  capable.terminate();
  await assert.rejects(callBrowserMethod("observeExecutionMarket", "owner", { task }), /DESKTOP_BROWSER_UPDATE_REQUIRED/);
  assert.equal(older.sent.length, 0);
});

test("market observations use the server clock for decision validity across desktop clock skew", async (t) => {
  t.after(resetDesktopAiForTests);
  const previous = process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
  t.after(() => { if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_BROWSER; else process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = previous; });
  const socket = new Socket();
  attachDesktopAiSocket("market-clock-owner", socket);
  socket.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
  const startedAt = Date.now();
  const operation = callBrowserMethod("observeMarket", "market-clock-owner", { task: { id: "market-clock-task" } });
  await Promise.resolve();
  const message = socket.sent[0];
  assert.ok(Math.abs(Date.parse(message.input.serverObservedAt) - startedAt) < 1000);
  const desktopObservedAt = new Date(startedAt + 10 * 60 * 1000).toISOString();
  const book = { symbol: "DGKZ", observedAt: desktopObservedAt, freshnessSec: 600, latest: { price: 105 } };
  socket.emit("message", JSON.stringify({ type: "browser.result", id: message.id, ok: true, result: { ...book, ok: true, books: [book] } }));
  const observed = await operation;
  assert.ok(Math.abs(Date.parse(observed.observedAt) - startedAt) < 1000);
  assert.equal(observed.desktopObservedAt, desktopObservedAt);
  assert.ok(Math.max(0, Number(observed.freshnessSec)) <= 1);
  assert.equal(observed.books[0].desktopObservedAt, desktopObservedAt);
  assert.ok(Math.max(0, Number(observed.books[0].freshnessSec)) <= 1);
});

for (const clockSkewMs of [-9000, 9000]) {
  test(`execution quotes use call age with desktop clock skew ${clockSkewMs}ms, without renewing slow reads`, async t => {
    t.after(resetDesktopAiForTests);
    const previous = process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
    process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
    t.after(() => { if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_BROWSER; else process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = previous; });
    t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
    const socket = new Socket();
    attachDesktopAiSocket("clock-owner", socket);
    socket.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1", "browser-exit-v1", "browser-summary-exit-v1", "browser-ai-summary-exit-v1"] }));
    for (const elapsed of [120, 6000]) {
      const startedAt = Date.now();
      const call = callBrowserMethod("observeExecutionMarket", "clock-owner", { task: { id: "clock-task" } });
      await Promise.resolve();
      const message = socket.sent.at(-1);
      t.mock.timers.tick(elapsed);
      const desktopObservedAt = new Date(Date.now() + clockSkewMs).toISOString();
      const book = { symbol: "DGKZ", observedAt: desktopObservedAt, orderBook: { bids: [{ price: 105, volume: 10 }], asks: [{ price: 106, volume: 10 }] } };
      socket.emit("message", JSON.stringify({ type: "browser.result", id: message.id, ok: true, result: { ...book, ok: true, books: [book] } }));
      const market = await call;
      assert.equal(Date.parse(market.observedAt), startedAt);
      assert.equal(market.books[0].desktopObservedAt, desktopObservedAt);
      assert.equal(executableExitQuote(market, { symbol: "DGKZ", side: "买入" })?.price ?? null, elapsed < 5000 ? 105 : null);
    }
  });
}

test("browser result is bound to its owning socket and pending calls fail immediately on disconnect", async (t) => {
  t.after(resetDesktopAiForTests);
  const owner = new Socket();
  const other = new Socket();
  attachDesktopAiSocket("owner", owner);
  attachDesktopAiSocket("other", other);
  owner.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
  const operation = invokeDesktopAi("owner", "observeMarket", { channel: "browser" });
  await Promise.resolve();
  const message = owner.sent[0];
  assert.equal(message.type, "browser.call");
  other.emit("message", JSON.stringify({ type: "browser.result", id: message.id, ok: true, result: "foreign" }));
  const rejected = assert.rejects(operation, /DESKTOP_BROWSER_DISCONNECTED/);
  owner.terminate();
  await rejected;
  assert.equal(hasDesktopAi("owner"), false);
});

test("aborting a browser call sends cancellation to the desktop runtime", async (t) => {
  t.after(resetDesktopAiForTests);
  const socket = new Socket();
  attachDesktopAiSocket("owner", socket);
  socket.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
  const controller = new AbortController();
  const operation = invokeDesktopAi("owner", "submitSuggestionForm", { channel: "browser", signal: controller.signal });
  await Promise.resolve();
  const message = socket.sent[0];
  controller.abort(new Error("TRADE_SUBMIT_CANCELLED"));
  await assert.rejects(operation, /TRADE_SUBMIT_CANCELLED/);
  assert.deepEqual(socket.sent[1], { type: "browser.cancel", id: message.id });
});

test("heartbeat evicts an unresponsive desktop socket", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(resetDesktopAiForTests);
  const socket = new Socket();
  attachDesktopAiSocket("owner", socket);
  t.mock.timers.tick(15000);
  assert.equal(hasDesktopAi("owner"), true);
  t.mock.timers.tick(15000);
  assert.equal(hasDesktopAi("owner"), false);
  assert.equal(socket.readyState, 3);
});

test("live desktop traffic counts as heartbeat even when a pong is delayed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(resetDesktopAiForTests);
  const socket = new Socket();
  attachDesktopAiSocket("owner", socket);
  t.mock.timers.tick(15000);
  socket.emit("message", JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
  t.mock.timers.tick(15000);
  assert.equal(hasDesktopAi("owner"), true);
  socket.emit("pong");
  t.mock.timers.tick(15000);
  assert.equal(hasDesktopAi("owner"), true);
});
