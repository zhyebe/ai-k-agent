import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createPersistence } from "./persistence.mjs";
import { createProvider, publicProvider } from "./provider.mjs";
import { searchKnowledge, getRagStats, indexSkill } from "./rag.mjs";
import { discoverConnector, listConnectorAdapters } from "./connectors.mjs";
import { addEvent, collapseDuplicateProviders, findOwnedProviderMatch, findProviderForUser, getAgentOutput, getAgentRuns, getTask, hydrateState, persistConnector, persistDeletedProvider, persistProvider, persistSkill, persistTask, publicConnector, publicProviderList, publicSkill, publicState, publicTask, resolveDefaultProviderId, setPersistence, state, subscribeState } from "./store.mjs";
import { autoJudge, cancelPendingAction, claimManual, confirmPendingAction, runAnalysis, setAutoDecision, setTaskMode, setTaskProvider, startController, startTask, stopAllControllers, stopTask, takeoverPendingAction } from "./engine.mjs";
import { openMarketBrowser, observeMarket } from "./market.mjs";
import { browserLogin, browserLoginStatus } from "./tools.mjs";
import { hasPersistentSecret } from "./crypto.mjs";
import { credentialExists, findOwnedCredential, initVault, listCredentials, setVaultPersistence, storeCredential, vaultStatus } from "./vault.mjs";
import { adminAuthStatus, adminTokenFromRequest, createAdminSession, requireAdmin, revokeAdminSession } from "./auth.mjs";
import { assignTask, assignedTaskIds, canAccessTask, createUser, createUserSession, getUserSession, hydrateUserSessions, hydrateUsers, listUsers, requireUser, revokeUserSession, setUserPersistence, unassignTask, updateUser, userAuthStatus, userIdsForTask, userTokenFromRequest } from "./users.mjs";
import { isAllowedCorsOrigin, parseCsv } from "./cors.mjs";
import { attachDesktopAiSocket, callProviderMethod } from "./desktop-ai.mjs";
import { createUpdateFeed, proxyUpdateAsset, sanitizeUpdateAssetName } from "./updates.mjs";
import { Readable } from "node:stream";
import { closeAllBrowserSessions } from "./browser.mjs";

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
await app.register(cors, {
  origin: (origin, callback) => callback(null, isAllowedCorsOrigin(origin, {
    extraOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS),
    extraHosts: parseCsv(process.env.CORS_ALLOWED_HOSTS),
  })),
  allowedHeaders: ["content-type", "x-admin-token", "x-user-token", "authorization"],
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 86400,
});
await app.register(websocket, { options: { maxPayload: 50 * 1024 * 1024 } });
const persistence = await createPersistence();
setPersistence(persistence);
let restoredState = null;
let stateLoadFailed = false;
try {
  restoredState = await persistence.loadState?.() || null;
} catch (error) {
  stateLoadFailed = true;
  console.error("persistence.loadState failed", error);
  restoredState = null;
}
hydrateState(restoredState);
const restoredCredentials = await persistence.loadCredentials?.().catch(() => []);
await initVault({ persistedRecords: restoredCredentials });
setVaultPersistence(persistence);
const restoredUsers = restoredState?.users?.length
  ? restoredState.users
  : await persistence.loadUsers?.().catch((error) => { console.error("loadUsers failed", error); return []; }) || [];
const restoredAssignments = restoredState?.assignments?.length
  ? restoredState.assignments
  : await persistence.loadAssignments?.().catch((error) => { console.error("loadAssignments failed", error); return []; }) || [];
hydrateUsers(restoredUsers, restoredAssignments);
hydrateUserSessions(await persistence.loadUserSessions?.().catch(() => []));
setUserPersistence(persistence);
const streams = new Set();
const sseClients = new Set();
const updateFeed = createUpdateFeed();

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
    { id: `rule_${Date.now()}_03`, order: 3, name: "高波动信号需人工复核", mode: "REVIEW", status: "standby", detail: "触发时暂停动作" },
    { id: `rule_${Date.now()}_04`, order: 4, name: "异常数据立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
  ];
}

function applyConnectorToTask(task, profile) {
  if (!profile) return;
  const targetChanged = task.target.connectorId !== profile.connectorId;
  const approved = profile.reviewStatus === "APPROVED";
  const readonly = profile.adapterId === "haohan-readonly";
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
    connectionStatus: approved ? (readonly ? "readonly_ready" : "disconnected") : "review_required",
    loginStatus: approved ? "credential_required" : "adapter_review_required",
    executionModes: profile.executionModes,
  };
  if (targetChanged) {
    task.target.credentialRef = "";
    task.target.accountLabel = "未配置";
    task.target.credentialStatus = "未配置";
    task.target.browserSessionId = "";
  }
}

function ownerOptions(auth, taskId = "") {
  if (auth?.type !== "user") return {};
  return { ownerUserId: auth.user.id, ownerUserIds: taskId ? userIdsForTask(taskId) : [auth.user.id] };
}

function credentialTargetFromProfile(profile) {
  if (!profile) return { type: "website", url: "", installPath: "", adapterId: "" };
  return {
    type: profile.type === "app" ? "app" : "website",
    url: profile.type === "website" ? String(profile.target || "") : "",
    installPath: profile.type === "app" ? String(profile.target || "") : "",
    adapterId: String(profile.adapterId || ""),
  };
}

