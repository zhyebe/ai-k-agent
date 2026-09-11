import crypto from "node:crypto";
import { indexSkill } from "./rag.mjs";
import { publicProvider as formatPublicProvider, providerIdentityKey } from "./provider.mjs";

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
  const { ownerUserId, ...safeTask } = task;
  const target = task.target ? { ...task.target, credentialRef: "" } : task.target;
  if (target) {
    delete target.credentialOwnerUserId;
    delete target.browserSessionId;
  }
  return {
    ...safeTask,
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
  return { ...safeSkill, owned: Boolean(ownerUserId) };
}

export function publicProvider(provider) {
  if (!provider) return provider;
  return formatPublicProvider(provider);
}

export function publicProviderList(userId = "") {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return [];
  return state.providers
    .filter((provider) => String(provider.ownerUserId || "") === normalizedUserId)
    .map(publicProvider);
}

export function findProviderForUser(providerId = "", userId = "") {
  const requestedId = String(providerId || "");
  const normalizedUserId = String(userId || "");
  if (!requestedId) {
    return state.providers.find((provider) =>
      String(provider.ownerUserId || "") === normalizedUserId && providerIsReady(provider),
    ) || null;
  }
  const owned = state.providers.find((provider) =>
    String(provider.ownerUserId || "") === normalizedUserId
    && (String(provider.id) === requestedId || String(provider.providerKey || "") === requestedId),
  );
  if (owned) return owned;
  if (normalizedUserId) return null;
  return state.providers.find((provider) => !provider.ownerUserId && String(provider.id) === requestedId) || null;
}

function providerIsReady(provider) {
  return Boolean(provider?.encryptedKey && provider?.baseUrl);
}

export function resolveDefaultProviderId(userId = "", preferredId = "") {
  const preferred = String(preferredId || "").trim();
  const normalizedUserId = String(userId || "");
  if (preferred) {
    const found = findProviderForUser(preferred, userId);
    if (found) return found.id;
  }
  const owned = state.providers.find((provider) => providerIsReady(provider) && String(provider.ownerUserId || "") === normalizedUserId);
  if (owned) return owned.id;
  return preferred;
}

export const state = {
  tasks: [],
  skills: [],
  providers: [],
  events: [],
  runs: [],
  analyses: [],
  agentRuns: [],
  agentOutput: [],
  connectors: [],
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
  return safeTask;
}

export function hydrateState(snapshot) {
  if (!snapshot) return;
  if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks.map(sanitizeHydratedTask);
  if (Array.isArray(snapshot.skills)) state.skills = snapshot.skills;
  if (Array.isArray(snapshot.providers)) state.providers = snapshot.providers;
  if (Array.isArray(snapshot.connectors)) state.connectors = snapshot.connectors;
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

export function persistDeletedTask(payload) {
  return persistValue("deleteTaskData", payload);
}

export function persistSkill(skill) {
  return persistValue("saveSkill", skill);
}

export function persistDeletedSkill(skillId) {
  return persistValue("deleteSkill", skillId);
}

export function persistProvider(provider) {
  return persistValue("saveProvider", provider);
}

export function persistDeletedProvider(providerId) {
  return persistValue("deleteProvider", providerId);
}

export function findOwnedProviderMatch(userId, payload) {
  const needle = providerIdentityKey({ ...payload, ownerUserId: userId });
  return state.providers.find((item) => String(item.ownerUserId || "") === String(userId || "") && providerIdentityKey(item) === needle) || null;
}

export function collapseDuplicateProviders() {
  const referenced = new Set(state.tasks.map((task) => String(task.providerId || "")).filter(Boolean));
  const keptByKey = new Map();
  const removed = [];
  for (const provider of state.providers) {
    if (!provider.ownerUserId) continue;
    const key = providerIdentityKey(provider);
    const current = keptByKey.get(key);
    if (!current) {
      keptByKey.set(key, provider);
      continue;
    }
    const keepCurrent = referenced.has(String(current.id)) || (!referenced.has(String(provider.id)) && String(current.id) <= String(provider.id));
    if (keepCurrent) removed.push(provider);
    else {
      removed.push(current);
      keptByKey.set(key, provider);
    }
  }
  if (!removed.length) return 0;
  const removeIds = new Set(removed.map((item) => item.id));
  const replacement = new Map();
  for (const provider of removed) {
    const kept = keptByKey.get(providerIdentityKey(provider));
    if (kept) replacement.set(provider.id, kept.id);
  }
  state.providers = state.providers.filter((item) => !removeIds.has(item.id));
  for (const task of state.tasks) {
    if (!removeIds.has(task.providerId)) continue;
    task.providerId = replacement.get(task.providerId) || "";
    persistTask(task);
  }
  for (const id of removeIds) persistDeletedProvider(id);
  return removed.length;
}

export function persistConnector(connector) {
  return persistValue("saveConnector", connector);
}

export function persistDeletedConnector(connectorId) {
  return persistValue("deleteConnector", connectorId);
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
  const normalizedUserId = String(userId || "");
  const requestedTaskIds = normalizedTaskIds(taskIds);
  const tasks = normalizedUserId
    ? state.tasks.filter((task) => String(task.ownerUserId || "") === normalizedUserId)
    : requestedTaskIds
      ? state.tasks.filter((task) => requestedTaskIds.has(String(task.id)))
      : state.tasks;
  const visibleTaskIds = normalizedUserId || requestedTaskIds
    ? new Set(tasks.map((task) => String(task.id)))
    : null;
  const visibleEvents = visibleTaskIds && normalizedUserId
    ? state.events.filter((event) => {
      const eventTaskId = String(event.metadata?.taskId || "");
      const eventUserId = String(event.metadata?.userId || "");
      return (eventTaskId && visibleTaskIds.has(eventTaskId)) || (eventUserId && eventUserId === normalizedUserId);
    })
    : visibleTaskIds
      ? state.events.filter((event) => visibleTaskIds.has(String(event.metadata?.taskId || "")))
      : state.events;
  const visibleSkills = normalizedUserId
    ? state.skills.filter((skill) => String(skill.ownerUserId || "") === normalizedUserId)
    : state.skills;
  const visibleConnectors = normalizedUserId
    ? state.connectors.filter((connector) => String(connector.ownerUserId || "") === normalizedUserId)
    : state.connectors;
  return {
    tasks: tasks.map(publicTask),
    skills: visibleSkills.map(publicSkill),
    providers: normalizedUserId ? publicProviderList(normalizedUserId) : state.providers.map(publicProvider),
    events: includeEvents ? visibleEvents : [],
    runs: visibleTaskIds ? state.runs.filter((run) => visibleTaskIds.has(String(run.taskId || ""))) : state.runs,
    connectors: visibleConnectors.map(publicConnector),
    orders: visibleTaskIds ? state.orders.filter((order) => visibleTaskIds.has(String(order.taskId || ""))) : state.orders,
    analyses: visibleTaskIds ? state.analyses.filter((item) => visibleTaskIds.has(item.taskId)) : state.analyses,
    agentRuns: visibleTaskIds ? state.agentRuns.filter((run) => visibleTaskIds.has(run.taskId)) : state.agentRuns,
    agentOutput: visibleTaskIds ? state.agentOutput.filter((line) => visibleTaskIds.has(line.taskId)) : state.agentOutput,
  };
}
