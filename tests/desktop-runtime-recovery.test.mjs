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