function publicOwnedCredentials(auth) {
  return listCredentials(ownerOptions(auth)).map((item) => ({
    accountLabel: item.accountLabel,
    target: item.target,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

async function resolveOwnedCredential({ auth, task = null, profile, username = "", password = "", targetChanged = false }) {
  const ownerUserId = auth?.type === "user" ? String(auth.user.id) : "";
  const options = ownerOptions(auth, task?.id);
  const usernameValue = String(username || "").trim();
  const passwordValue = String(password || "");
  const target = credentialTargetFromProfile(profile);

  if (passwordValue) {
    if (!usernameValue) throw new Error("CREDENTIALS_REQUIRED");
    const stored = await storeCredential({
      username: usernameValue,
      password: passwordValue,
      label: profile?.name || "",
      ownerUserId,
      target,
    });
    return {
      credentialRef: stored.credentialRef,
      accountLabel: stored.accountLabel,
      credentialOwnerUserId: String(stored.ownerUserId || ownerUserId),
      hasCredential: true,
    };
  }

  if (!targetChanged) {
    const existingRef = String(task?.target?.credentialRef || "");
    if (existingRef && existingRef !== "credential:demo" && credentialExists(existingRef, options)) {
      const stored = listCredentials(options).find((item) => item.credentialRef === existingRef);
      return {
        credentialRef: existingRef,
        accountLabel: stored?.accountLabel || task.target.accountLabel || "已托管",
        credentialOwnerUserId: String(stored?.ownerUserId || task.target.credentialOwnerUserId || ownerUserId),
        hasCredential: true,
      };
    }
  }

  if (ownerUserId) {
    const owned = findOwnedCredential({ ownerUserId, target });
    if (owned) {
      return {
        credentialRef: owned.credentialRef,
        accountLabel: owned.accountLabel,
        credentialOwnerUserId: owned.ownerUserId,
        hasCredential: true,
      };
    }
  }

  if (usernameValue) throw new Error("CREDENTIALS_REQUIRED");
  return { credentialRef: "", accountLabel: "未配置", credentialOwnerUserId: "", hasCredential: false };
}

function rememberConnector(profile, auth) {
  if (auth?.type !== "user") return profile;
  const existing = state.connectors.find((item) => item.connectorId === profile.connectorId);
  const ownerUserIds = [...new Set([...(existing?.ownerUserIds || []), existing?.ownerUserId, ...(profile.ownerUserIds || []), profile.ownerUserId, auth.user.id].filter(Boolean).map(String))];
  return { ...profile, ownerUserIds, ownerUserId: auth.user.id };
}

function upsertConnector(profile, auth) {
  const next = rememberConnector(profile, auth);
  state.connectors = state.connectors.filter((item) => item.connectorId !== next.connectorId);
  state.connectors.unshift(next);
  persistConnector(next);
  return next;
}

function tokenFromQuery(request, name) {
  const value = request.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasConnectorTargetInput(body = {}) {
  const type = body.type === "app" ? "app" : "website";
  return type === "app"
    ? Boolean(String(body.installPath || body.appId || "").trim())
    : Boolean(String(body.url || "").trim());
}

function userAuthFromRequest(request) {
  const userToken = userTokenFromRequest(request) || tokenFromQuery(request, "userToken");
  const userSession = getUserSession(userToken);
  if (userSession) return { type: "user", user: userSession.user, session: userSession, token: userToken };
  return null;
}

async function requireWorkspaceAccess(request, reply) {
  const auth = userAuthFromRequest(request);
  if (!auth || auth.type !== "user") return reply.code(401).send({ error: "USER_AUTH_REQUIRED" });
  request.auth = auth;
}

async function requireTaskAccess(request, reply) {
  const auth = userAuthFromRequest(request);
  if (!auth || auth.type !== "user") return reply.code(401).send({ error: "USER_AUTH_REQUIRED" });
  const taskId = String(request.params?.taskId || request.body?.taskId || request.query?.taskId || "");
  if (taskId && !canAccessTask(auth.user.id, taskId)) return reply.code(403).send({ error: "TASK_ACCESS_DENIED" });
  request.auth = auth;
}

async function requireConnectorAccess(request, reply) {
  const auth = userAuthFromRequest(request);
  if (!auth || auth.type !== "user") return reply.code(401).send({ error: "USER_AUTH_REQUIRED" });
  const taskId = String(request.body?.taskId || "");
  const task = taskId ? getTask(taskId) : null;
  if (taskId && !task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
  if (taskId && !canAccessTask(auth.user.id, taskId)) return reply.code(403).send({ error: "TASK_ACCESS_DENIED" });
  const requestedConnectorId = String(request.body?.connectorId || "");
  if (task && requestedConnectorId && requestedConnectorId !== String(task.target?.connectorId || "")) {
    return reply.code(403).send({ error: "CONNECTOR_TASK_MISMATCH" });
  }
  if (!taskId && request.body?.connectorId) {
    const connector = state.connectors.find((item) => item.connectorId === String(request.body.connectorId));
    const owned = connector && (String(connector.ownerUserId || "") === auth.user.id || connector.ownerUserIds?.includes(auth.user.id));
    if (connector && !owned) return reply.code(403).send({ error: "CONNECTOR_ACCESS_DENIED" });
  }
  request.auth = auth;
}

function snapshot(auth = null) {
  const currentUser = auth?.type === "user" ? getUserSession(auth.token)?.user || auth.user : null;
  const taskIds = currentUser ? assignedTaskIds(currentUser.id) : null;
  return {
    ...publicState({ taskIds, userId: currentUser?.id || null }),
    health: { db: persistence.mode, dbAvailable: persistence.available, persistentSecret: hasPersistentSecret(), vault: vaultStatus() },
    rag: getRagStats(),
    credentials: currentUser ? publicOwnedCredentials({ type: "user", user: currentUser }) : [],
    auth: currentUser ? { type: "user", user: { ...currentUser, assignedTaskIds: taskIds } } : auth ? { type: auth.type, username: auth.username } : null,
  };
}

function broadcast(authFilter = null) {
  for (const entry of streams) {
    try {
      if (authFilter && entry.auth?.type === "user" && entry.auth.user.id !== authFilter) continue;
      entry.socket.send(JSON.stringify({ type: "workspace.updated", payload: snapshot(entry.auth) }));
    } catch {
      streams.delete(entry);
    }
  }
}

function sendStream(message) {
  if (message.type === "workspace.event") return;
  const taskId = String(message.payload?.taskId || "");
  const eventUserId = String(message.payload?.metadata?.userId || message.payload?.userId || "");
  for (const entry of streams) {
    try {
      if (!entry.auth) continue;
      if (entry.auth.type === "user" && ((taskId && !canAccessTask(entry.auth.user.id, taskId)) || (!taskId && eventUserId !== entry.auth.user.id))) continue;
      entry.socket.send(JSON.stringify(message));
    } catch {
      streams.delete(entry);
    }
  }
  for (const client of sseClients) {
    try {
      if (!client.auth) continue;
      if (taskId && client.taskId && client.taskId !== taskId) continue;
      if (client.auth.type === "user" && ((taskId && !canAccessTask(client.auth.user.id, taskId)) || (!taskId && eventUserId !== client.auth.user.id))) continue;
      client.reply.raw.write(`event: ${message.type}\ndata: ${JSON.stringify(message.payload)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

subscribeState((message) => {
  if (message.type === "agent.output" || message.type === "agent.run.completed") sendStream(message);
  if (message.type === "workspace.event") broadcast();
});

async function persistHydratedDefaults() {
  const records = [
    [state.tasks, restoredState?.tasks, persistTask],
    [state.skills, restoredState?.skills, persistSkill],
    [state.providers, restoredState?.providers, persistProvider],
    [state.connectors, restoredState?.connectors, persistConnector],
  ];
  for (const [current, restored, persist] of records) {
    const restoredIds = new Set((Array.isArray(restored) ? restored : []).map((item) => String(item?.id || item?.connectorId || "")));
    await Promise.all(current.filter((item) => !restoredIds.has(String(item?.id || item?.connectorId || ""))).map((item) => persist(item)));
  }
}

async function bootstrapDesktopUser() {
  if (listUsers().length) return;
  const username = String(process.env.DESKTOP_USERNAME || "").trim();
  const password = String(process.env.DESKTOP_PASSWORD || "");
  if (!username || !password) return;
  const user = await createUser({ username, password, displayName: process.env.DESKTOP_DISPLAY_NAME || username });
  for (const task of state.tasks) await assignTask(user.id, task.id);
  addEvent("user_bootstrapped", `已创建桌面用户 ${user.username}`, { userId: user.id });
}

if (stateLoadFailed) {
  console.error("skip persistHydratedDefaults/bootstrapDesktopUser: database state was not restored");
} else {
  if (restoredState) await persistHydratedDefaults();
  await bootstrapDesktopUser();
}

app.get("/api/health", async () => ({ ok: true, service: "axiom-api", uptimeSec: Math.round(process.uptime()), persistence: await persistence.health(), persistentSecret: hasPersistentSecret(), vault: vaultStatus(), adapters: listConnectorAdapters().length }));
app.get("/api/updates/latest", async (_request, reply) => {
  try {
    return await updateFeed.latestRelease();
  } catch (error) {
    return reply.code(502).send({ error: error.message || "UPDATE_FEED_UNAVAILABLE" });
  }
});
app.get("/api/updates/download/:name", async (request, reply) => {
  const name = sanitizeUpdateAssetName(request.params.name);
  if (!name) return reply.code(400).send({ error: "UPDATE_ASSET_INVALID" });
  try {
    const asset = await updateFeed.findAsset(name);
    if (!asset) return reply.code(404).send({ error: "UPDATE_ASSET_NOT_FOUND" });
    const upstream = await proxyUpdateAsset(asset);
    request.raw.setTimeout(0);
    reply.raw.setTimeout(0);
    reply.type(upstream.headers.get("content-type") || "application/octet-stream");
    if (upstream.headers.get("content-length")) reply.header("content-length", upstream.headers.get("content-length"));
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : Buffer.alloc(0));
  } catch (error) {
    return reply.code(502).send({ error: error.message || "UPDATE_UPSTREAM_FAILED" });
  }
});
app.post("/api/admin/login", async (request, reply) => {
  const body = request.body || {};
  const session = createAdminSession(body.username, body.password);
  if (!session) return reply.code(401).send({ error: "ADMIN_CREDENTIALS_INVALID" });
  addEvent("admin_login", "管理账号登录成功", { username: session.username });
  return session;
});
app.get("/api/admin/session", { preHandler: requireAdmin }, async (request) => ({ authenticated: true, ...request.adminSession, config: adminAuthStatus() }));
app.post("/api/admin/logout", { preHandler: requireAdmin }, async (request) => { revokeAdminSession(adminTokenFromRequest(request)); return { ok: true }; });

app.post("/api/user/login", async (request, reply) => {
  const body = request.body || {};
  const session = await createUserSession(body.username, body.password);
  if (!session) return reply.code(401).send({ error: "USER_CREDENTIALS_INVALID" });
  addEvent("user_login", `桌面用户登录：${session.user.username}`, { userId: session.user.id });
  return session;
});
app.get("/api/user/session", { preHandler: requireUser }, async (request) => ({ authenticated: true, ...request.userSession, config: userAuthStatus() }));
app.post("/api/user/logout", { preHandler: requireUser }, async (request) => { await revokeUserSession(userTokenFromRequest(request)); return { ok: true }; });

app.get("/api/admin/users", { preHandler: requireAdmin }, async () => ({ users: listUsers() }));
app.post("/api/admin/users", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const user = await createUser(request.body || {});
    addEvent("user_created", `已创建桌面用户 ${user.username}`, { userId: user.id });
    return reply.code(201).send({ user });
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.patch("/api/admin/users/:userId", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const user = await updateUser(request.params.userId, request.body || {});
    addEvent("user_updated", `已更新用户 ${user.username}`, { userId: user.id, status: user.status });
    return { user };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.post("/api/admin/users/:userId/tasks", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const taskId = String(request.body?.taskId || "").trim();
    if (!taskId) return reply.code(400).send({ error: "TASK_ID_REQUIRED" });
    if (!getTask(taskId)) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    const user = await assignTask(request.params.userId, taskId);
    addEvent("task_assigned", `已向 ${user.username} 分配任务`, { userId: user.id, taskId });
    broadcast();
    return { user };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.delete("/api/admin/users/:userId/tasks/:taskId", { preHandler: requireAdmin }, async (request, reply) => {
  try {
    const user = await unassignTask(request.params.userId, request.params.taskId);
    addEvent("task_unassigned", `已取消 ${user.username} 的任务分配`, { userId: user.id, taskId: request.params.taskId });
    broadcast();
    return { user };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});

app.get("/api/workspace", { preHandler: requireWorkspaceAccess }, async (request) => snapshot(request.auth));
app.get("/api/overview", { preHandler: requireWorkspaceAccess }, async (request) => {
  const data = snapshot(request.auth);
  return { task: data.tasks[0] || null, events: data.events.slice(0, 12), runs: data.runs, rag: data.rag };
});
app.get("/api/events", { preHandler: requireWorkspaceAccess }, async (request) => {
  const limit = Math.min(80, Math.max(1, Number(request.query?.limit) || 30));
  return { events: snapshot(request.auth).events.slice(0, limit) };
});

app.get("/api/events/stream", { websocket: true, preValidation: requireWorkspaceAccess }, (socket, request) => {
  if (!request.auth) {
    try { socket.close(1008, "USER_AUTH_REQUIRED"); } catch {}
    return;
  }
  const entry = { socket, auth: userAuthFromRequest(request) };
  streams.add(entry);
  socket.send(JSON.stringify({ type: "workspace.updated", payload: snapshot(entry.auth) }));
  socket.on("close", () => streams.delete(entry));
});
app.get("/api/desktop-ai", { websocket: true, preValidation: requireWorkspaceAccess }, (socket, request) => {
  if (!request.auth || request.auth.type !== "user") {
    try { socket.close(1008, "USER_AUTH_REQUIRED"); } catch {}
    return;
  }
  attachDesktopAiSocket(request.auth.user.id, socket);
  try { socket.send(JSON.stringify({ type: "ai.ready" })); } catch {}
});

app.get("/api/tasks", { preHandler: requireWorkspaceAccess }, async (request) => ({ tasks: snapshot(request.auth).tasks }));
app.post("/api/tasks", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
  const body = request.body || {};
  const targetType = body.targetType === "app" ? "app" : "website";
  const targetInput = { type: targetType, name: body.targetName, url: body.url, installPath: body.installPath, appId: body.appId };
  let profile = null;
  const hasTarget = targetType === "website" ? Boolean(String(body.url || "").trim()) : Boolean(String(body.installPath || body.appId || "").trim());
  if (hasTarget) {
    try { profile = discoverConnector(targetInput); } catch (error) { return reply.code(400).send({ error: error.message }); }
    profile = upsertConnector(profile, request.auth);
  }
  let resolved = { credentialRef: "", accountLabel: "未配置", credentialOwnerUserId: "", hasCredential: false };
  if (profile) {
    try {
      resolved = await resolveOwnedCredential({
        auth: request.auth,
        profile,
        username: body.username,
        password: body.password,
      });
    } catch (error) {
      return reply.code(400).send({ error: error.message || "CREDENTIALS_REQUIRED" });
    }
  }
  const task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(body.name || "新建观察任务"),
    status: "READY",
    mode: body.mode === "PAPER" ? "PAPER" : body.mode === "SHADOW" ? "SHADOW" : "LIVE",
    symbol: String(body.symbol || "DGJJ"),
    timeframe: String(body.timeframe || "15m"),
    automationAuthorized: false,
    autoDecisionEnabled: false,
    autoDecisionCountdownSec: 30,
    providerId: request.auth?.type === "user" ? resolveDefaultProviderId(request.auth.user.id) : "",
    pendingAction: null,
    target: {
      type: targetType,
      name: String(body.targetName || "未命名目标"),
      url: String(body.url || ""),
      appId: String(body.appId || ""),
      installPath: String(body.installPath || ""),
      connectorId: profile?.connectorId || "",
      adapterId: profile?.adapterId || "",
      adapterVersion: profile?.adapterVersion || "",
      accountLabel: resolved.accountLabel,
      credentialRef: resolved.credentialRef,
      credentialOwnerUserId: resolved.credentialOwnerUserId,
      credentialStatus: resolved.hasCredential ? "已托管" : "未配置",
      connectionStatus: profile?.reviewStatus === "APPROVED" ? (profile.adapterId === "haohan-readonly" ? "readonly_ready" : "disconnected") : profile ? "review_required" : "disconnected",
      loginStatus: profile?.reviewStatus === "APPROVED" ? (resolved.hasCredential ? "login_unverified" : "credential_required") : profile ? "adapter_review_required" : "unconfigured",
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
    monitoringEnabled: false,
    monitorGeneration: 0,
    monitoringRound: 0,
    monitorFailureCount: 0,
    lastObservedFingerprint: "",
    lastAnalyzedFingerprint: "",
    lastAnalysisSucceeded: false,
    lastPolledAt: null,
    lastCycleAt: null,
    nextPollAt: null,
    analysisCoverage: null,
  };
  state.tasks.unshift(task);
  await persistTask(task);
  if (request.auth?.type === "user") await assignTask(request.auth.user.id, task.id);
  addEvent("task_created", `已创建任务：${task.name}`, { taskId: task.id });
  broadcast();
  return reply.code(201).send({ task: publicTask(task) });
});

app.post("/api/tasks/:taskId/start", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = startTask(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/stop", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = stopTask(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/manual", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = claimManual(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/auto-judge", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = autoJudge(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/auto-decision", { preHandler: requireTaskAccess }, async (request, reply) => {
  try {
    const task = setAutoDecision(request.params.taskId, { enabled: request.body?.enabled === true, countdownSec: request.body?.countdownSec });
    broadcast();
    return { task: publicTask(task) };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.post("/api/tasks/:taskId/provider", { preHandler: requireTaskAccess }, async (request, reply) => {
  try {
    const task = setTaskProvider(request.params.taskId, request.body?.providerId, request.auth.user.id);
    broadcast();
    return { task: publicTask(task) };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.post("/api/tasks/:taskId/mode", { preHandler: requireTaskAccess }, async (request, reply) => {
  try {
    const task = setTaskMode(request.params.taskId, request.body?.mode);
    broadcast();
    return { task: publicTask(task) };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.post("/api/tasks/:taskId/pending-action/confirm", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = await confirmPendingAction(request.params.taskId, { source: "manual_confirm" }); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/pending-action/cancel", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = cancelPendingAction(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/pending-action/takeover", { preHandler: requireTaskAccess }, async (request, reply) => {
  try { const task = takeoverPendingAction(request.params.taskId); broadcast(); return { task: publicTask(task) }; } catch (error) { return reply.code(400).send({ error: error.message }); }
});
app.post("/api/tasks/:taskId/analyze", { preHandler: requireTaskAccess }, async (request, reply) => {
  try {
    const result = await runAnalysis(request.params.taskId, request.body?.providerId || resolveDefaultProviderId(request.auth.user.id), { trigger: "manual", userId: request.auth.user.id });
    broadcast();
    return { ...result, task: publicTask(result.task), output: getAgentOutput(request.params.taskId, result.run?.id, 400) };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});
app.get("/api/tasks/:taskId/agent-output", { preHandler: requireTaskAccess }, async (request) => {
  const runId = String(request.query?.runId || "");
  return { runs: getAgentRuns(request.params.taskId), output: getAgentOutput(request.params.taskId, runId, Number(request.query?.limit) || 500) };
});
app.get("/api/tasks/:taskId/agent-stream", { preHandler: requireTaskAccess }, async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const client = { reply, auth: request.auth, taskId: request.params.taskId };
  sseClients.add(client);
  reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ runs: getAgentRuns(request.params.taskId), output: getAgentOutput(request.params.taskId, request.query?.runId, 400) })}\n\n`);
  request.raw.on("close", () => sseClients.delete(client));
});
app.post("/api/tasks/:taskId/browser/open", { preHandler: requireTaskAccess }, async (request, reply) => {
  const task = getTask(request.params.taskId);
  if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
  const connector = state.connectors.find((item) => item.connectorId === task.target.connectorId);
  const result = await openMarketBrowser(task, connector);
  if (result.ok) {
    task.target.browserSessionId = result.sessionId;
    task.target.connectionStatus = "browser_ready";
    task.target.loginStatus = /#\/login(?:\?|$)/.test(String(result.url || "")) ? "reauth_required" : "credential_required";
    persistTask(task);
    broadcast();
  }
  return result;
});
app.post("/api/tasks/:taskId/browser/observe", { preHandler: requireTaskAccess }, async (request, reply) => {
  const task = getTask(request.params.taskId);
  if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
  const connector = state.connectors.find((item) => item.connectorId === task.target.connectorId);
  return observeMarket(task, connector);
});

app.get("/api/connectors", { preHandler: requireWorkspaceAccess }, async (request) => ({ connectors: snapshot(request.auth).connectors }));
app.get("/api/connectors/adapters", { preHandler: requireWorkspaceAccess }, async () => ({ adapters: listConnectorAdapters() }));
app.get("/api/credentials", { preHandler: requireWorkspaceAccess }, async (request) => ({ credentials: listCredentials(ownerOptions(request.auth)) }));

app.post("/api/connectors/discover", { preHandler: requireConnectorAccess }, async (request, reply) => {
  try {
    const body = request.body || {};
    const profile = upsertConnector(discoverConnector(body), request.auth);
    const task = body.taskId ? getTask(String(body.taskId)) : null;
    if (task) {
      applyConnectorToTask(task, profile);
      persistTask(task);
    }
    addEvent("connector_discovered", `已发现${profile.type === "website" ? "网站" : "桌面 App"}目标：${profile.name}`, { connectorId: profile.connectorId, adapterId: profile.adapterId, reviewStatus: profile.reviewStatus });
    broadcast();
    return publicConnector(profile);
  } catch (error) {
    return reply.code(400).send({ error: error.message || "CONNECTOR_DISCOVERY_FAILED" });
  }
});

app.post("/api/connectors/test", { preHandler: requireConnectorAccess }, async (request, reply) => {
  try {
    const body = request.body || {};
    const targetType = body.type === "app" ? "app" : "website";
    const task = body.taskId ? getTask(String(body.taskId)) : null;
    if (body.taskId && !task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    const hasTarget = hasConnectorTargetInput(body);
    let profile = hasTarget
      ? discoverConnector({ ...body, type: targetType })
      : body.connectorId
        ? state.connectors.find((item) => item.connectorId === String(body.connectorId))
        : task?.target?.connectorId
          ? state.connectors.find((item) => item.connectorId === String(task.target.connectorId))
          : null;
    if (!profile) return reply.code(404).send({ error: "CONNECTOR_NOT_FOUND" });
    if (task && !hasTarget && profile.connectorId !== task.target?.connectorId) return reply.code(403).send({ error: "CONNECTOR_TASK_MISMATCH" });
    if (request.auth.type === "user" && !task && profile.ownerUserId && profile.ownerUserId !== request.auth.user.id && !profile.ownerUserIds?.includes(request.auth.user.id)) return reply.code(403).send({ error: "CONNECTOR_ACCESS_DENIED" });
    const targetChanged = Boolean(task && task.target?.connectorId && task.target.connectorId !== profile.connectorId);
    const resolved = await resolveOwnedCredential({
      auth: request.auth,
      task,
      profile,
      username: body.username,
      password: body.password,
      targetChanged,
    });
    const credentialRef = resolved.credentialRef;
    const credentialOwnerUserId = resolved.credentialOwnerUserId;
    const accountLabel = resolved.accountLabel;
    const credentialOptions = ownerOptions(request.auth, task?.id);
    profile = upsertConnector(profile, request.auth);
    const adapterReady = profile.reviewStatus === "APPROVED";
    const hasCredential = resolved.hasCredential;
    let ok = false;
    let code = "CONNECTOR_NOT_VERIFIED";
    let message = "连接尚未验证";
    let loginStatus = adapterReady ? "credential_required" : "adapter_review_required";
    let connectionStatus = adapterReady ? (profile.adapterId === "haohan-readonly" ? "readonly_ready" : "disconnected") : "review_required";
    let observedUrl = "";
    let browserMode = "";
    let browserSessionId = "";
    if (adapterReady && profile.type === "website") {
      const probeTask = task
        ? {
          ...task,
          target: {
            ...task.target,
            type: profile.type,
            url: profile.type === "website" ? profile.target : "",
            installPath: profile.type === "app" ? profile.target : "",
            connectorId: profile.connectorId,
            adapterId: profile.adapterId,
            browserSessionId: targetChanged ? "" : task.target.browserSessionId,
          },
        }
        : { id: `connector_probe_${profile.connectorId}`, target: { url: profile.target, browserSessionId: `connector:${request.auth.type}:${profile.connectorId}` } };
      const opened = await openMarketBrowser(probeTask, profile);
      observedUrl = String(opened.url || "");
      browserMode = String(opened.mode || "");
      if (opened.ok) {
        const sessionId = opened.sessionId || probeTask.target.browserSessionId;
        browserSessionId = String(sessionId || "");
        const current = await browserLoginStatus({ sessionId, adapterId: profile.adapterId });
        if (current.authenticated) {
          ok = true;
          code = "LOGIN_CONFIRMED";
          message = "已确认目标页面登录态";
          connectionStatus = "connected";
          loginStatus = "authenticated";
        } else if (hasCredential) {
          const login = await browserLogin({
            sessionId,
            credentialRef,
            ownerUserId: credentialOptions.ownerUserId,
            ownerUserIds: credentialOptions.ownerUserIds,
            adapterId: profile.adapterId,
            targetUrl: profile.target,
            automationAuthorized: true,
            submit: true,
          });
          if (login.ok && login.authenticated) {
            const verified = await browserLoginStatus({ sessionId, adapterId: profile.adapterId });
            ok = verified.authenticated;
            code = ok ? "LOGIN_CONFIRMED" : "LOGIN_NOT_CONFIRMED";
            message = ok ? "已确认目标页面登录态" : "登录提交后未确认目标页面";
            connectionStatus = ok ? "connected" : "login_failed";
            loginStatus = ok ? "authenticated" : "reauth_required";
            observedUrl = String(verified.url || login.url || observedUrl);
          } else {
            code = login.code || "LOGIN_FAILED";
            message = login.message || "登录提交失败或未确认目标页面";
            connectionStatus = "login_failed";
            loginStatus = "reauth_required";
          }
        } else {
          code = "CREDENTIALS_REQUIRED";
          message = "目标页面已打开，但尚未配置登录凭据";
          connectionStatus = profile.adapterId === "haohan-readonly" ? "readonly_ready" : "browser_ready";
          loginStatus = "credential_required";
        }
      } else {
        code = opened.code || "BROWSER_NAVIGATION_FAILED";
        message = opened.message || "无法打开目标页面";
        connectionStatus = "disconnected";
        loginStatus = hasCredential ? "login_unverified" : "credential_required";
      }
    } else if (!adapterReady) {
      code = "ADAPTER_REVIEW_REQUIRED";
      message = "目标适配器尚未审核，不能验证登录或动作";
    } else {
      code = "APP_CONNECTION_REQUIRES_ADAPTER";
      message = "桌面 App 需要目标专属适配器后才能验证连接";
    }
    if (task) {
      applyConnectorToTask(task, profile);
      task.target.credentialRef = credentialRef;
      task.target.credentialOwnerUserId = credentialOwnerUserId;
      task.target.accountLabel = accountLabel;
      task.target.credentialStatus = hasCredential ? "已托管" : "未配置";
      task.target.connectionStatus = connectionStatus;
      task.target.loginStatus = loginStatus;
      if (browserSessionId) task.target.browserSessionId = browserSessionId;
      else if (targetChanged || task.target.browserSessionId === "") delete task.target.browserSessionId;
      persistTask(task);
    }
    addEvent("connector_test", `${profile.name} 连接检查：${message}`, { taskId: task?.id, userId: request.auth.type === "user" ? request.auth.user.id : undefined, connectorId: profile.connectorId, adapterId: profile.adapterId, loginStatus, connectionStatus, code });
    broadcast();
    return { ok, code, message, connectorId: profile.connectorId, type: profile.type, name: profile.name, target: profile.target, adapterId: profile.adapterId, adapterVersion: profile.adapterVersion, connectionStatus, loginStatus, credentialStatus: hasCredential ? "已托管" : "未配置", credentialRef, accountLabel, observedUrl, browserMode, liveExecution: profile.liveExecution === true, capabilities: profile.capabilities, executionModes: profile.executionModes };
  } catch (error) {
    return reply.code(400).send({ error: error.message || "CONNECTOR_TEST_FAILED" });
  }
});

app.get("/api/providers", { preHandler: requireWorkspaceAccess }, async (request) => {
  collapseDuplicateProviders();
  return { providers: publicProviderList(request.auth.user.id) };
});
app.post("/api/providers", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
  const body = request.body || {};
  const providerId = String(body.id || "");
  const existing = providerId
    ? state.providers.find((item) => item.id === providerId && String(item.ownerUserId || "") === request.auth.user.id)
    : findOwnedProviderMatch(request.auth.user.id, body);
  const template = providerId ? state.providers.find((item) => item.id === providerId) : null;
  let provider;
  try {
    const payload = existing || !template ? body : { ...body, id: "", providerKey: template.providerKey || template.id };
    provider = createProvider(payload, existing || template);
    provider.ownerUserId = request.auth.user.id;
    if (!existing && template) provider.providerKey = template.providerKey || template.id;
  } catch (error) { return reply.code(400).send({ error: error.message || "PROVIDER_INVALID" }); }
  state.providers = state.providers.filter((item) => item.id !== provider.id);
  state.providers.push(provider);
  try {
    await persistProvider(provider);
  } catch {
    if (!existing) state.providers = state.providers.filter((item) => item.id !== provider.id);
    return reply.code(503).send({ error: "PROVIDER_PERSIST_FAILED" });
  }
  addEvent("provider_saved", `已保存 Provider：${provider.name}（密钥仅服务端保存）`, { providerId: provider.id });
  broadcast();
  return reply.code(existing ? 200 : 201).send({ provider: publicProvider(provider) });
});
app.post("/api/providers/:providerId/test", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
  const provider = findProviderForUser(request.params.providerId, request.auth.user.id);
  if (!provider) return reply.code(404).send({ error: "PROVIDER_NOT_FOUND" });
  let verification;
  try {
    verification = await callProviderMethod("verifyProvider", request.auth.user.id, { provider, options: { timeoutMs: 8000 } });
  } catch (error) {
    return reply.code(400).send({ error: error.message || "PROVIDER_TEST_FAILED" });
  }
  const previousStatus = provider.status;
  provider.status = verification.status;
  try {
    await persistProvider(provider);
  } catch {
    provider.status = previousStatus;
    return reply.code(503).send({ error: "PROVIDER_PERSIST_FAILED" });
  }
  addEvent("provider_test", `Provider ${provider.name} 状态：${provider.status}`, { providerId: provider.id, code: verification.code, httpStatus: verification.httpStatus });
  broadcast();
  return { provider: publicProvider(provider), verification: { ok: verification.ok, code: verification.code, httpStatus: verification.httpStatus } };
});
app.delete("/api/providers/:providerId", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
  const provider = findProviderForUser(request.params.providerId, request.auth.user.id);
  if (!provider || !provider.ownerUserId) return reply.code(404).send({ error: "PROVIDER_NOT_FOUND" });
  state.providers = state.providers.filter((item) => item.id !== provider.id);
  try {
    await persistDeletedProvider(provider.id);
  } catch {
    state.providers.push(provider);
    return reply.code(503).send({ error: "PROVIDER_PERSIST_FAILED" });
  }
  for (const task of state.tasks) {
    if (task.providerId !== provider.id) continue;
    task.providerId = "";
    persistTask(task);
  }
  addEvent("provider_deleted", `已删除 Provider：${provider.name}`, { providerId: provider.id });
  broadcast();
  return { ok: true };
});

app.get("/api/skills", { preHandler: requireWorkspaceAccess }, async (request) => ({ skills: snapshot(request.auth).skills }));
app.post("/api/skills", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
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
    ownerUserId: request.auth.user.id,
  };
  state.skills.unshift(skill);
  persistSkill(skill);
  addEvent("skill_ingested", `已解析专家经验，等待审核：${skill.title}`, { skillId: skill.id, chunks: 0 });
  broadcast();
  return reply.code(201).send({ skill: publicSkill(skill) });
});
app.post("/api/skills/:skillId/approve", { preHandler: requireWorkspaceAccess }, async (request, reply) => {
  const skill = state.skills.find((item) => item.id === request.params.skillId);
  if (!skill) return reply.code(404).send({ error: "SKILL_NOT_FOUND" });
  if (skill.ownerUserId && String(skill.ownerUserId) !== request.auth.user.id) return reply.code(403).send({ error: "SKILL_ACCESS_DENIED" });
  if (!skill.ownerUserId && skill.status !== "APPROVED") return reply.code(403).send({ error: "SKILL_ACCESS_DENIED" });
  skill.status = "APPROVED";
  skill.version = `v${Date.now().toString().slice(-3)}`;
  skill.chunks = indexSkill(skill);
  persistSkill(skill);
  addEvent("skill_approved", `Skill 已审核发布：${skill.title}`, { skillId: skill.id, version: skill.version, chunks: skill.chunks });
  broadcast();
  return { skill: publicSkill(skill) };
});
app.get("/api/rag/search", { preHandler: requireWorkspaceAccess }, async (request) => ({ query: request.query?.q || "", results: searchKnowledge(request.query?.q || "", { ownerUserId: request.auth.user.id }, 8), stats: getRagStats() }));

app.get("/api/admin/summary", { preHandler: requireAdmin }, async () => {
  const accounts = listUsers();
  const tasks = state.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    status: task.status,
    assignedUserCount: userIdsForTask(task.id).length,
    updatedAt: task.updatedAt,
  }));
  const assignments = accounts.reduce((total, account) => total + account.assignedTaskIds.length, 0);
  const assignedTasks = tasks.filter((task) => task.assignedUserCount > 0).length;
  return {
    scope: "accounts_assignments_audit",
    users: accounts.length,
    activeUsers: accounts.filter((account) => account.status === "ACTIVE").length,
    disabledUsers: accounts.filter((account) => account.status === "DISABLED").length,
    activeTasks: tasks.filter((task) => ["MONITORING", "ANALYZING", "EXECUTING"].includes(task.status)).length,
    totalTasks: tasks.length,
    assignedTasks,
    unassignedTasks: tasks.length - assignedTasks,
    assignments,
    auditEvents: state.events.length,
    accounts,
    tasks,
    events: state.events,
    persistence: await persistence.health(),
  };
});

const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || "127.0.0.1");
for (const task of state.tasks) if (task.monitoringEnabled === true || (task.monitoringEnabled === undefined && task.status === "MONITORING")) startController(task.id, { userId: userIdsForTask(task.id)[0] || "" });
try {
  await app.listen({ port, host });
  console.log(`Axiom API listening on http://${host}:${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

async function shutdown() {
  stopAllControllers();
  await closeAllBrowserSessions();
  await persistence.close();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
