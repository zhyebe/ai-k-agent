import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createPersistence } from "./persistence.mjs";
import { createProvider, publicProvider, verifyProvider } from "./provider.mjs";
import { searchKnowledge, getRagStats, indexSkill } from "./rag.mjs";
import { discoverConnector, listConnectorAdapters } from "./connectors.mjs";
import { addEvent, getTask, hydrateState, persistConnector, persistProvider, persistSkill, persistTask, publicState, setPersistence, state } from "./store.mjs";
import { autoJudge, claimManual, runAnalysis, startController, startTask, stopAllControllers, stopTask } from "./engine.mjs";
import { hasPersistentSecret, maskSecret } from "./crypto.mjs";
import { credentialExists, initVault, listCredentials, setVaultPersistence, storeCredential, vaultStatus } from "./vault.mjs";
import { adminAuthStatus, adminTokenFromRequest, createAdminSession, getAdminSession, requireAdmin, revokeAdminSession } from "./auth.mjs";

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "null",
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
]);
await app.register(cors, { origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)) });
await app.register(websocket);
const persistence = await createPersistence();
setPersistence(persistence);
const restoredState = await persistence.loadState?.().catch(() => null);
hydrateState(restoredState);
const restoredCredentials = await persistence.loadCredentials?.().catch(() => []);
await initVault({ persistedRecords: restoredCredentials });
setVaultPersistence(persistence);
const streams = new Set();

const workflowTemplate = [
  ["connect", "连接目标"],
  ["login", "登录验证"],
  ["collect", "数据采集"],
  ["analyze", "趋势分析"],
  ["rules", "规则裁决"],
  ["action", "执行动作"],
];

function createWorkflow() {
  return workflowTemplate.map(([key, label], index) => ({ key, label, status: index === 0 ? "active" : "pending", detail: "等待执行" }));
}

