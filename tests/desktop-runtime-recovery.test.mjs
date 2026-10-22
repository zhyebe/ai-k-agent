import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function loadRuntime(file, replacements = {}, extra = "") {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL(`../electron/${file}`, import.meta.url), "utf8") + extra, {
    module, exports: module.exports, require: (name) => replacements[name] || require(name),
    __dirname: new URL("../electron", import.meta.url).pathname,
    process, console, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  return module.exports;
}

test("browser writes restore a hidden minimized surface before acting; passive control scans keep its state", async () => {
  const events = [];
  const window = {
    minimized: true, visible: false,
    isMinimized() { return this.minimized; },
    isVisible() { return this.visible; },
    restore() { events.push("restore"); this.minimized = false; },
    showInactive() { events.push("show"); this.visible = true; },
  };
  const runtime = loadRuntime("browser-runtime.cjs", {}, `
    module.exports.useModules = value => { modulesPromise = Promise.resolve(value); };
    module.exports.useHost = (message, host) => activeSessions.set(scopedSession(message, "https://example.test"), host);
  `);
  const message = { userId: "owner", method: "readTradeControls", input: { sessionId: "task:one", confirmationId: "restore-once" }, deadlineAt: Date.now() + 10000 };
  runtime.useHost(message, { evaluate: async fn => fn({ BrowserWindow: { getAllWindows: () => [window] } }) });
  runtime.useModules({
    tools: {
      readTradeControls: async () => ({ ok: true }),
      submitSuggestionForm: async () => { events.push("submit"); assert.equal(window.minimized, false); assert.equal(window.visible, true); return { ok: true, submitted: true }; },
    },
  });
  await runtime.executeBrowserCall({}, message, "https://example.test", new AbortController().signal);
  assert.deepEqual(events, []);
  const result = await runtime.executeBrowserCall({}, { ...message, method: "submitSuggestionForm" }, "https://example.test", new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["restore", "show", "submit"]);
});

test("account collection restores the surface for each DOM phase, including after its network wait", async () => {
  const window = {
    minimized: true, visible: false,
    isMinimized() { return this.minimized; }, isVisible() { return this.visible; },
    restore() { this.minimized = false; }, showInactive() { this.visible = true; },
  };
  const runtime = loadRuntime("browser-runtime.cjs", {}, `
    module.exports.useModules = value => { modulesPromise = Promise.resolve(value); };
    module.exports.useHost = (message, host) => activeSessions.set(scopedSession(message, "https://example.test"), host);
  `);
  let phases = 0;
  const checkSurface = () => { phases++; assert.equal(window.minimized, false); assert.equal(window.visible, true); return { ok: true }; };
  runtime.useModules({
    browser: {}, analysis: { compactCollectedMarket: value => value },
    market: {
      observeMarket: async (_task, _connector, { withBrowser }) => {
        await withBrowser(checkSurface);
        window.minimized = true; window.visible = false;
        return withBrowser(checkSurface);
      },
      observeExecutionMarket: async () => checkSurface(),
    },
  });
  const message = { userId: "owner", input: { task: { id: "one", target: {} } }, deadlineAt: Date.now() + 10000 };
  runtime.useHost(message, { evaluate: async fn => fn({ BrowserWindow: { getAllWindows: () => [window] } }) });
  await runtime.executeBrowserCall({}, { ...message, method: "observeMarket" }, "https://example.test", new AbortController().signal);
  window.minimized = true; window.visible = false;
  await runtime.executeBrowserCall({}, { ...message, method: "observeExecutionMarket" }, "https://example.test", new AbortController().signal);
  assert.equal(phases, 3);
});

