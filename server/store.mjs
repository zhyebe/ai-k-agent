import crypto from "node:crypto";
import { indexSkill } from "./rag.mjs";
import { publicProvider as formatPublicProvider } from "./provider.mjs";

const isoNow = () => new Date().toISOString();
const maxAgentRuns = 100;
const maxAgentOutputLines = 1200;
const stateSubscribers = new Set();

function notifyState(message) {
  for (const subscriber of stateSubscribers) {
    try { subscriber(message); } catch {}
  }
}

function safeOutputValue(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/(password|passwd|token|secret|api[_-]?key|session(?:str)?|authorization)\s*[=:：]\s*[^\s,;]+/gi, "$1=[redacted]")
      .slice(0, 1200);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeOutputValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => {
      if (/password|passwd|token|secret|api[_-]?key|cookie|authorization/i.test(key)) return [key, "[redacted]"];
      return [key, safeOutputValue(item, depth + 1)];
    }));
  }
  return String(value).slice(0, 1200);
}

function normalizedTaskIds(taskIds) {
  return Array.isArray(taskIds) ? new Set(taskIds.map((value) => String(value))) : null;
}

export function publicTask(task) {
  if (!task) return task;
  const target = task.target ? { ...task.target, credentialRef: "" } : task.target;
  if (target) {
    delete target.credentialOwnerUserId;
    delete target.browserSessionId;
  }
  return {
    ...task,
    automationAuthorized: false,
    autoDecisionEnabled: task.autoDecisionEnabled === true,
    autoDecisionCountdownSec: Number(task.autoDecisionCountdownSec || 30),
    providerId: String(task.providerId || ""),
    pendingAction: task.pendingAction || null,
    target,
  };
}

export function publicConnector(connector) {
  if (!connector) return connector;
  const { ownerUserId, ownerUserIds, ...safeConnector } = connector;
  return safeConnector;
}

export function publicSkill(skill) {
  if (!skill) return skill;
  const { ownerUserId, ...safeSkill } = skill;
  return safeSkill;
}

export function publicProvider(provider) {
  if (!provider) return provider;
  return formatPublicProvider(provider);
}

export function publicProviderList(userId = "") {
  const normalizedUserId = String(userId || "");
  return state.providers
    .filter((provider) => !provider.ownerUserId || String(provider.ownerUserId) === normalizedUserId)
    .map(publicProvider);
}

export function findProviderForUser(providerId = "", userId = "") {
  const requestedId = String(providerId || "");
  const normalizedUserId = String(userId || "");
  const exact = requestedId ? state.providers.find((provider) => String(provider.id) === requestedId) : null;
  if (exact?.ownerUserId && String(exact.ownerUserId) !== normalizedUserId) return null;
  const owned = requestedId ? state.providers.find((provider) =>
    String(provider.ownerUserId || "") === normalizedUserId
    && (String(provider.id) === requestedId || String(provider.providerKey || "") === requestedId),
  ) : null;
  if (owned) return owned;
  if (requestedId) {
    return state.providers.find((provider) => !provider.ownerUserId && String(provider.id) === requestedId)
      || null;
  }
  return null;
}

function providerIsReady(provider) {
  return Boolean(provider?.encryptedKey && provider?.baseUrl);
}

export function resolveDefaultProviderId(userId = "", preferredId = "") {
  const preferred = String(preferredId || "").trim();
  if (preferred) {
    const found = findProviderForUser(preferred, userId);
    if (found) return found.id;
  }
  const normalizedUserId = String(userId || "");
  const candidates = state.providers.filter((provider) => {
    if (!providerIsReady(provider)) return false;
    const owner = String(provider.ownerUserId || "");
    return !owner || owner === normalizedUserId;
  });
  const owned = candidates.find((provider) => String(provider.ownerUserId || "") === normalizedUserId && provider.id !== "provider_deepseek")
    || candidates.find((provider) => String(provider.ownerUserId || "") === normalizedUserId);
  if (owned) return owned.id;
  const shared = candidates.find((provider) => !provider.ownerUserId && provider.id !== "provider_deepseek")
    || candidates.find((provider) => !provider.ownerUserId);
  if (shared) return shared.id;
  return preferred || "provider_deepseek";
}

