import { requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider, providerApiKey } from "./provider.mjs";

const socketsByUser = new Map();
const pendingCalls = new Map();

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

function pickSocket(userId) {
  return [...socketsFor(userId)].reverse().find(socketOpen) || null;
}

export function attachDesktopAiSocket(userId, socket) {
  const key = String(userId || "");
  if (!key || !socket) return () => {};
  const group = socketsByUser.get(key) || new Set();
  group.add(socket);
  socketsByUser.set(key, group);
  const onMessage = (raw) => {
    let parsed = raw;
    if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) parsed = Buffer.from(raw).toString("utf8");
    else if (Array.isArray(raw)) parsed = Buffer.concat(raw).toString("utf8");
    if (typeof parsed !== "string") return;
    try { handleDesktopAiMessage(JSON.parse(parsed)); } catch {}
  };
  const onClose = () => detachDesktopAiSocket(key, socket);
  socket.on?.("message", onMessage);
  socket.on?.("close", onClose);
  socket.on?.("error", onClose);
  return () => {
    socket.off?.("message", onMessage);
    socket.off?.("close", onClose);
    socket.off?.("error", onClose);
    detachDesktopAiSocket(key, socket);
  };
}

export function detachDesktopAiSocket(userId, socket) {
  const key = String(userId || "");
  const group = socketsByUser.get(key);
  if (!group) return;
  group.delete(socket);
  if (!group.size) socketsByUser.delete(key);
}

export function handleDesktopAiMessage(message) {
  if (!message || message.type !== "ai.result" || !message.id) return false;
  const waiter = pendingCalls.get(message.id);
  if (!waiter) return true;
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
    apiKey: providerApiKey(provider),
  };
}

async function waitForSocket(userId, timeoutMs) {
  const started = Date.now();
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  while (true) {
    const socket = pickSocket(userId);
    if (socket) return socket;
    if (Date.now() - started >= waitMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

export async function invokeDesktopAi(userId, method, payload = {}) {
  const waitMs = Number.isFinite(Number(process.env.AXIOM_DESKTOP_AI_WAIT_MS))
    ? Math.max(0, Number(process.env.AXIOM_DESKTOP_AI_WAIT_MS))
    : 8000;
  const socket = await waitForSocket(userId, waitMs);
  if (!socket) throw new Error("DESKTOP_AI_OFFLINE");
  const id = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.options?.timeoutMs) || 45000)) + 8000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error("DESKTOP_AI_TIMEOUT"));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({
        type: "ai.call",
        id,
        method,
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
  if (desktopAiRequired()) return invokeDesktopAi(userId, method, payload);
  if (method === "requestDecision") return requestDecision(payload.provider, payload.context, payload.options);
  if (method === "requestSegmentReview") return requestSegmentReview(payload.provider, payload.segment, payload.context, payload.options);
  if (method === "verifyProvider") return verifyProvider(payload.provider, payload.options);
  throw new Error("AI_METHOD_UNKNOWN");
}

export function resetDesktopAiForTests() {
  socketsByUser.clear();
  for (const waiter of pendingCalls.values()) clearTimeout(waiter.timer);
  pendingCalls.clear();
}