test("connecting the same desktop session twice keeps its socket and active browser call", async (t) => {
  const sockets = [];
  const handlers = new Map();
  const started = deferred();
  const done = deferred();
  let callSignal;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() { super(); this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit("close", 1000); }
    terminate() { this.close(); }
    ping() {}
  }
  const runtime = loadRuntime("ai-runtime.cjs", {
    ws: Socket,
    "./browser-runtime.cjs": {
      executeBrowserCall: async (_app, _message, _base, signal) => { callSignal = signal; started.resolve(); return done.promise; },
      closeBrowserRuntime: async () => {},
    },
  });
  runtime.bindIpc({ handle: (name, fn) => handlers.set(name, fn) }, { isPackaged: false });
  t.after(() => { done.resolve({ ok: true }); return runtime.disconnect(); });
  const session = { apiBaseUrl: "https://example.test", userToken: "synthetic-session" };
  handlers.get("ai:connect")(null, session);
  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ type: "browser.call", id: "read-1", method: "observeMarket", userId: "owner", deadlineAt: Date.now() + 10000 }));
  await started.promise;
  handlers.get("ai:connect")(null, session);
  assert.equal(sockets.length, 1);
  assert.equal(callSignal.aborted, false);
  done.resolve({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[0].sent.at(-1).type, "browser.result");
  sockets[0].close();
  handlers.get("ai:connect")(null, session);
  assert.equal(sockets.length, 2, "a closed socket still reconnects");
});

for (const reason of ["DESKTOP_DISCONNECTED", "DESKTOP_RECONNECTED", "DESKTOP_CALL_CANCELLED"]) {
  test(`read cancellation ${reason} respects the browser session lifecycle`, async () => {
    const started = deferred();
    const finish = deferred();
    let closes = 0;
    let reads = 0;
    const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
    runtime.useModules({
      browser: { closeBrowserSession: async () => { closes++; return true; } },
      tools: { readTradeControls: async () => { reads++; started.resolve(); return finish.promise; } },
    });
    const controller = new AbortController();
    const message = { userId: "owner", method: "readTradeControls", input: { sessionId: "task:one" }, deadlineAt: Date.now() + 10000 };
    const read = runtime.executeBrowserCall({}, message, "https://example.test", controller.signal);
    await started.promise;
    controller.abort(new Error(reason));
    finish.resolve({ ok: true });
    await read;
    assert.equal(closes > 0, reason === "DESKTOP_CALL_CANCELLED");
    const next = await runtime.executeBrowserCall({}, message, "https://example.test", new AbortController().signal);
    assert.equal(next.ok, true);
    assert.equal(reads, 2);
  });
}

test("a trading call still cancels on disconnect and is never replayed", async () => {
  const started = deferred();
  const finish = deferred();
  let closes = 0;
  let submitted = 0;
  const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
  runtime.useModules({
    browser: { closeBrowserSession: async () => { closes++; } },
    tools: { submitSuggestionForm: async () => { submitted++; started.resolve(); return finish.promise; } },
  });
  const controller = new AbortController();
  const write = runtime.executeBrowserCall({}, { userId: "owner", method: "submitSuggestionForm", input: { sessionId: "task:one", confirmationId: "one" }, deadlineAt: Date.now() + 10000 }, "https://example.test", controller.signal);
  await started.promise;
  controller.abort(new Error("DESKTOP_DISCONNECTED"));
  finish.resolve({ ok: true, submitted: true });
  await write;
  assert.ok(closes > 0);
  assert.equal(submitted, 1);
});

for (const reason of ["DESKTOP_DISCONNECTED", "DESKTOP_RECONNECTED"]) {
  test(`opening an existing market page survives ${reason} without destroying its login session`, async () => {
    const started = deferred();
    const finish = deferred();
    let closes = 0;
    const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
    runtime.useModules({
      browser: { closeBrowserSession: async () => { closes++; } },
      market: { openMarketBrowser: async () => { started.resolve(); return finish.promise; } },
    });
    const controller = new AbortController();
    const message = { userId: "owner", method: "openMarketBrowser", input: { task: { id: "one", target: { browserSessionId: "task:one" } } }, deadlineAt: Date.now() + 10000 };
    const opened = runtime.executeBrowserCall({}, message, "https://example.test", controller.signal);
    const rejected = assert.rejects(opened, new RegExp(reason));
    await started.promise;
    controller.abort(new Error(reason));
    finish.resolve({ ok: true, url: "https://example.test/market" });
    await rejected;
    assert.equal(closes, 0, "a transport disconnect must preserve the existing market page and sessionStorage");
  });
}

