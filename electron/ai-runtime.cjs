const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { executeBrowserCall, closeBrowserRuntime, getCollectedMarket } = require("./browser-runtime.cjs");

let providerModulePromise;
let activeSession = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopped = true;
let heartbeatTimer = null;
let cleanupPromise = Promise.resolve();
const activeCalls = new Map();

function providerModulePath(app) {
  const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "server", "provider.mjs");
  if (app?.isPackaged && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "server", "provider.mjs");
}

function loadProviderModule(app) {
  if (!providerModulePromise) {
    providerModulePromise = import(pathToFileURL(providerModulePath(app)).href);
  }
  return providerModulePromise;
}

function toWsUrl(apiBaseUrl) {
  const parsed = new URL(String(apiBaseUrl || "").trim());
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/api/desktop-ai";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function createSocket(url, headers) {
  const WS = require("ws");
  return new WS(url, { headers, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
}

async function executeCall(app, message, signal, apiBaseUrl) {
  if (message.method === "requestMarketAnalysis") {
    const market = getCollectedMarket(message.context?.marketRef, apiBaseUrl, message.userId);
    const modulePath = path.join(path.dirname(providerModulePath(app)), "market-analysis.mjs");
    const { analyzeCollectedMarket } = await import(pathToFileURL(modulePath).href);
    return analyzeCollectedMarket(message.provider, market, message.context, { ...message.options, signal });
  }
  const providerApi = await loadProviderModule(app);
  const provider = message.provider || {};
  signal.throwIfAborted();
  const options = { ...message.options, signal };
  if (message.method === "verifyProvider") return providerApi.verifyProvider(provider, options);
  if (message.method === "listProviderModels") return providerApi.listProviderModels(provider, options);
  if (message.method === "requestSegmentReview") {
    return providerApi.requestSegmentReview(provider, message.segment, message.context || {}, options);
  }
  if (message.method === "requestDecision") {
    return providerApi.requestDecision(provider, message.context || {}, options);
  }
  if (message.method === "requestBrowserActions") {
    return providerApi.requestBrowserActions(provider, message.context || {}, options);
  }
  throw new Error("AI_METHOD_UNKNOWN");
}

function reply(target, channel, id, ok, result, error) {
  if (socket !== target || target.readyState !== 1) return;
  target.send(JSON.stringify({
    type: `${channel}.result`,
    id,
    ok,
    result: ok ? result : undefined,
    error: ok ? undefined : String(error || "DESKTOP_AI_FAILED"),
  }));
}

function scheduleReconnect(app) {
  if (stopped || !activeSession) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 400 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => connect(app, activeSession), delay);
}

function safeCloseSocket(ws) {
  if (!ws) return;
  try { ws.on("error", () => {}); } catch {}
  for (const event of ["open", "message", "close"]) {
    try { ws.removeAllListeners(event); } catch {}
  }
  try {
    if (ws.readyState === 1) ws.close();
    else if (typeof ws.terminate === "function") ws.terminate();
    else ws.close();
  } catch {}
}

function disconnect() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  activeSession = null;
  clearInterval(heartbeatTimer);
  for (const call of activeCalls.values()) call.controller.abort(new Error("DESKTOP_DISCONNECTED"));
  cleanupPromise = cleanupPromise.then(() => closeBrowserRuntime()).catch((error) => console.error("Desktop browser cleanup failed", error.message));
  safeCloseSocket(current);
  return cleanupPromise;
}

function connect(app, session) {
  const apiBaseUrl = String(session?.apiBaseUrl || "").trim();
  const userToken = String(session?.userToken || "").trim();
  if (!apiBaseUrl || !userToken) return { ok: false, error: "AI_SESSION_REQUIRED" };
  stopped = false;
  activeSession = { apiBaseUrl, userToken };
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  if (socket) {
    for (const call of activeCalls.values()) call.controller.abort(new Error("DESKTOP_RECONNECTED"));
    safeCloseSocket(socket);
    socket = null;
  }
  let next;
  try {
    next = createSocket(toWsUrl(apiBaseUrl), { "x-user-token": userToken });
  } catch (error) {
    scheduleReconnect(app);
    return { ok: false, error: error?.message || "DESKTOP_AI_CONNECT_FAILED" };
  }
  socket = next;
  next.on("error", () => { next.terminate(); });
  let lastPongAt = Date.now();
  next.on("pong", () => { lastPongAt = Date.now(); });
  next.on("open", () => {
    reconnectAttempt = 0;
    next.send(JSON.stringify({ type: "runtime.hello", capabilities: ["browser-v1"] }));
    heartbeatTimer = setInterval(() => {
      if (socket !== next) return;
      if (Date.now() - lastPongAt > 45000) { next.terminate(); return; }
      try { next.ping(); } catch { next.terminate(); }
    }, 15000);
    heartbeatTimer.unref?.();
  });
  next.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message?.id || socket !== next) return;
    if (message.type === "ai.cancel" || message.type === "browser.cancel") {
      activeCalls.get(message.id)?.controller.abort(new Error("DESKTOP_CALL_CANCELLED"));
      return;
    }
    if (!["ai.call", "browser.call"].includes(message.type)) return;
    const channel = message.type === "browser.call" ? "browser" : "ai";
    if (activeCalls.has(message.id)) return;
    if (activeCalls.size >= 8) { reply(next, channel, message.id, false, undefined, "DESKTOP_BUSY"); return; }
    const controller = new AbortController();
    const deadlineAt = Math.min(Number(message.deadlineAt) || Date.now() + 120000, Date.now() + 128000);
    const timer = setTimeout(() => controller.abort(new Error("DESKTOP_CALL_EXPIRED")), Math.max(0, deadlineAt - Date.now()));
    activeCalls.set(message.id, { controller, socket: next });
    try {
      await cleanupPromise;
      controller.signal.throwIfAborted();
      const result = channel === "browser"
        ? await executeBrowserCall(app, { ...message, deadlineAt }, apiBaseUrl, controller.signal)
        : await executeCall(app, message, controller.signal, apiBaseUrl);
      controller.signal.throwIfAborted();
      reply(next, channel, message.id, true, result);
    } catch (error) {
      reply(next, channel, message.id, false, undefined, error?.message || "DESKTOP_CALL_FAILED");
    } finally {
      clearTimeout(timer);
      activeCalls.delete(message.id);
    }
  });
  next.on("close", () => {
    for (const call of activeCalls.values()) if (call.socket === next) call.controller.abort(new Error("DESKTOP_DISCONNECTED"));
    if (socket !== next) return;
    socket = null;
    clearInterval(heartbeatTimer);
    if (!stopped) scheduleReconnect(app);
  });
  return { ok: true };
}

function bindIpc(ipcMain, app) {
  ipcMain.handle("ai:connect", (_event, session) => connect(app, session || {}));
  ipcMain.handle("ai:disconnect", () => {
    disconnect();
    return { ok: true };
  });
}

module.exports = { bindIpc, disconnect, safeCloseSocket };