export const state = {
  tasks: [
    {
      id: "task_demo_001",
      name: "浩瀚数贸观察",
      status: "READY",
      mode: "PAPER",
      symbol: "DGJJ",
      timeframe: "15m",
      target: {
        type: "website",
        name: "浩瀚数贸",
        url: "https://smyw.haohandahan.cn/client/#/transcc",
        installPath: "",
        connectorId: "connector_haohan_readonly",
        adapterId: "haohan-readonly",
        credentialRef: "",
        accountLabel: "未配置",
        credentialStatus: "未配置",
        connectionStatus: "disconnected",
        adapterStatus: "浩瀚数贸（网页） v1.0.0",
        discoveryStatus: "已发现",
      },
      riskProfile: "Balanced",
      workflow: [
        { key: "connect", label: "连接目标", status: "pending", detail: "等待连接" },
        { key: "login", label: "登录验证", status: "pending", detail: "等待凭据" },
        { key: "collect", label: "数据采集", status: "pending", detail: "等待只读行情" },
        { key: "analyze", label: "趋势分析", status: "pending", detail: "等待触发" },
        { key: "rules", label: "规则裁决", status: "pending", detail: "等待当前轮次" },
        { key: "action", label: "执行动作", status: "pending", detail: "建议需弹窗确认后才会下单" },
      ],
      rules: [
        { id: "rule_01", order: 1, name: "数据新鲜度 < 5 秒", mode: "AUTO", status: "standby", detail: "等待实时数据" },
        { id: "rule_02", order: 2, name: "单品种仓位 ≤ 30%", mode: "AUTO", status: "standby", detail: "等待账户对账" },
        { id: "rule_03", order: 3, name: "突破后需人工复核", mode: "REVIEW", status: "standby", detail: "未触发" },
        { id: "rule_04", order: 4, name: "异常波动立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
      ],
      decision: {
        action: "HOLD",
        confidence: 0,
        targetPositionPct: 0,
        maxOrderValuePct: 0,
        reasonCodes: [],
        evidenceIds: [],
        invalidation: "完成一次真实分析后更新",
        riskFlags: ["NOT_ANALYZED"],
        createdAt: isoNow(),
        ttlSec: 300,
      },
      metrics: { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
      nextTrigger: "等待启动",
      updatedAt: isoNow(),
      stopLocked: false,
      automationAuthorized: false,
      autoDecisionEnabled: false,
      autoDecisionCountdownSec: 30,
      providerId: "",
      pendingAction: null,
      activeRunId: null,
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
    },
  ],
  skills: [
    {
      id: "skill_trend_1",
      ownerUserId: "",
      title: "趋势突破与回撤红线",
      kind: "expert",
      source: "专家复盘 · 交易组 A",
      status: "APPROVED",
      version: "v1.3",
      tags: ["BTC/USDT", "15m", "趋势", "红线"],
      chunks: 4,
      updatedAt: "2026-09-06T08:20:00Z",
      summary: "突破须有成交量确认；跌破 EMA20 时禁止追单。",
      content: "适用于 BTC/USDT 15m 趋势行情。突破前高且成交量高于 20 根均值 1.4 倍时，可考虑小仓位买入。跌破 EMA20、数据延迟超过 5 秒或连续两次信号冲突时禁止追单并保持 HOLD。任何异常波动需要人工复核。",
    },
    {
      id: "skill_guardrail_2",
      ownerUserId: "",
      title: "模拟盘账户红线",
      kind: "guardrail",
      source: "风险委员会",
      status: "REVIEW",
      version: "draft-2",
      tags: ["风控", "模拟盘", "人工复核"],
      chunks: 0,
      updatedAt: "2026-09-07T06:10:00Z",
      summary: "单笔金额、日亏损和异常波动需明确处理路径。",
      content: "单笔订单金额不得超过账户权益 8%，单日亏损达到 3% 时停止自动交易并通知人工。",
    },
  ],
  providers: [
    { id: "provider_deepseek", providerKey: "provider_deepseek", ownerUserId: "", name: "DeepSeek", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1", encryptedKey: "", keyPreview: "", status: "未配置" },
    { id: "provider_custom", providerKey: "provider_custom", ownerUserId: "", name: "自定义 OpenAI Compatible", model: "未设置", baseUrl: "", encryptedKey: "", keyPreview: "", status: "未配置" },
  ],
  events: [],
  runs: [],
  analyses: [],
  agentRuns: [],
  agentOutput: [],
  connectors: [
    {
      connectorId: "connector_demo_northstar",
      type: "website",
      target: "https://demo.exchange.local",
      name: "Northstar Exchange",
      adapterId: "northstar-web",
      adapterVersion: "1.0.0",
      status: "DISCOVERED",
      discoveryStatus: "已发现",
      adapterStatus: "Northstar Exchange v1.0.0",
      reviewStatus: "APPROVED",
      capabilities: ["navigate", "login", "read_history", "observe_orders", "paper_trade"],
      actionMapping: "模拟动作已映射",
      executionModes: ["PAPER", "SHADOW"],
      liveExecution: false,
      pathStatus: "unknown",
      discoveredAt: isoNow(),
    },
    {
      connectorId: "connector_haohan_readonly",
      type: "website",
      target: "https://smyw.haohandahan.cn/client/#/transcc",
      name: "浩瀚数贸",
      adapterId: "haohan-readonly",
      adapterVersion: "1.0.0",
      status: "DISCOVERED",
      discoveryStatus: "已发现",
      adapterStatus: "浩瀚数贸（网页） v1.0.0",
      reviewStatus: "APPROVED",
      capabilities: ["navigate", "login", "observe_visible_page", "read_visible_history", "read_visible_market", "read_visible_account", "submit_confirmed_trade"],
      actionMapping: "确认后提交已登录会话订单",
      executionModes: ["PAPER", "SHADOW", "LIVE"],
      liveExecution: true,
      pathStatus: "unknown",
      discoveredAt: isoNow(),
    },
  ],
  orders: [],
};

for (const skill of state.skills) if (skill.status === "APPROVED") skill.chunks = indexSkill(skill);

let persistence = null;

function persistValue(method, value) {
  if (!persistence?.[method]) return Promise.resolve();
  const operation = Promise.resolve().then(() => persistence[method](value));
  operation.catch((error) => {
    notifyState({ type: "persistence.error", payload: { method, message: String(error?.message || error).slice(0, 240) } });
  });
  return operation;
}

export function setPersistence(adapter) {
  persistence = adapter;
}

export function subscribeState(listener) {
  if (typeof listener !== "function") return () => {};
  stateSubscribers.add(listener);
  return () => stateSubscribers.delete(listener);
}

function sanitizeHydratedTask(task) {
  if (!task) return task;
  const safeTask = {
    ...task,
    automationAuthorized: false,
    autoDecisionEnabled: task.autoDecisionEnabled === true,
    autoDecisionCountdownSec: Number(task.autoDecisionCountdownSec || 30),
    providerId: String(task.providerId || ""),
    pendingAction: task.pendingAction || null,
    monitoringEnabled: task.monitoringEnabled === undefined ? task.status === "MONITORING" : Boolean(task.monitoringEnabled),
    monitorGeneration: Number(task.monitorGeneration || 0),
    monitoringRound: Number(task.monitoringRound || 0),
    monitorFailureCount: Number(task.monitorFailureCount || 0),
    lastObservedFingerprint: String(task.lastObservedFingerprint || ""),
    lastAnalyzedFingerprint: String(task.lastAnalyzedFingerprint || ""),
    lastAnalysisSucceeded: task.lastAnalysisSucceeded === undefined ? false : Boolean(task.lastAnalysisSucceeded),
    target: task.target ? { ...task.target } : task.target,
  };
  if (safeTask.id !== "task_demo_001") return safeTask;
  const flags = safeTask.decision?.riskFlags || [];
  if (safeTask.decision?.action !== "BUY" || flags.length) return safeTask;
  return {
    ...safeTask,
    name: "浩瀚数贸观察",
    status: "READY",
    symbol: task.symbol === "BTC/USDT" ? "DGJJ" : task.symbol,
    stopLocked: false,
    automationAuthorized: false,
    autoDecisionEnabled: false,
    autoDecisionCountdownSec: 30,
    pendingAction: null,
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
    nextTrigger: "等待启动",
    target: {
      ...task.target,
      type: "website",
      name: "浩瀚数贸",
      url: "https://smyw.haohandahan.cn/client/#/transcc",
      connectorId: "connector_haohan_readonly",
      adapterId: "haohan-readonly",
      credentialRef: "",
      accountLabel: "未配置",
      credentialStatus: "未配置",
      connectionStatus: "disconnected",
    },
    decision: {
      action: "HOLD",
      confidence: 0,
      targetPositionPct: 0,
      maxOrderValuePct: 0,
      reasonCodes: [],
      evidenceIds: [],
      invalidation: "完成一次真实分析后更新",
      riskFlags: ["NOT_ANALYZED"],
      createdAt: isoNow(),
      ttlSec: 300,
    },
    metrics: { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
  };
}

export function hydrateState(snapshot) {
  if (!snapshot) return;
  if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks.length ? snapshot.tasks.map(sanitizeHydratedTask) : state.tasks;
  if (Array.isArray(snapshot.skills)) state.skills = snapshot.skills.length ? snapshot.skills : state.skills;
  if (Array.isArray(snapshot.providers)) state.providers = snapshot.providers.length ? snapshot.providers : state.providers;
  if (Array.isArray(snapshot.connectors)) state.connectors = snapshot.connectors.length ? snapshot.connectors : state.connectors;
  if (!state.connectors.some((item) => item.adapterId === "haohan-readonly")) {
    const seeded = state.connectors;
    state.connectors = [
      {
        connectorId: "connector_haohan_readonly",
        type: "website",
        target: "https://smyw.haohandahan.cn/client/#/transcc",
        name: "浩瀚数贸",
        adapterId: "haohan-readonly",
        adapterVersion: "1.0.0",
        status: "DISCOVERED",
        discoveryStatus: "已发现",
        adapterStatus: "浩瀚数贸（网页） v1.0.0",
        reviewStatus: "APPROVED",
        capabilities: ["navigate", "login", "observe_visible_page", "read_visible_history", "read_visible_market", "read_visible_account", "submit_confirmed_trade"],
        actionMapping: "确认后提交已登录会话订单",
        executionModes: ["PAPER", "SHADOW", "LIVE"],
        liveExecution: true,
        pathStatus: "unknown",
        discoveredAt: isoNow(),
      },
      ...seeded,
    ];
  }
  if (Array.isArray(snapshot.orders)) state.orders = snapshot.orders;
  if (Array.isArray(snapshot.events)) state.events = snapshot.events;
  if (Array.isArray(snapshot.runs) && snapshot.runs.length) state.runs = snapshot.runs;
  if (Array.isArray(snapshot.analyses)) state.analyses = snapshot.analyses;
  if (Array.isArray(snapshot.agentRuns)) state.agentRuns = snapshot.agentRuns;
  if (Array.isArray(snapshot.agentOutput)) state.agentOutput = snapshot.agentOutput;
  for (const skill of state.skills) if (skill.status === "APPROVED") skill.chunks = indexSkill(skill);
}

export function getTask(taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

export function getConnector(connectorId) {
  return state.connectors.find((connector) => connector.connectorId === connectorId);
}

export function persistTask(task) {
  return persistValue("saveTask", task);
}

export function persistSkill(skill) {
  return persistValue("saveSkill", skill);
}

export function persistProvider(provider) {
  return persistValue("saveProvider", provider);
}

export function persistConnector(connector) {
  return persistValue("saveConnector", connector);
}

export function persistOrder(order) {
  return persistValue("saveOrder", order);
}

export function persistAnalysis(analysis) {
  return persistValue("saveAnalysis", analysis);
}

export function persistAgentRun(run) {
  return persistValue("saveAgentRun", run);
}

export function persistAgentOutput(line) {
  return persistValue("saveAgentOutput", line);
}

export function startAgentRun(taskId, { trigger = "manual" } = {}) {
  const run = {
    id: `agent_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    taskId: String(taskId),
    status: "running",
    trigger: String(trigger || "manual"),
    startedAt: isoNow(),
    completedAt: null,
    currentStage: "connect",
    lineCount: 0,
    finalAction: null,
    route: null,
  };
  state.agentRuns.unshift(run);
  if (state.agentRuns.length > maxAgentRuns) state.agentRuns.length = maxAgentRuns;
  const task = getTask(taskId);
  if (task) task.activeRunId = run.id;
  persistAgentRun(run);
  appendAgentOutput({ taskId, runId: run.id, stage: "connect", kind: "run", message: "开始本轮工作流：连接目标并准备只读分析" });
  return run;
}

export function appendAgentOutput({ taskId, runId, stage = "system", kind = "text", level = "info", message, data = null } = {}) {
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) return null;
  const run = state.agentRuns.find((item) => item.id === runId && item.taskId === String(taskId));
  if (run) {
    run.currentStage = String(stage || "system");
    run.lineCount += 1;
  }
  const line = {
    id: `agent_line_${Date.now()}_${crypto.randomUUID().slice(0, 7)}`,
    taskId: String(taskId),
    runId: String(runId || ""),
    sequence: run?.lineCount || 1,
    stage: String(stage || "system"),
    kind: String(kind || "text"),
    level: String(level || "info"),
    message: normalizedMessage.slice(0, 2000),
    data: data === null ? null : safeOutputValue(data),
    createdAt: isoNow(),
  };
  state.agentOutput.unshift(line);
  if (state.agentOutput.length > maxAgentOutputLines) state.agentOutput.length = maxAgentOutputLines;
  persistAgentOutput(line);
  if (run) persistAgentRun(run);
  notifyState({ type: "agent.output", payload: line });
  return line;
}

export function finishAgentRun(runId, { status = "completed", action = null, route = null, code = null } = {}) {
  const run = state.agentRuns.find((item) => item.id === runId);
  if (!run) return null;
  run.status = String(status);
  run.completedAt = isoNow();
  run.finalAction = action ? String(action) : null;
  run.route = route ? String(route) : null;
  if (code) run.code = String(code);
  persistAgentRun(run);
  notifyState({ type: "agent.run.completed", payload: run });
  return run;
}

export function getAgentRun(runId) {
  return state.agentRuns.find((run) => run.id === String(runId || "")) || null;
}

export function getAgentRuns(taskId) {
  return state.agentRuns.filter((run) => run.taskId === String(taskId)).slice(0, 50);
}

export function getAgentOutput(taskId, runId = "", limit = 500) {
  const normalizedTaskId = String(taskId);
  const normalizedRunId = String(runId || "");
  return state.agentOutput
    .filter((line) => line.taskId === normalizedTaskId && (!normalizedRunId || line.runId === normalizedRunId))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.sequence - right.sequence)
    .slice(-Math.min(1200, Math.max(1, Number(limit) || 500)));
}

export function addEvent(type, message, metadata = {}) {
  const event = { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, message, metadata: safeOutputValue(metadata), createdAt: isoNow() };
  state.events.unshift(event);
  if (state.events.length > 80) state.events.length = 80;
  if (persistence) persistence.recordAudit(event).catch(() => {});
  notifyState({ type: "workspace.event", payload: event });
  return event;
}

export function publicState({ taskIds = null, userId = null, includeEvents = false } = {}) {
  const visibleTaskIds = normalizedTaskIds(taskIds);
  const tasks = visibleTaskIds ? state.tasks.filter((task) => visibleTaskIds.has(String(task.id))) : state.tasks;
  const visibleConnectorIds = visibleTaskIds ? new Set(tasks.map((task) => String(task.target?.connectorId || "")).filter(Boolean)) : null;
  const visibleEvents = visibleTaskIds && userId
    ? state.events.filter((event) => {
      const eventTaskId = String(event.metadata?.taskId || "");
      const eventUserId = String(event.metadata?.userId || "");
      return (eventTaskId && visibleTaskIds.has(eventTaskId)) || (eventUserId && eventUserId === String(userId));
    })
    : visibleTaskIds
      ? state.events.filter((event) => visibleTaskIds.has(String(event.metadata?.taskId || "")))
      : state.events;
  const visibleSkills = visibleTaskIds && userId
    ? state.skills.filter((skill) => (skill.status === "APPROVED" && !skill.ownerUserId) || String(skill.ownerUserId || "") === String(userId))
    : state.skills;
  const visibleConnectors = visibleConnectorIds
    ? state.connectors.filter((connector) => visibleConnectorIds.has(String(connector.connectorId)) || (userId && (String(connector.ownerUserId || "") === String(userId) || connector.ownerUserIds?.includes(String(userId)))))
    : state.connectors;
  return {
    tasks: tasks.map(publicTask),
    skills: visibleSkills.map(publicSkill),
    providers: visibleTaskIds && userId ? publicProviderList(userId) : state.providers.map(publicProvider),
    events: includeEvents ? visibleEvents : [],
    runs: visibleTaskIds ? state.runs.filter((run) => visibleTaskIds.has(String(run.taskId || ""))) : state.runs,
    connectors: visibleConnectors.map(publicConnector),
    orders: visibleTaskIds ? state.orders.filter((order) => visibleTaskIds.has(String(order.taskId || ""))) : state.orders,
    analyses: visibleTaskIds ? state.analyses.filter((item) => visibleTaskIds.has(item.taskId)) : state.analyses,
    agentRuns: visibleTaskIds ? state.agentRuns.filter((run) => visibleTaskIds.has(run.taskId)) : state.agentRuns,
    agentOutput: visibleTaskIds ? state.agentOutput.filter((line) => visibleTaskIds.has(line.taskId)) : state.agentOutput,
  };
}