test("desktop logout IPC waits for browser cleanup and reports a cleanup failure", async () => {
  const handlers = new Map();
  const started = deferred();
  const finish = deferred();
  let fail = false;
  const runtime = loadRuntime("ai-runtime.cjs", {
    "./browser-runtime.cjs": {
      closeBrowserRuntime: async () => {
        started.resolve();
        await finish.promise;
        if (fail) throw new Error("BROWSER_SESSION_CLOSE_FAILED");
      },
    },
  });
  runtime.bindIpc({ handle: (name, fn) => handlers.set(name, fn) }, {});
  let completed = false;
  const logout = handlers.get("ai:disconnect")().then(() => { completed = true; });
  await started.promise;
  assert.equal(completed, false);
  finish.resolve();
  await logout;
  assert.equal(completed, true);
  fail = true;
  await assert.rejects(handlers.get("ai:disconnect")(), /BROWSER_SESSION_CLOSE_FAILED/);
});

test("desktop logout clears shared runtime caches and trade confirmation records", async () => {
  let closed = false;
  const runtime = loadRuntime("browser-runtime.cjs", {}, `
    module.exports.seed = () => {
      modulesPromise = Promise.resolve({ browser: { closeAllBrowserSessions: async () => { module.exports.closed = true; } } });
      queues.set("old", Promise.resolve());
      collectedMarkets.set("old", {});
      confirmations.add("old");
    };
    module.exports.sizes = () => [queues.size, collectedMarkets.size, confirmations.size];
  `);
  runtime.seed();
  await runtime.closeBrowserRuntime();
  closed = runtime.closed;
  assert.equal(closed, true);
  assert.deepEqual(Array.from(runtime.sizes()), [0, 0, 0]);
});

test("slow history releases the browser queue while DOM phases remain serial and final collection refreshes", async () => {
  const historyStarted = deferred(), finishHistory = deferred(), quickStarted = deferred(), finishQuick = deferred();
  const events = [];
  const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
  runtime.useModules({
    browser: { closeBrowserSession: async () => {} },
    analysis: { compactCollectedMarket: value => value },
    market: {
      observeMarket: async (_task, _connector, { withBrowser }) => {
        await withBrowser(async () => { events.push("initial-dom"); });
        historyStarted.resolve();
        await finishHistory.promise;
        return withBrowser(async () => { events.push("refreshed-dom"); return { ok: true, fingerprint: "fresh" }; });
      },
      observeExecutionMarket: async () => { events.push("quick-dom-start"); quickStarted.resolve(); await finishQuick.promise; events.push("quick-dom-finish"); return { ok: true }; },
    },
  });
  const message = { userId: "owner", input: { task: { id: "one", target: { browserSessionId: "task:one" } } }, deadlineAt: Date.now() + 10000 };
  const full = runtime.executeBrowserCall({}, { ...message, method: "observeMarket" }, "https://example.test", new AbortController().signal);
  await historyStarted.promise;
  const quick = runtime.executeBrowserCall({}, { ...message, method: "observeExecutionMarket" }, "https://example.test", new AbortController().signal);
  await quickStarted.promise;
  finishHistory.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["initial-dom", "quick-dom-start"]);
  finishQuick.resolve();
  await Promise.all([full, quick]);
  assert.deepEqual(events, ["initial-dom", "quick-dom-start", "quick-dom-finish", "refreshed-dom"]);
});