function createDefaultRules() {
  return [
    { id: `rule_${Date.now()}_01`, order: 1, name: "数据新鲜度 < 5 秒", mode: "AUTO", status: "passed", detail: "等待实时数据" },
    { id: `rule_${Date.now()}_02`, order: 2, name: "单品种仓位 ≤ 30%", mode: "AUTO", status: "passed", detail: "等待账户对账" },
    { id: `rule_${Date.now()}_03`, order: 3, name: "高波动信号需人工复核", mode: "REVIEW", status: "pending", detail: "触发时暂停动作" },
    { id: `rule_${Date.now()}_04`, order: 4, name: "异常数据立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
  ];
}

function applyConnectorToTask(task, profile) {
  if (!profile) return;
  const targetChanged = task.target.connectorId !== profile.connectorId;
  task.target = {
    ...task.target,
    type: profile.type,
    name: profile.name,
    url: profile.type === "website" ? profile.target : "",
    installPath: profile.type === "app" ? profile.target : "",
    connectorId: profile.connectorId,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    discoveryStatus: profile.discoveryStatus,
    adapterStatus: profile.adapterStatus,
    connectionStatus: profile.reviewStatus === "APPROVED" ? "connected" : "review_required",
    loginStatus: profile.reviewStatus === "APPROVED" ? "simulation_ready" : "adapter_review_required",
    executionModes: profile.executionModes,
  };
  if (targetChanged) {
    task.target.credentialRef = "";
    task.target.accountLabel = "未配置";
    task.target.credentialStatus = "未配置";
  }
}

function snapshot() {
  return { ...publicState(), health: { db: persistence.mode, dbAvailable: persistence.available, persistentSecret: hasPersistentSecret(), vault: vaultStatus() }, rag: getRagStats() };
}

function broadcast() {
  const message = JSON.stringify({ type: "workspace.updated", payload: snapshot() });
  for (const socket of streams) {
    try { socket.send(message); } catch { streams.delete(socket); }
  }
}

app.get("/api/health", async () => ({ ok: true, service: "axiom-api", uptimeSec: Math.round(process.uptime()), persistence: await persistence.health(), persistentSecret: hasPersistentSecret(), vault: vaultStatus(), adapters: listConnectorAdapters().length }));
app.post("/api/admin/login", async (request, reply) => {
  const body = request.body || {};
  const session = createAdminSession(body.username, body.password);
  if (!session) return reply.code(401).send({ error: "ADMIN_CREDENTIALS_INVALID" });
  addEvent("admin_login", "管理账号登录成功", { username: session.username });
  return session;
});
app.get("/api/admin/session", { preHandler: requireAdmin }, async (request) => ({ authenticated: true, ...request.adminSession, config: adminAuthStatus() }));
app.post("/api/admin/logout", { preHandler: requireAdmin }, async (request) => { revokeAdminSession(adminTokenFromRequest(request)); return { ok: true }; });
app.get("/api/workspace", async () => snapshot());
app.get("/api/overview", async () => ({ task: state.tasks[0], events: state.events.slice(0, 12), runs: state.runs, rag: getRagStats() }));
app.get("/api/events", async (request) => {
  const limit = Math.min(80, Math.max(1, Number(request.query?.limit) || 30));
  return { events: state.events.slice(0, limit) };
});

app.get("/api/events/stream", { websocket: true }, (socket) => {
  streams.add(socket);
  socket.send(JSON.stringify({ type: "workspace.updated", payload: snapshot() }));
  socket.on("close", () => streams.delete(socket));
});

app.get("/api/tasks", async () => ({ tasks: state.tasks }));
app.post("/api/tasks", async (request, reply) => {
  const body = request.body || {};
  const targetType = body.targetType === "app" ? "app" : "website";
  const targetInput = { type: targetType, name: body.targetName, url: body.url, installPath: body.installPath, appId: body.appId };
  let profile = null;
  const hasTarget = targetType === "website" ? Boolean(String(body.url || "").trim()) : Boolean(String(body.installPath || body.appId || "").trim());
  if (hasTarget) {
    try { profile = discoverConnector(targetInput); } catch (error) { return reply.code(400).send({ error: error.message }); }
    state.connectors = state.connectors.filter((item) => item.connectorId !== profile.connectorId);
    state.connectors.unshift(profile);
    persistConnector(profile);
  }
  const task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(body.name || "新建自动驾驶任务"),
    status: "READY",
    mode: body.mode === "LIVE" ? "LIVE" : body.mode === "SHADOW" ? "SHADOW" : "PAPER",
    symbol: String(body.symbol || "BTC/USDT"),
    timeframe: String(body.timeframe || "15m"),
    target: {
      type: targetType,
      name: String(body.targetName || "未命名目标"),
      url: String(body.url || ""),
      appId: String(body.appId || ""),
      installPath: String(body.installPath || ""),
      connectorId: profile?.connectorId || "",
      adapterId: profile?.adapterId || "",
      adapterVersion: profile?.adapterVersion || "",
      accountLabel: String(body.accountLabel || "未配置"),
      credentialStatus: "未配置",
      connectionStatus: profile?.reviewStatus === "APPROVED" ? "connected" : profile ? "review_required" : "disconnected",
      loginStatus: profile?.reviewStatus === "APPROVED" ? "simulation_ready" : profile ? "adapter_review_required" : "unconfigured",
      executionModes: profile?.executionModes || [],
      adapterStatus: profile?.adapterStatus || "待发现",
      discoveryStatus: profile?.discoveryStatus || "未发现",
    },
    riskProfile: "Balanced",
    workflow: createWorkflow(),
    rules: createDefaultRules(),
    decision: { action: "HOLD", confidence: 0, targetPositionPct: 0, maxOrderValuePct: 0, reasonCodes: [], evidenceIds: [], riskFlags: ["NOT_ANALYZED"], invalidation: "", createdAt: new Date().toISOString(), ttlSec: 300 },
    metrics: { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
    nextTrigger: "等待连接",
    updatedAt: new Date().toISOString(),
    stopLocked: false,
  };
  state.tasks.unshift(task);
  persistTask(task);
  addEvent("task_created", `已创建任务：${task.name}`, { taskId: task.id });
  broadcast();
  return reply.code(201).send({ task });
});

app.post("/api/tasks/:taskId/start", async (request, reply) => {
  try { const task = startTask(request.params.taskId); broadcast(); return { task }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/stop", async (request, reply) => {
  try { const task = stopTask(request.params.taskId); broadcast(); return { task }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/manual", async (request, reply) => {
  try { const task = claimManual(request.params.taskId); broadcast(); return { task }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/auto-judge", async (request, reply) => {
  try { const task = autoJudge(request.params.taskId); broadcast(); return { task }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/analyze", async (request, reply) => {
  try { const result = await runAnalysis(request.params.taskId, request.body?.providerId); broadcast(); return result; } catch (error) { return reply.code(400).send({ error: error.message }); }
});

app.get("/api/connectors", async () => ({ connectors: state.connectors }));
app.get("/api/connectors/adapters", async () => ({ adapters: listConnectorAdapters() }));
app.get("/api/credentials", { preHandler: requireAdmin }, async () => ({ credentials: listCredentials() }));

app.post("/api/connectors/discover", async (request, reply) => {
  try {
    const body = request.body || {};
    const profile = discoverConnector(body);
    state.connectors = state.connectors.filter((item) => item.connectorId !== profile.connectorId);
    state.connectors.unshift(profile);
    persistConnector(profile);
    const task = body.taskId ? getTask(String(body.taskId)) : null;
    if (task) {
      applyConnectorToTask(task, profile);
      persistTask(task);
    }
    addEvent("connector_discovered", `已发现${profile.type === "website" ? "网站" : "桌面 App"}目标：${profile.name}`, { connectorId: profile.connectorId, adapterId: profile.adapterId, reviewStatus: profile.reviewStatus });
    broadcast();
    return profile;
  } catch (error) {
    return reply.code(400).send({ error: error.message || "CONNECTOR_DISCOVERY_FAILED" });
  }
});

app.post("/api/connectors/test", async (request, reply) => {
  try {
    const body = request.body || {};
    const targetType = body.type === "app" ? "app" : "website";
    const hasTarget = targetType === "app"
      ? Boolean(String(body.installPath || body.appId || "").trim())
      : Boolean(String(body.url || "").trim());
    const profile = hasTarget
      ? discoverConnector({ ...body, type: targetType })
      : body.connectorId
        ? state.connectors.find((item) => item.connectorId === String(body.connectorId))
        : null;
    if (!profile) return reply.code(404).send({ error: "CONNECTOR_NOT_FOUND" });
    if (!state.connectors.some((item) => item.connectorId === profile.connectorId)) {
      state.connectors.unshift(profile);
      persistConnector(profile);
    }
    let credentialRef = String(body.credentialRef || "");
    let accountLabel = "未配置";
    if (credentialRef) {
      if (credentialRef === "credential:demo") accountLabel = "tra***emo";
      else {
        if (!credentialExists(credentialRef)) return reply.code(400).send({ error: "CREDENTIAL_REF_NOT_FOUND" });
        const stored = listCredentials().find((item) => item.credentialRef === credentialRef);
        if (stored?.target?.adapterId && stored.target.adapterId !== profile.adapterId) return reply.code(400).send({ error: "CREDENTIAL_TARGET_MISMATCH" });
        if (stored?.target?.url && profile.type === "website") {
          if (new URL(stored.target.url).hostname !== new URL(profile.target).hostname) return reply.code(400).send({ error: "CREDENTIAL_TARGET_MISMATCH" });
        }
        if (stored?.target?.installPath && profile.type === "app" && stored.target.installPath !== profile.target) return reply.code(400).send({ error: "CREDENTIAL_TARGET_MISMATCH" });
        accountLabel = stored?.accountLabel || "已托管";
      }
    } else if (body.username || body.password) {
      if (!body.username || !body.password) return reply.code(400).send({ error: "CREDENTIALS_REQUIRED" });
      const stored = await storeCredential({
        username: body.username,
        password: body.password,
        label: body.name,
        target: {
          type: profile.type,
          url: profile.type === "website" ? profile.target : "",
          installPath: profile.type === "app" ? profile.target : "",
          adapterId: profile.adapterId,
        },
      });
      credentialRef = stored.credentialRef;
      accountLabel = stored.accountLabel;
    }
    const adapterReady = profile.reviewStatus === "APPROVED";
    const hasCredential = Boolean(credentialRef);
    const loginStatus = adapterReady && hasCredential ? "simulation_ready" : adapterReady ? "credential_required" : "adapter_review_required";
    const connectionStatus = adapterReady ? "connected" : "review_required";
    const task = body.taskId ? getTask(String(body.taskId)) : null;
    if (task) {
      applyConnectorToTask(task, profile);
      task.target.credentialRef = credentialRef;
      task.target.accountLabel = accountLabel;
      task.target.credentialStatus = hasCredential ? "已托管" : "未配置";
      task.target.connectionStatus = connectionStatus;
      task.target.loginStatus = loginStatus;
      persistTask(task);
    }
    addEvent("connector_test", `${profile.name} 连接检查完成：${hasCredential ? "凭据已托管" : "等待凭据"}，${adapterReady ? "模拟流程可用" : "适配器待审核"}`, { connectorId: profile.connectorId, adapterId: profile.adapterId, loginStatus });
    broadcast();
    return { ok: true, connectorId: profile.connectorId, adapterId: profile.adapterId, adapterVersion: profile.adapterVersion, connectionStatus, loginStatus, credentialStatus: hasCredential ? "已托管" : "未配置", credentialRef, accountLabel, liveExecution: false, capabilities: profile.capabilities, executionModes: profile.executionModes };
  } catch (error) {
    return reply.code(400).send({ error: error.message || "CONNECTOR_TEST_FAILED" });
  }
});

app.get("/api/providers", { preHandler: requireAdmin }, async () => ({ providers: state.providers.map(publicProvider) }));
app.post("/api/providers", { preHandler: requireAdmin }, async (request, reply) => {
  const body = request.body || {};
  const existing = body.id ? state.providers.find((item) => item.id === String(body.id)) : null;
  let provider;
  try { provider = createProvider(body, existing); } catch (error) { return reply.code(400).send({ error: error.message || "PROVIDER_INVALID" }); }
  state.providers = state.providers.filter((item) => item.id !== provider.id);
  state.providers.push(provider);
  persistProvider(provider);
  addEvent("provider_saved", `已保存 Provider：${provider.name}（密钥仅服务端保存）`, { providerId: provider.id });
  broadcast();
  return reply.code(201).send({ provider: publicProvider(provider) });
});
app.post("/api/providers/:providerId/test", { preHandler: requireAdmin }, async (request, reply) => {
  const provider = state.providers.find((item) => item.id === request.params.providerId);
  if (!provider) return reply.code(404).send({ error: "PROVIDER_NOT_FOUND" });
  const verification = await verifyProvider(provider);
  provider.status = verification.status;
  persistProvider(provider);
  addEvent("provider_test", `Provider ${provider.name} 状态：${provider.status}`, { providerId: provider.id, code: verification.code, httpStatus: verification.httpStatus });
  broadcast();
  return { provider: publicProvider(provider), verification: { ok: verification.ok, code: verification.code, httpStatus: verification.httpStatus } };
});

app.get("/api/skills", { preHandler: requireAdmin }, async () => ({ skills: state.skills }));
app.post("/api/skills", { preHandler: requireAdmin }, async (request, reply) => {
  const body = request.body || {};
  const content = String(body.content || "").trim();
  if (!content) return reply.code(400).send({ error: "SKILL_CONTENT_REQUIRED" });
  const skill = {
    id: `skill_${Date.now()}`,
    title: String(body.title || body.filename || "未命名专家经验"),
    kind: body.kind === "rule" ? "rule" : body.kind === "redline" || body.kind === "guardrail" ? "guardrail" : "expert",
    source: String(body.filename || "手动输入"),
    status: "REVIEW",
    version: "draft-1",
    tags: Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(",").map((item) => item.trim()).filter(Boolean),
    chunks: 0,
    updatedAt: new Date().toISOString(),
    summary: content.slice(0, 120),
    content,
  };
  state.skills.unshift(skill);
  persistSkill(skill);
  addEvent("skill_ingested", `已解析专家经验，等待审核：${skill.title}`, { skillId: skill.id, chunks: 0 });
  broadcast();
  return reply.code(201).send({ skill });
});
app.post("/api/skills/:skillId/approve", { preHandler: requireAdmin }, async (request, reply) => {
  const skill = state.skills.find((item) => item.id === request.params.skillId);
  if (!skill) return reply.code(404).send({ error: "SKILL_NOT_FOUND" });
  skill.status = "APPROVED";
  skill.version = `v${Date.now().toString().slice(-3)}`;
  skill.chunks = indexSkill(skill);
  persistSkill(skill);
  addEvent("skill_approved", `Skill 已审核发布：${skill.title}`, { skillId: skill.id, version: skill.version, chunks: skill.chunks });
  broadcast();
  return { skill };
});
app.get("/api/rag/search", async (request) => ({ query: request.query?.q || "", results: searchKnowledge(request.query?.q || "", {}, 8), stats: getRagStats() }));

app.get("/api/admin/summary", { preHandler: requireAdmin }, async () => ({
  users: 12,
  activeTasks: state.tasks.filter((task) => ["MONITORING", "ANALYZING", "EXECUTING"].includes(task.status)).length,
  reviewQueue: state.skills.filter((skill) => skill.status === "REVIEW").length + state.tasks.reduce((sum, task) => sum + task.rules.filter((rule) => rule.status === "pending").length, 0),
  auditEvents: state.events.length,
  persistence: await persistence.health(),
}));

const port = Number(process.env.PORT || 8787);
for (const task of state.tasks) if (task.status === "MONITORING") startController(task.id);
try {
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Axiom API listening on http://127.0.0.1:${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

process.on("SIGTERM", async () => { stopAllControllers(); await persistence.close(); await app.close(); process.exit(0); });
process.on("SIGINT", async () => { stopAllControllers(); await persistence.close(); await app.close(); process.exit(0); });
