import { listProviderModels, requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider, providerApiKey } from "./provider.mjs";

const socketsByUser = new Map();
const pendingCalls = new Map();
const socketState = new Map();

export function desktopAiRequired() {
  return process.env.AXIOM_REQUIRE_DESKTOP_AI === "1";
}

function socketOpen(socket) {
  return socket && (socket.readyState === 1 || socket.readyState === "open");
}

function socketsFor(userId) {
  return socketsByUser.get(String(userId || "")) || new Set();
}

export function hasDesktopAi(userId) {
  return [...socketsFor(userId)].some(socketOpen);
}

function pickSocket(userId, channel = "ai", requiredCapability = "") {
  return [...socketsFor(userId)].reverse().find((socket) => socketOpen(socket)
    && (!(requiredCapability || channel === "browser") || socketState.get(socket)?.capabilities.includes(requiredCapability || "browser-v1"))) || null;
}

export function attachDesktopAiSocket(userId, socket) {
  const key = String(userId || "");
  if (!key || !socket) return () => {};
  const group = socketsByUser.get(key) || new Set();
  group.add(socket);
  socketsByUser.set(key, group);
  const state = { alive: true, capabilities: [], timer: null, cleanup: null };
  socketState.set(socket, state);
  const onMessage = (raw) => {
    let parsed = raw;
    if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) parsed = Buffer.from(raw).toString("utf8");
    else if (Array.isArray(raw)) parsed = Buffer.concat(raw).toString("utf8");
    if (typeof parsed !== "string") return;
    try {
      const message = JSON.parse(parsed);
      if (message.type === "runtime.hello") {
        state.capabilities = Array.isArray(message.capabilities) ? message.capabilities.filter((item) => item === "browser-v1") : [];
        return;
      }
      handleDesktopAiMessage(message, socket);
    } catch {}
  };
  const onClose = () => detachDesktopAiSocket(key, socket);
  const onPong = () => { state.alive = true; };
  socket.on?.("message", onMessage);
  socket.on?.("close", onClose);
  socket.on?.("error", onClose);
  socket.on?.("pong", onPong);
  if (typeof socket.ping === "function") {
    state.timer = setInterval(() => {
      if (!state.alive || !socketOpen(socket)) {
        detachDesktopAiSocket(key, socket);
        try { socket.terminate(); } catch {}
        return;
      }
      state.alive = false;
      try { socket.ping(); } catch { onClose(); }
    }, 15000);
    state.timer.unref?.();
  }
  state.cleanup = () => {
    clearInterval(state.timer);
    socket.off?.("message", onMessage);
    socket.off?.("close", onClose);
    socket.off?.("error", onClose);
    socket.off?.("pong", onPong);
  };
  return onClose;
}

export function detachDesktopAiSocket(userId, socket) {
  const key = String(userId || "");
  socketState.get(socket)?.cleanup();
  socketState.delete(socket);
  for (const [id, waiter] of pendingCalls) {
    if (waiter.socket !== socket) continue;
    clearTimeout(waiter.timer);
    pendingCalls.delete(id);
    waiter.reject(new Error(waiter.channel === "browser" ? "DESKTOP_BROWSER_DISCONNECTED" : "DESKTOP_AI_DISCONNECTED"));
  }
  const group = socketsByUser.get(key);
  if (!group) return;
  group.delete(socket);
  if (!group.size) socketsByUser.delete(key);
}

export function disconnectDesktopAiUser(userId, reason = "USER_SESSION_REVOKED") {
  const key = String(userId || "");
  const group = socketsByUser.get(key);
  if (group) {
    for (const socket of group) {
      detachDesktopAiSocket(key, socket);
      try { socket.close(1008, reason); } catch {}
    }
    socketsByUser.delete(key);
  }
  for (const [id, waiter] of pendingCalls) {
    if (waiter.userId !== key) continue;
    clearTimeout(waiter.timer);
    pendingCalls.delete(id);
    waiter.reject(new Error(reason));
  }
}