for (const accountScope of ["positions", "full"]) {
  test(`desktop execution observation passes ${accountScope} account scope from message options to market`, async () => {
    const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
    let captured;
    runtime.useModules({
      browser: { closeBrowserSession: async () => {} },
      market: { observeExecutionMarket: async (_task, _connector, options) => { captured = options; return { ok: true }; } },
    });
    const result = await runtime.executeBrowserCall({}, {
      userId: "owner", method: "observeExecutionMarket", options: { accountScope },
      input: { task: { id: "one", target: { browserSessionId: "task:one" } } }, deadlineAt: Date.now() + 10000,
    }, "https://example.test", new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(captured.accountScope, accountScope);
    assert.equal(typeof captured.withBrowser, "function");
  });
}

test("logout during history waits prevents every later DOM read and cache write", async () => {
  const started = deferred(), finish = deferred();
  let refreshed = false;
  const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = (value) => { modulesPromise = Promise.resolve(value); };\n");
  runtime.useModules({
    browser: { closeBrowserSession: async () => {}, closeAllBrowserSessions: async () => {} },
    analysis: { compactCollectedMarket: () => { throw new Error("must not cache"); } },
    market: { observeMarket: async (_task, _connector, { withBrowser }) => { await withBrowser(async () => {}); started.resolve(); await finish.promise; return withBrowser(async () => { refreshed = true; return { ok: true }; }); } },
  });
  const controller = new AbortController();
  const operation = runtime.executeBrowserCall({}, { userId: "owner", method: "observeMarket", input: { task: { id: "one", target: {} } }, deadlineAt: Date.now() + 10000 }, "https://example.test", controller.signal);
  await started.promise;
  controller.abort(new Error("DESKTOP_CALL_CANCELLED"));
  await runtime.closeBrowserRuntime();
  finish.resolve();
  await assert.rejects(operation, /DESKTOP_CALL_CANCELLED/);
  assert.equal(refreshed, false);
});

test("timing out collection outside the DOM queue cannot close a concurrent trade", async () => {
  const historyStarted = deferred(), finishHistory = deferred(), tradeStarted = deferred(), finishTrade = deferred();
  let closes = 0, submissions = 0;
  const runtime = loadRuntime("browser-runtime.cjs", {}, "\nmodule.exports.useModules = value => { modulesPromise = Promise.resolve(value); };\n");
  runtime.useModules({
    browser: { closeBrowserSession: async () => { closes++; } },
    analysis: { compactCollectedMarket: value => value },
    market: { observeMarket: async (_task, _connector, { withBrowser }) => {
      await withBrowser(async () => {});
      historyStarted.resolve();
      await finishHistory.promise;
      return withBrowser(async () => { throw new Error("expired collection must not touch DOM"); });
    } },
    tools: { submitSuggestionForm: async () => { submissions++; tradeStarted.resolve(); await finishTrade.promise; return { ok: true, submitted: true }; } },
  });
  const message = { userId: "owner", input: { sessionId: "task:one", task: { id: "one", target: { browserSessionId: "task:one" } }, confirmationId: "once" }, deadlineAt: Date.now() + 10000 };
  const controller = new AbortController();
  const collection = runtime.executeBrowserCall({}, { ...message, method: "observeMarket" }, "https://example.test", controller.signal);
  const rejected = assert.rejects(collection, /DESKTOP_CALL_EXPIRED/);
  await historyStarted.promise;
  const trade = runtime.executeBrowserCall({}, { ...message, method: "submitSuggestionForm" }, "https://example.test", new AbortController().signal);
  await tradeStarted.promise;
  controller.abort(new Error("DESKTOP_CALL_EXPIRED"));
  finishHistory.resolve();
  finishTrade.resolve();
  await rejected;
  assert.equal((await trade).ok, true);
  assert.equal(closes, 0, "a read-only network wait does not own the browser being used by the trade");
  assert.equal(submissions, 1);
});

test("window preparation cancellation closes once and releases the queue only after cleanup", async () => {
  const preparing = deferred(), finishPreparation = deferred(), finishClose = deferred();
  let closes = 0, submissions = 0, reads = 0;
  const runtime = loadRuntime("browser-runtime.cjs", {}, `
    module.exports.useModules = value => { modulesPromise = Promise.resolve(value); };
    module.exports.useHost = (message, host) => activeSessions.set(scopedSession(message, "https://example.test"), host);
  `);
  runtime.useModules({
    browser: { closeBrowserSession: async () => { closes++; finishPreparation.resolve(); await finishClose.promise; } },
    tools: { submitSuggestionForm: async () => { submissions++; }, readTradeControls: async () => { reads++; return { ok: true }; } },
  });
  const message = { userId: "owner", input: { sessionId: "task:one", confirmationId: "never-click" }, deadlineAt: Date.now() + 10000 };
  runtime.useHost(message, { evaluate: async () => { preparing.resolve(); await finishPreparation.promise; } });
  const controller = new AbortController();
  const trade = runtime.executeBrowserCall({}, { ...message, method: "submitSuggestionForm" }, "https://example.test", controller.signal);
  const rejected = assert.rejects(trade, /DESKTOP_CALL_EXPIRED/);
  await preparing.promise;
  const next = runtime.executeBrowserCall({}, { ...message, method: "readTradeControls" }, "https://example.test", new AbortController().signal);
  controller.abort(new Error("DESKTOP_CALL_EXPIRED"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(submissions, 0);
  assert.equal(reads, 0);
  finishClose.resolve();
  await rejected;
  assert.equal((await next).ok, true);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
});
