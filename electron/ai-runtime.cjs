const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let providerModulePromise;
let activeSession = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopped = true;

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
  return new WS(url, { headers });
}

async function executeCall(app, message) {
  const providerApi = await loadProviderModule(app);
  const provider = message.provider || {};
  const options = message.options || {};
  if (message.method === "verifyProvider") return providerApi.verifyProvider(provider, options);
  if (message.method === "requestSegmentReview") {
    return providerApi.requestSegmentReview(provider, message.segment, message.context || {}, options);
  }
  if (message.method === "requestDecision") {
    return providerApi.requestDecision(provider, message.context || {}, options);
  }
  throw new Error("AI_METHOD_UNKNOWN");
}

function reply(id, ok, result, error) {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({
    type: "ai.result",
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

function disconnect() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  activeSession = null;
  if (current) {
    try { current.removeAllListeners?.(); } catch {}
    try { current.close(); } catch {}
  }
}

function connect(app, session) {
  const apiBaseUrl = String(session?.apiBaseUrl || "").trim();
  const userToken = String(session?.userToken || "").trim();
  if (!apiBaseUrl || !userToken) return { ok: false, error: "AI_SESSION_REQUIRED" };
  stopped = false;
  activeSession = { apiBaseUrl, userToken };
  clearTimeout(reconnectTimer);
  if (socket && socket.readyState === 1) {
    try { socket.close(); } catch {}
  }
  let next;
  try {
    next = createSocket(toWsUrl(apiBaseUrl), { "x-user-token": userToken });
  } catch (error) {
    scheduleReconnect(app);
    return { ok: false, error: error?.message || "DESKTOP_AI_CONNECT_FAILED" };
  }
  socket = next;
  next.on("open", () => {
    reconnectAttempt = 0;
  });
  next.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || message.type !== "ai.call" || !message.id) return;
    try {
      const result = await executeCall(app, message);
      reply(message.id, true, result);
    } catch (error) {
      reply(message.id, false, undefined, error?.message || "DESKTOP_AI_FAILED");
    }
  });
  next.on("close", () => {
    if (socket === next) socket = null;
    if (!stopped) scheduleReconnect(app);
  });
  next.on("error", () => {
    try { next.close(); } catch {}
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

module.exports = { bindIpc, disconnect };