export function handleDesktopAiMessage(message, socket) {
  if (!message || !["ai.result", "browser.result"].includes(message.type) || !message.id) return false;
  const waiter = pendingCalls.get(message.id);
  if (!waiter) return true;
  if (waiter.socket !== socket || message.type !== `${waiter.channel}.result`) return false;
  clearTimeout(waiter.timer);
  pendingCalls.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(String(message.error || "DESKTOP_AI_FAILED")));
  return true;
}

export function desktopProviderPayload(provider) {
  return {
    id: provider?.id || "",
    name: provider?.name || "",
    model: provider?.model || "",
    baseUrl: provider?.baseUrl || "",
    apiFormat: resolveProviderWireApi(provider),
    fullUrlMode: provider?.fullUrlMode === true,
    modelsUrl: provider?.modelsUrl || "",
    apiKey: providerApiKey(provider),
  };
}

async function waitForSocket(userId, timeoutMs, channel, requiredCapability) {
  const started = Date.now();
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  while (true) {
    const socket = pickSocket(userId, channel, requiredCapability);
    if (socket) return socket;
    if (Date.now() - started >= waitMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

export async function invokeDesktopAi(userId, method, payload = {}) {
  const channel = payload.channel === "browser" ? "browser" : "ai";
  const waitMs = Number.isFinite(Number(process.env.AXIOM_DESKTOP_AI_WAIT_MS))
    ? Math.max(0, Number(process.env.AXIOM_DESKTOP_AI_WAIT_MS))
    : 8000;
  const socket = await waitForSocket(userId, waitMs, channel, payload.requiredCapability);
  if (!socket) throw new Error(channel === "browser" || payload.requiredCapability
    ? (hasDesktopAi(userId) ? "DESKTOP_BROWSER_UPDATE_REQUIRED" : "DESKTOP_BROWSER_OFFLINE")
    : "DESKTOP_AI_OFFLINE");
  const id = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.options?.timeoutMs) || 45000)) + 8000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      try { socket.send(JSON.stringify({ type: `${channel}.cancel`, id })); } catch {}
      reject(new Error(channel === "browser" ? "DESKTOP_BROWSER_TIMEOUT" : "DESKTOP_AI_TIMEOUT"));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer, socket, channel, userId: String(userId || "") });
    try {
      socket.send(JSON.stringify({
        type: `${channel}.call`,
        id,
        method,
        userId: String(userId),
        deadlineAt: Date.now() + timeoutMs - 2000,
        input: payload.input,
        credential: payload.credential,
        provider: desktopProviderPayload(payload.provider),
        context: payload.context || null,
        segment: payload.segment || null,
        options: payload.options || {},
      }));
    } catch (error) {
      clearTimeout(timer);
      pendingCalls.delete(id);
      reject(new Error(error?.message || "DESKTOP_AI_SEND_FAILED"));
    }
  });
}

export async function callProviderMethod(method, userId, payload = {}) {
  if (desktopAiRequired() || method === "requestMarketAnalysis") return invokeDesktopAi(userId, method, { ...payload, channel: "ai", requiredCapability: method === "requestMarketAnalysis" ? "browser-v1" : "" });
  if (method === "requestDecision") return requestDecision(payload.provider, payload.context, payload.options);
  if (method === "requestSegmentReview") return requestSegmentReview(payload.provider, payload.segment, payload.context, payload.options);
  if (method === "verifyProvider") return verifyProvider(payload.provider, payload.options);
  if (method === "listProviderModels") return listProviderModels(payload.provider, payload.options);
  throw new Error("AI_METHOD_UNKNOWN");
}

export function resetDesktopAiForTests() {
  for (const state of socketState.values()) state.cleanup();
  socketState.clear();
  socketsByUser.clear();
  for (const waiter of pendingCalls.values()) clearTimeout(waiter.timer);
  pendingCalls.clear();
}
