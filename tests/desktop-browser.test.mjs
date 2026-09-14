import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { attachDesktopAiSocket, hasDesktopAi, invokeDesktopAi, resetDesktopAiForTests } from "../server/desktop-ai.mjs";
import { callBrowserMethod } from "../server/desktop-browser.mjs";
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
