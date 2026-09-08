import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const adapters = new Map();

function normalizeType(type) {
  return type === "app" ? "app" : "website";
}

export function registerConnectorAdapter(adapter) {
  if (!adapter?.id || !adapter?.type || typeof adapter.match !== "function") throw new Error("INVALID_CONNECTOR_ADAPTER");
  adapters.set(adapter.id, Object.freeze({
    ...adapter,
    type: normalizeType(adapter.type),
    version: String(adapter.version || "1.0.0"),
    capabilities: [...new Set(adapter.capabilities || [])],
    executionModes: [...new Set(adapter.executionModes || [])],
  }));
  return adapters.get(adapter.id);
}

registerConnectorAdapter({
  id: "northstar-web",
  version: "1.0.0",
  type: "website",
  displayName: "Northstar Exchange",
  reviewStatus: "APPROVED",
  match: ({ url }) => {
    try { return new URL(url).hostname === "demo.exchange.local"; } catch { return false; }
  },
  capabilities: ["navigate", "login", "read_history", "observe_orders", "paper_trade"],
  executionModes: ["PAPER", "SHADOW"],
  login: {
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
    successSelector: '[data-authenticated="true"]',
  },
});

registerConnectorAdapter({
  id: "generic-web",
  version: "1.0.0",
  type: "website",
  displayName: "通用网站连接器",
  reviewStatus: "REVIEW_REQUIRED",
  match: () => true,
  capabilities: ["navigate", "read_history"],
  executionModes: [],
});

registerConnectorAdapter({
  id: "generic-desktop",
  version: "1.0.0",
  type: "app",
  displayName: "通用桌面 App 连接器",
  reviewStatus: "REVIEW_REQUIRED",
  match: () => true,
  capabilities: ["open_app", "observe_window", "read_history"],
  executionModes: [],
});

function targetKey(input) {
  const value = input.type === "website" ? String(input.url || "") : String(input.installPath || input.appId || "");
  return crypto.createHash("sha256").update(`${input.type}:${value}`).digest("hex").slice(0, 20);
}

function validateWebsite(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { throw new Error("INVALID_TARGET_URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("UNSUPPORTED_PROTOCOL");
  return parsed;
}

function findAdapter(input) {
  return [...adapters.values()]
    .filter((adapter) => adapter.type === input.type)
    .sort((left, right) => Number(right.reviewStatus === "APPROVED") - Number(left.reviewStatus === "APPROVED"))
    .find((adapter) => adapter.match(input)) || null;
}

export function discoverConnector(input = {}) {
  const type = normalizeType(input.type);
  const normalized = { ...input, type };
  let target = "";
  let pathStatus = "unknown";
  if (type === "website") {
    const parsed = validateWebsite(input.url);
    target = parsed.toString();
  } else {
    target = String(input.installPath || input.appId || "").trim();
    if (!target) throw new Error("INSTALL_PATH_REQUIRED");
    if (input.installPath) pathStatus = fs.existsSync(path.resolve(input.installPath)) ? "exists" : "not_found";
  }
  const adapter = findAdapter({ ...normalized, url: type === "website" ? target : "", installPath: type === "app" ? target : "" });
  if (!adapter) throw new Error("CONNECTOR_NOT_FOUND");
  const approved = adapter.reviewStatus === "APPROVED";
  const canPaperTrade = adapter.executionModes.includes("PAPER");
  return {
    connectorId: `connector_${targetKey({ type, url: type === "website" ? target : "", installPath: type === "app" ? target : "" })}`,
    type,
    target,
    name: String(input.name || adapter.displayName),
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    status: "DISCOVERED",
    discoveryStatus: "已发现",
    adapterStatus: approved ? `${adapter.displayName} v${adapter.version}` : "通用适配器待审核",
    reviewStatus: adapter.reviewStatus,
    capabilities: adapter.capabilities,
    actionMapping: canPaperTrade ? "模拟动作已映射" : "待目标适配器审核",
    executionModes: adapter.executionModes,
    liveExecution: false,
    pathStatus,
    discoveredAt: new Date().toISOString(),
  };
}

export function getConnectorAdapter(adapterId) {
  return adapters.get(String(adapterId || "")) || null;
}

export function listConnectorAdapters() {
  return [...adapters.values()].map(({ login, match, ...adapter }) => ({ ...adapter }));
}

export function adapterCanLogin(adapterId) {
  return Boolean(getConnectorAdapter(adapterId)?.login);
}

export function adapterCanExecute(adapterId, mode) {
  const adapter = getConnectorAdapter(adapterId);
  return Boolean(adapter && adapter.executionModes.includes(mode) && adapter.reviewStatus === "APPROVED");
}

export function connectorStatusForAdapter(adapter) {
  if (!adapter) return { status: "UNSUPPORTED", message: "没有匹配的 Connector Adapter" };
  if (adapter.reviewStatus !== "APPROVED") return { status: "REVIEW_REQUIRED", message: "目标适配器需要审核后才能执行登录或动作" };
  return { status: "READY", message: "目标适配器已审核，可执行受控流程" };
}
