import { requestDecision, requestSegmentReview } from "./provider.mjs";
import { buildLayeredAnalysisMarket, buildMarketAnalysisSegments, compactSegmentReview, describeAnalysisLayers, estimateMarketContextBytes, shouldUseSegmentedAnalysis, summarizeMarketForDecision } from "./analysis-context.mjs";
import { searchKnowledge } from "./rag.mjs";
import { DEFAULT_AUTO_DECISION_COUNTDOWN_SEC, executeDecision, executionLimits, isLiveTask, shouldSubmitLiveOrder, suggestOrderPreview } from "./execution.mjs";
import { observeMarket, openMarketBrowser } from "./market.mjs";
import { browserLogin, browserLoginStatus, fillSuggestionForm, submitSuggestionForm } from "./tools.mjs";
import { credentialExists } from "./vault.mjs";
import { addEvent, appendAgentOutput, findProviderForUser, finishAgentRun, getConnector, getTask, persistAnalysis, persistOrder, persistTask, resolveDefaultProviderId, startAgentRun, state } from "./store.mjs";
import { userIdsForTask } from "./users.mjs";
import { accountMetricsFromMarket, HAO_HAN_TARGET_URL } from "./haohan.mjs";

const activeCycles = new Set();
const cycleWaiters = new Map();
const controllerLoops = new Map();
const pendingActionTimers = new Map();
const pendingConfirmLocks = new Set();
const DEFAULT_MONITOR_POLL_MS = 5000;
const MAX_MONITOR_POLL_MS = 120000;

class CycleAbortError extends Error {
  constructor(code) {
    super(code);
    this.name = "CycleAbortError";
    this.code = code;
  }
}

function taskGeneration(task) {
  const value = Number(task?.monitorGeneration || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function advanceTaskGeneration(task) {
  task.monitorGeneration = taskGeneration(task) + 1;
  return task.monitorGeneration;
}

function assertCycleCurrent(task, generation) {
  if (task?.stopLocked) throw new CycleAbortError("STOP_LOCKED");
  if (taskGeneration(task) !== generation) throw new CycleAbortError("CYCLE_INVALIDATED");
}

function resolveRuntime(overrides = {}) {
  const use = (name, fallback) => typeof overrides?.[name] === "function" ? overrides[name] : fallback;
  return {
    openMarketBrowser: use("openMarketBrowser", openMarketBrowser),
    browserLoginStatus: use("browserLoginStatus", browserLoginStatus),
    browserLogin: use("browserLogin", browserLogin),
    observeMarket: use("observeMarket", observeMarket),
    requestDecision: use("requestDecision", requestDecision),
    requestSegmentReview: use("requestSegmentReview", requestSegmentReview),
    executeDecision: use("executeDecision", executeDecision),
    fillSuggestionForm: use("fillSuggestionForm", fillSuggestionForm),
    submitSuggestionForm: use("submitSuggestionForm", submitSuggestionForm),
  };
}

function pendingWaitMessage(task, { auto = false, countdownSec = 0 } = {}) {
  if (isLiveTask(task)) return "请在弹窗中确认后才会下单";
  if (auto) return `${countdownSec} 秒内可人工接管；超时后自动确认建议，观察模式不会下单`;
  return "请在弹窗中确认建议；观察模式不会下单";
}

export function buildPendingAction(task, decision, { now = Date.now() } = {}) {
  const preview = suggestOrderPreview(task, decision);
  const countdownSec = Math.max(5, Math.min(300, Number(task.autoDecisionCountdownSec || DEFAULT_AUTO_DECISION_COUNTDOWN_SEC)));
  const auto = !isLiveTask(task) && task.autoDecisionEnabled === true;
  const action = decision.action === "SELL" ? "SELL" : "BUY";
  return {
    id: `pending_${now}_${Math.random().toString(36).slice(2, 8)}`,
    action,
    status: "WAITING",
    source: null,
    suggestedQty: preview.suggestedQty,
    suggestedPrice: preview.suggestedPrice,
    formFilled: false,
    formSubmitBlocked: true,
    createdAt: new Date(now).toISOString(),
    deadlineAt: auto ? new Date(now + countdownSec * 1000).toISOString() : null,
    countdownSec: auto ? countdownSec : 0,
    resolvedAt: null,
    message: pendingWaitMessage(task, { auto, countdownSec }),
  };
}

function clearPendingActionTimer(taskId) {
  const timer = pendingActionTimers.get(taskId);
  if (timer) clearTimeout(timer);
  pendingActionTimers.delete(taskId);
}

function schedulePendingActionTimeout(task) {
  clearPendingActionTimer(task.id);
  if (isLiveTask(task)) return;
  if (task.autoDecisionEnabled !== true || task.pendingAction?.status !== "WAITING" || !task.pendingAction.deadlineAt) return;
  const delay = Math.max(0, new Date(task.pendingAction.deadlineAt).getTime() - Date.now());
  pendingActionTimers.set(task.id, setTimeout(() => {
    pendingActionTimers.delete(task.id);
    try {
      confirmPendingAction(task.id, { source: "auto_timeout" });
    } catch {}
  }, delay));
}

function clearPendingAction(task, { persist = true } = {}) {
  if (!task) return;
  clearPendingActionTimer(task.id);
  if (task.pendingAction?.status === "WAITING") {
    task.pendingAction = {
      ...task.pendingAction,
      status: "CANCELLED",
      resolvedAt: new Date().toISOString(),
      message: "待确认建议已取消",
    };
  }
  if (persist) persistTask(task);
}

async function openPendingAction(task, { runtime, run } = {}) {
  if (!task || (task.decision?.action !== "BUY" && task.decision?.action !== "SELL")) {
    if (task) clearPendingAction(task);
    return null;
  }
  clearPendingActionTimer(task.id);
  task.pendingAction = buildPendingAction(task, task.decision);
  const sessionId = task.target?.browserSessionId || `task:${task.id}`;
  try {
    const filled = await runtime.fillSuggestionForm({
      sessionId,
      action: task.pendingAction.action,
      price: task.pendingAction.suggestedPrice,
      quantity: task.pendingAction.suggestedQty,
    });
    task.pendingAction.formFilled = filled?.filled === true && filled?.submitted !== true;
    if (filled?.submitted === true) task.pendingAction.formFilled = false;
    task.pendingAction.message = task.pendingAction.formFilled
      ? `${task.pendingAction.message}；目标页已填入建议价格/数量`
      : `${task.pendingAction.message}；目标页未找到可填字段，建议仍待确认`;
    if (run) {
      appendAgentOutput({
        taskId: task.id,
        runId: run.id,
        stage: "action",
        message: task.pendingAction.formFilled
          ? `已在目标页填写${task.pendingAction.action === "BUY" ? "买" : "卖"}价/量，等待弹窗确认后才会提交`
          : "建议待确认；目标页未填写表单，尚未提交",
        data: { pendingActionId: task.pendingAction.id, filled: task.pendingAction.formFilled, submitted: false },
      });
    }
  } catch (error) {
    task.pendingAction.formFilled = false;
    task.pendingAction.message = `${task.pendingAction.message}；填表失败：${error.message}`;
  }
  schedulePendingActionTimeout(task);
  persistTask(task);
  return task.pendingAction;
}

export function setAutoDecision(taskId, { enabled, countdownSec } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  task.autoDecisionEnabled = enabled === true;
  if (countdownSec !== undefined) {
    const next = Number(countdownSec);
    if (!Number.isFinite(next)) throw new Error("COUNTDOWN_INVALID");
    task.autoDecisionCountdownSec = Math.max(5, Math.min(300, Math.round(next)));
  } else if (!Number.isFinite(Number(task.autoDecisionCountdownSec))) {
    task.autoDecisionCountdownSec = DEFAULT_AUTO_DECISION_COUNTDOWN_SEC;
  }
  if (task.pendingAction?.status === "WAITING") {
    if (task.autoDecisionEnabled && !isLiveTask(task)) {
      const waitSec = task.autoDecisionCountdownSec || DEFAULT_AUTO_DECISION_COUNTDOWN_SEC;
      task.pendingAction.countdownSec = waitSec;
      task.pendingAction.deadlineAt = new Date(Date.now() + waitSec * 1000).toISOString();
      task.pendingAction.message = pendingWaitMessage(task, { auto: true, countdownSec: waitSec });
      schedulePendingActionTimeout(task);
    } else {
      task.pendingAction.countdownSec = 0;
      task.pendingAction.deadlineAt = null;
      task.pendingAction.message = isLiveTask(task) ? "实盘必须弹窗确认后才会下单" : "自动决策已关闭，等待弹窗确认或人工接管";
      clearPendingActionTimer(task.id);
    }
  }
  task.updatedAt = new Date().toISOString();
  addEvent("auto_decision_updated", isLiveTask(task)
    ? "实盘必须弹窗确认，不会自动下单"
    : task.autoDecisionEnabled ? `已打开自动决策，倒计时 ${task.autoDecisionCountdownSec} 秒` : "已关闭自动决策，建议需弹窗确认", { taskId, enabled: task.autoDecisionEnabled, countdownSec: task.autoDecisionCountdownSec });
  persistTask(task);
  return task;
}

export function setTaskProvider(taskId, providerId, userId = "") {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const provider = findProviderForUser(String(providerId || ""), userId);
  if (!provider?.encryptedKey || !provider.baseUrl) throw new Error("PROVIDER_NOT_READY");
  task.providerId = provider.id;
  task.updatedAt = new Date().toISOString();
  addEvent("provider_selected", `已切换分析模型：${provider.name} / ${provider.model}`, { taskId, providerId: provider.id, userId });
  persistTask(task);
  return task;
}

function recordConfirmedOrder(task, pending, { status, submitted, source, message }) {
  const existing = state.orders.find((order) => order.idempotencyKey === `pending:${pending.id}`);
  if (existing) return existing;
  const order = {
    id: `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `pending:${pending.id}`,
    taskId: task.id,
    symbol: String(task.market?.symbol || task.symbol || ""),
    action: pending.action,
    mode: task.mode,
    status,
    targetPositionPct: Number(task.decision?.targetPositionPct || 0),
    maxOrderValuePct: Number(task.decision?.maxOrderValuePct || 0),
    suggestedPrice: pending.suggestedPrice,
    suggestedQty: pending.suggestedQty,
    submitted,
    source,
    message,
    createdAt: new Date().toISOString(),
  };
  state.orders.unshift(order);
  persistOrder(order);
  return order;
}

export async function confirmPendingAction(taskId, { source = "manual_confirm", runtime } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.pendingAction?.status !== "WAITING") throw new Error("PENDING_ACTION_NOT_FOUND");
  if (source === "auto_timeout" && task.autoDecisionEnabled !== true) throw new Error("AUTO_DECISION_DISABLED");
  if (source === "auto_timeout" && isLiveTask(task)) throw new Error("LIVE_REQUIRES_MANUAL_CONFIRM");
  if (pendingConfirmLocks.has(taskId)) throw new Error("CONFIRM_IN_PROGRESS");
  pendingConfirmLocks.add(taskId);
  try {
    clearPendingActionTimer(task.id);
    const actionLabel = task.pendingAction.action === "BUY" ? "买入" : "卖出";
    const tools = resolveRuntime(runtime);
    if (shouldSubmitLiveOrder(task, source)) {
      task.pendingAction = {
        ...task.pendingAction,
        status: "SUBMITTING",
        message: `正在提交${actionLabel}订单…`,
      };
      persistTask(task);
      const sessionId = task.target?.browserSessionId || `task:${task.id}`;
      const submitted = await tools.submitSuggestionForm({
        sessionId,
        action: task.pendingAction.action,
        price: task.pendingAction.suggestedPrice,
        quantity: task.pendingAction.suggestedQty,
      });
      if (submitted?.submitted === true && submitted.ok !== true) {
        const order = recordConfirmedOrder(task, task.pendingAction, {
          status: "rejected",
          submitted: true,
          source,
          message: submitted.message || submitted.code || "交易所拒绝下单",
        });
        task.pendingAction = {
          ...task.pendingAction,
          status: "CONFIRMED",
          source,
          resolvedAt: new Date().toISOString(),
          formSubmitBlocked: false,
          message: `已点击${actionLabel}但未成交：${order.message}`,
        };
        task.nextTrigger = task.pendingAction.message;
        addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: true, orderId: order.id, submitted: true });
        appendAgentOutput({
          taskId,
          runId: task.activeRunId || "",
          stage: "action",
          kind: "order",
          level: "error",
          message: task.pendingAction.message,
          data: { pendingActionId: task.pendingAction.id, source, submitted: true, orderCreated: true, orderId: order.id },
        });
        persistTask(task);
        return task;
      }
      if (!submitted?.ok || submitted.submitted !== true) {
        task.pendingAction = {
          ...task.pendingAction,
          status: "WAITING",
          message: `确认后下单失败：${submitted?.message || submitted?.code || "请检查目标页登录态后重试"}`,
        };
        task.nextTrigger = task.pendingAction.message;
        persistTask(task);
        throw new Error(submitted?.message || submitted?.code || "TRADE_SUBMIT_FAILED");
      }
      const order = recordConfirmedOrder(task, task.pendingAction, {
        status: "submitted",
        submitted: true,
        source,
        message: submitted.message || "已提交实盘订单",
      });
      task.pendingAction = {
        ...task.pendingAction,
        status: "CONFIRMED",
        source,
        resolvedAt: new Date().toISOString(),
        formSubmitBlocked: false,
        message: `已确认并提交${actionLabel}订单`,
      };
      task.nextTrigger = task.pendingAction.message;
      addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: true, orderId: order.id, submitted: true });
      appendAgentOutput({
        taskId,
        runId: task.activeRunId || "",
        stage: "action",
        kind: "order",
        message: task.pendingAction.message,
        data: { pendingActionId: task.pendingAction.id, source, submitted: true, orderCreated: true, orderId: order.id },
      });
      persistTask(task);
      return task;
    }

    if (task.mode === "SHADOW") {
      recordConfirmedOrder(task, task.pendingAction, {
        status: "shadow",
        submitted: false,
        source,
        message: "影子记录，未提交实盘",
      });
    }

    task.pendingAction = {
      ...task.pendingAction,
      status: "CONFIRMED",
      source,
      resolvedAt: new Date().toISOString(),
      formSubmitBlocked: true,
      message: source === "auto_timeout"
        ? `倒计时结束，已自动确认${actionLabel}建议；观察模式未提交交易单`
        : task.mode === "SHADOW"
          ? `已确认${actionLabel}建议，已写入影子记录`
          : `已确认${actionLabel}建议；观察模式未提交交易单`,
    };
    task.nextTrigger = task.pendingAction.message;
    addEvent("suggestion_confirmed", task.pendingAction.message, { taskId, action: task.pendingAction.action, source, orderCreated: task.mode === "SHADOW", submitted: false });
    appendAgentOutput({
      taskId,
      runId: task.activeRunId || "",
      stage: "action",
      kind: "suggestion",
      message: task.pendingAction.message,
      data: { pendingActionId: task.pendingAction.id, source, submitted: false, orderCreated: task.mode === "SHADOW" },
    });
    if (task.mode === "PAPER" && state.orders.some((order) => order.taskId === taskId && order.mode === "LIVE" && order.status !== "rejected")) {
      throw new Error("ORDER_CREATED_UNEXPECTEDLY");
    }
    persistTask(task);
    return task;
  } finally {
    pendingConfirmLocks.delete(taskId);
  }
}

export function cancelPendingAction(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.pendingAction?.status !== "WAITING") throw new Error("PENDING_ACTION_NOT_FOUND");
  clearPendingActionTimer(task.id);
  task.pendingAction = {
    ...task.pendingAction,
    status: "CANCELLED",
    source: "manual_cancel",
    resolvedAt: new Date().toISOString(),
    message: "已取消本次建议，未下单",
  };
  task.nextTrigger = task.pendingAction.message;
  addEvent("suggestion_cancelled", task.pendingAction.message, { taskId, action: task.pendingAction.action });
  persistTask(task);
  return task;
}

export function takeoverPendingAction(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.pendingAction?.status === "WAITING") {
    clearPendingActionTimer(task.id);
    task.pendingAction = {
      ...task.pendingAction,
      status: "TAKEN_OVER",
      source: "manual_takeover",
      resolvedAt: new Date().toISOString(),
      message: "倒计时内已人工接管，自动确认已取消",
    };
  }
  return claimManual(taskId);
}

function monitoringIntent(task) {
  return Boolean(task && !task.stopLocked && (task.monitoringEnabled === true || (task.monitoringEnabled === undefined && task.status === "MONITORING")));
}

export function monitoringPollIntervalMs(task) {
  const configured = Number(process.env.MONITOR_POLL_INTERVAL_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.min(MAX_MONITOR_POLL_MS, Math.max(1000, configured));
  const timeframe = String(task?.timeframe || "15m").toLowerCase();
  if (["1m", "1min"].includes(timeframe)) return DEFAULT_MONITOR_POLL_MS;
  if (["3m", "3min", "5m", "5min"].includes(timeframe)) return 7000;
  if (["10m", "10min", "15m", "15min"].includes(timeframe)) return 10000;
  if (["30m", "30min", "1h", "60m", "2h"].includes(timeframe)) return 15000;
  return 30000;
}

function monitorRetryDelay(task) {
  const failures = Math.max(1, Number(task?.monitorFailureCount || 1));
  const base = monitoringPollIntervalMs(task);
  return Math.min(MAX_MONITOR_POLL_MS, base * (2 ** Math.min(5, failures - 1)));
}

function decisionExpired(task) {
  const createdAt = new Date(task?.decision?.createdAt || "").getTime();
  const ttlSec = Number(task?.decision?.ttlSec || 0);
  return !Number.isFinite(createdAt) || !Number.isFinite(ttlSec) || ttlSec <= 0 || Date.now() >= createdAt + ttlSec * 1000;
}

function setNextPoll(task, delayMs = monitoringPollIntervalMs(task)) {
  task.nextPollAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();
  task.nextTrigger = `等待行情变化，约 ${Math.ceil(Math.max(0, Number(delayMs) || 0) / 1000)} 秒后检查`;
}

function renewLease(task) {
  const now = new Date().toISOString();
  task.heartbeatAt = now;
  task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  if (!task.lastHeartbeatEventAt || Date.now() - new Date(task.lastHeartbeatEventAt).getTime() > 60000) {
    task.lastHeartbeatEventAt = now;
    addEvent("controller_heartbeat", "任务租约已续期，服务端监控保持在线", { taskId: task.id, leaseExpiresAt: task.leaseExpiresAt });
  }
}

function notifyCycleIdle(taskId) {
  const waiters = cycleWaiters.get(taskId) || [];
  cycleWaiters.delete(taskId);
  for (const resolve of waiters) resolve();
}

function waitForIdleCycle(taskId) {
  if (!activeCycles.has(taskId)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = cycleWaiters.get(taskId) || [];
    list.push(resolve);
    cycleWaiters.set(taskId, list);
  });
}

async function acquireCycle(taskId, { wait = false } = {}) {
  while (activeCycles.has(taskId)) {
    if (!wait) return false;
    await waitForIdleCycle(taskId);
  }
  activeCycles.add(taskId);
  return true;
}

function holdDecision(code, invalidation) {
  return {
    action: "HOLD",
    confidence: 0,
    targetPositionPct: 0,
    maxOrderValuePct: 0,
    reasonCodes: [],
    evidenceIds: [],
    invalidation,
    riskFlags: [code],
    createdAt: new Date().toISOString(),
    ttlSec: 300,
  };
}

function stoppedRunResult(task, run, market = task.market || null) {
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "system", level: "warn", message: "任务已停止锁定，跳过本轮后续分析" });
  finishAgentRun(run.id, { status: "skipped", action: task.decision?.action || "HOLD", route: "STOP_LOCKED", code: "STOP_LOCKED" });
  return { task, market, skipped: true, reason: "STOP_LOCKED", route: "STOP_LOCKED", run, analysisTriggered: false };
}

function invalidatedRunResult(taskId, run, market = null) {
  const task = getTask(taskId);
  appendAgentOutput({ taskId, runId: run.id, stage: "system", level: "warn", message: "任务生命周期已变化，已丢弃旧轮次结果" });
  finishAgentRun(run.id, { status: "stale", action: null, route: "CYCLE_INVALIDATED", code: "CYCLE_INVALIDATED" });
  return { task, market: task?.market || market, skipped: true, reason: "CYCLE_INVALIDATED", route: "CYCLE_INVALIDATED", run, analysisTriggered: false };
}

function transitionWorkflow(task, activeKey, detail) {
  const activeIndex = task.workflow.findIndex((item) => item.key === activeKey);
  task.workflow = task.workflow.map((step, index) => {
    if (step.key === activeKey) return { ...step, status: "active", detail: detail || step.detail };
    return { ...step, status: index < activeIndex ? "complete" : "pending" };
  });
}

function completeWorkflow(task, key, detail) {
  task.workflow = task.workflow.map((step) => step.key === key ? { ...step, status: "complete", detail } : step);
}

function logStage(task, run, stage, message, data = null, level = "info") {
  transitionWorkflow(task, stage, message);
  appendAgentOutput({ taskId: task.id, runId: run.id, stage, kind: "stage", level, message, data });
  persistTask(task);
}

function startupChecks(task) {
  const connector = getConnector(task.target.connectorId);
  const readonlyReady = connector?.reviewStatus === "APPROVED"
    && connector.adapterId === "haohan-readonly"
    && connector.capabilities.includes("read_visible_market");
  const credentialReady = readonlyReady || (
    task.target.credentialStatus === "已托管"
    && Boolean(task.target.credentialRef)
    && task.target.credentialRef !== "credential:demo"
    && credentialExists(task.target.credentialRef, task.target.credentialOwnerUserId ? { ownerUserId: task.target.credentialOwnerUserId } : {} )
  );
  return [
    { key: "target", label: "目标连接", passed: Boolean(task.target.url || task.target.installPath || task.target.connectorId) },
    { key: "credentials", label: readonlyReady ? "只读行情" : "凭据托管", passed: credentialReady },
    { key: "risk", label: "风控配置", passed: Boolean(task.riskProfile) },
    { key: "mode", label: "观察模式", passed: task.mode === "PAPER" || task.mode === "SHADOW" || task.mode === "LIVE" },
    { key: "adapter", label: "目标适配器", passed: Boolean(task.target.connectorId) },
  ];
}

function applyFreshnessRules(task, market) {
  const freshness = task.rules.find((rule) => rule.mode === "AUTO" && /新鲜/.test(rule.name));
  if (freshness) {
    const stale = Number(market.freshnessSec) > 5;
    freshness.status = stale ? "pending" : "passed";
    freshness.detail = stale ? `数据延迟 ${market.freshnessSec} 秒` : `延迟 ${market.freshnessSec} 秒`;
  }
  const position = task.rules.find((rule) => rule.mode === "AUTO" && /仓位/.test(rule.name));
  if (position) {
    const exposure = Number(task.metrics?.exposurePct || 0);
    position.status = exposure > 30 ? "pending" : "passed";
    position.detail = `当前 ${exposure}%`;
  }
  const anomalyRule = task.rules.find((rule) => rule.mode === "BLOCK");
  if (anomalyRule) {
    anomalyRule.status = market.anomaly ? "pending" : "standby";
    anomalyRule.detail = market.anomaly ? "ATR 异常放大，自动动作已锁定" : "未触发";
  }
}

export function startTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (["MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING", "STARTING"].includes(task.status)) return task;
  advanceTaskGeneration(task);
  const checks = startupChecks(task);
  const failed = checks.filter((check) => !check.passed);
  if (failed.length) {
    task.monitoringEnabled = false;
    task.nextPollAt = null;
    task.nextTrigger = "启动检查未通过";
    stopController(taskId);
    task.status = "BLOCKED";
    addEvent("startup_blocked", `启动检查未通过：${failed.map((item) => item.label).join("、")}`, { taskId, checks });
    persistTask(task);
    return task;
  }
  task.status = "STARTING";
  task.stopLocked = false;
  task.monitoringEnabled = true;
  task.monitorFailureCount = 0;
  task.lastObservedFingerprint = "";
  task.lastAnalyzedFingerprint = "";
  task.lastAnalysisSucceeded = false;
  task.nextPollAt = null;
  task.monitoringRound = Number(task.monitoringRound || 0);
  transitionWorkflow(task, "connect", "启动检查通过，准备连接目标");
  addEvent("task_starting", "开始启动检查，正在恢复账户现场", { taskId });
  task.status = "MONITORING";
  task.heartbeatAt = new Date().toISOString();
  task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  setNextPoll(task, 0);
  transitionWorkflow(task, "analyze", "进入持续观察，等待分析触发");
  task.updatedAt = new Date().toISOString();
  addEvent("task_monitoring", "启动检查通过，Agent 已进入持续监控；买卖仍只给出建议", { taskId });
  persistTask(task);
  startController(taskId);
  return task;
}

export function stopTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status === "MANUAL_CONTROL" && task.stopLocked) return task;
  advanceTaskGeneration(task);
  task.stopLocked = true;
  task.monitoringEnabled = false;
  task.nextPollAt = null;
  task.nextTrigger = "已停止观察";
  clearPendingAction(task, { persist: false });
  stopController(taskId);
  task.status = "STOPPING";
  addEvent("stop_requested", "已阻断新决策和新订单，开始对账", { taskId });
  task.workflow = task.workflow.map((step) => ({
    ...step,
    status: step.key === "connect" || step.key === "login" ? "complete" : "pending",
  }));
  task.status = "MANUAL_CONTROL";
  task.target.connectionStatus = task.target.connectionStatus === "connected" ? "connected" : task.target.connectionStatus;
  task.updatedAt = new Date().toISOString();
  addEvent("manual_control", "已切换人工接管；现有持仓未自动平仓，服务端不会下单", { taskId });
  persistTask(task);
  return task;
}

export function claimManual(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  advanceTaskGeneration(task);
  task.stopLocked = true;
  task.monitoringEnabled = false;
  task.nextPollAt = null;
  task.nextTrigger = "已切换人工接管";
  if (task.pendingAction?.status === "WAITING") {
    clearPendingActionTimer(task.id);
    task.pendingAction = {
      ...task.pendingAction,
      status: "TAKEN_OVER",
      source: "manual_takeover",
      resolvedAt: new Date().toISOString(),
      message: "人工已接管，自动确认已取消",
    };
  }
  stopController(taskId);
  task.status = "MANUAL_CONTROL";
  addEvent("manual_claimed", "人工已接管任务，Agent 禁止自动买卖", { taskId });
  persistTask(task);
  return task;
}

export function autoJudge(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const pending = task.rules.find((rule) => rule.status === "pending" && rule.mode === "REVIEW");
  if (!pending) return task;
  advanceTaskGeneration(task);
  pending.status = "passed";
  pending.detail = "人工确认通过，已记录审计";
  addEvent("rule_approved", `规则 ${pending.order} 已人工确认，允许进入风控`, { taskId, ruleId: pending.id });
  const blocked = task.rules.some((rule) => rule.status === "pending" && rule.mode === "BLOCK");
  if (!blocked && task.status === "PAUSED" && !task.stopLocked) {
    task.status = "MONITORING";
    task.heartbeatAt = new Date().toISOString();
    task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    addEvent("task_resumed", "人工规则确认完成，任务恢复持续监控", { taskId });
    startController(taskId);
  }
  persistTask(task);
  return task;
}

async function ensureConnected(task, connector, run, runtime, assertCurrent = () => {}) {
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  task.target.browserSessionId = sessionId;
  const url = String(task.target.url || connector?.target || HAO_HAN_TARGET_URL);
  assertCurrent();
  logStage(task, run, "connect", `打开目标：${url}`, { url, sessionId, adapterId: connector?.adapterId || "" });
  const opened = await runtime.openMarketBrowser(task, connector);
  assertCurrent();
  if (!opened.ok && opened.code === "BROWSER_SESSION_NOT_FOUND") {
    return opened;
  }
  if (!opened.ok && opened.code !== "BROWSER_SESSION_NOT_FOUND") {
    logStage(task, run, "connect", `浏览器连接失败：${opened.message || opened.code}`, { code: opened.code }, "error");
    return opened;
  }
  completeWorkflow(task, "connect", opened.ok ? `浏览器会话 ${opened.mode || "ready"}` : "改用只读接口");
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "connect", message: opened.ok ? `已打开 ${opened.url || url}` : "页面未打开，后续将尝试只读行情接口", data: { code: opened.code || "OK" } });
  return opened;
}

async function ensureLoggedIn(task, connector, run, pageResult, runtime, assertCurrent = () => {}) {
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  assertCurrent();
  const loginState = await runtime.browserLoginStatus({ sessionId, adapterId: task.target.adapterId || connector?.adapterId });
  assertCurrent();
  const needsLogin = pageResult?.code === "REAUTH_REQUIRED" || /#\/login/.test(String(pageResult?.url || pageResult?.page?.url || "")) || !loginState.authenticated;
  if (!needsLogin && pageResult?.ok) {
    task.target.loginStatus = "authenticated";
    completeWorkflow(task, "login", "登录态有效");
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", message: "目标页面已登录，继续采集" });
    persistTask(task);
    return { ok: true, authenticated: true };
  }
  logStage(task, run, "login", needsLogin ? "检测到登录页或登录过期，准备填充并提交登录" : "确认登录态");
  if (!task.target.credentialRef || task.target.credentialRef === "credential:demo") {
    task.target.loginStatus = "REAUTH_REQUIRED";
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: "缺少托管凭据，无法自动登录" });
    persistTask(task);
    return { ok: false, code: "REAUTH_REQUIRED", message: "目标网页登录态已失效，需要重新登录" };
  }
  const login = await runtime.browserLogin({
    sessionId,
    credentialRef: task.target.credentialRef,
    ownerUserIds: userIdsForTask(task.id),
    adapterId: task.target.adapterId || connector?.adapterId,
    targetUrl: task.target.url || connector?.target || HAO_HAN_TARGET_URL,
    automationAuthorized: true,
    submit: true,
  });
  assertCurrent();
  if (!login.ok) {
    task.target.loginStatus = "REAUTH_REQUIRED";
    appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: `登录失败：${login.message || login.code}`, data: { code: login.code } });
    persistTask(task);
    return login;
  }
  task.target.loginStatus = login.authenticated ? "authenticated" : "credential_required";
  completeWorkflow(task, "login", login.authenticated ? "登录已提交" : "已填充登录表单");
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", message: login.authenticated ? "登录已提交，等待交易页" : "登录表单已填充但未确认提交" });
  persistTask(task);
  return login;
}

function stopForLoginFailure(task, run, result) {
  const code = String(result?.code || "LOGIN_NOT_CONFIRMED");
  const reauth = /LOGIN|REAUTH|CREDENTIAL|BROWSER_SESSION|TARGET_MISMATCH|NAVIGATION/.test(code);
  const route = reauth ? "REAUTH_REQUIRED" : "CONNECT_FAILED";
  task.decision = holdDecision(code, reauth ? "重新登录并确认目标页面后重试" : "恢复目标连接后重试");
  task.monitorFailureCount = Number(task.monitorFailureCount || 0) + 1;
  task.status = task.stopLocked ? "MANUAL_CONTROL" : (run.trigger === "controller" || task.monitoringEnabled === true ? "PAUSED" : "BLOCKED");
  setNextPoll(task, monitorRetryDelay(task));
  task.target.loginStatus = reauth ? "reauth_required" : "connection_failed";
  completeWorkflow(task, "login", result?.message || code);
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "login", level: "error", message: `登录或连接未确认：${result?.message || code}`, data: { code } });
  addEvent("login_blocked", "目标登录或连接未确认，分析保持 HOLD", { taskId: task.id, runId: run.id, code, route });
  finishAgentRun(run.id, { status: "paused", action: "HOLD", route, code });
  persistTask(task);
  return { task, market: task.market || null, run, route, login: result, analysisTriggered: false };
}

function toTaskMarket(market) {
  return {
    ok: market.ok !== false,
    code: market.code || "READONLY_MARKET_READ",
    message: market.message || "",
    source: market.source,
    sourceKind: market.sourceKind,
    symbol: market.symbol,
    symbolName: market.symbolName,
    instrumentId: market.instrumentId,
    instrument: market.instrument || market.page?.instrument || null,
    timeframe: market.timeframe,
    historyCount: market.historyCount || market.history?.length || 0,
    completeHistoryCount: market.completeHistoryCount || 0,
    latest: market.quote || market.latest || { price: 0, open: 0, high: 0, low: 0, volume: 0 },
    changePct: market.changePct === null || market.changePct === undefined ? null : Number(market.changePct),
    indicators: market.indicators || { ema20: null, ema50: null, sma20: null, rsi14: null, atr14: null, volumeRatio: null, macd: { line: null, signal: null, histogram: null }, bollinger: { middle: null, upper: null, lower: null } },
    trend: market.trend,
    anomaly: Boolean(market.anomaly),
    freshnessSec: market.freshnessSec === null || market.freshnessSec === undefined ? null : Number(market.freshnessSec),
    evidenceId: market.evidenceId,
    fingerprint: market.fingerprint,
    observedAt: market.observedAt,
    dataAt: market.dataAt,
    dataQuality: market.dataQuality,
    missingFields: market.missingFields || [],
    marketClosed: Boolean(market.marketClosed),
    history: Array.isArray(market.history) ? market.history : [],
    ticks: Array.isArray(market.ticks) ? market.ticks : [],
    timeframes: market.timeframes && typeof market.timeframes === "object" ? market.timeframes : {},
    availableTimeframes: Array.isArray(market.availableTimeframes) ? market.availableTimeframes : [],
    timeline: market.timeline || { kind: "timeline", ticks: Array.isArray(market.ticks) ? market.ticks : [], tickCount: Array.isArray(market.ticks) ? market.ticks.length : 0 },
    page: market.page || null,
    pageView: market.pageView || market.page?.view || null,
    raw: market.raw || null,
    account: market.account || { availableFunds: null, equity: null, riskRate: null, dayPnl: null },
  };
}

function syncTaskMetricsFromMarket(task, market) {
  task.metrics = accountMetricsFromMarket(market?.account || {}, task.metrics || {});
}

function marketQualityIssues(market) {
  const issues = Array.isArray(market?.missingFields) ? market.missingFields.map(String) : [];
  if (Number(market?.historyCount || market?.history?.length || 0) < 20) issues.push("HISTORY_INSUFFICIENT");
  if (market?.marketClosed) issues.push("MARKET_CLOSED");
  if (market?.dataQuality === "LIMITED") issues.push("DATA_QUALITY_LIMITED");
  if (Number(market?.freshnessSec) > 5) issues.push("STALE_MARKET_DATA");
  return [...new Set(issues)];
}

function failedAutomaticRules(task) {
  return task.rules.filter((rule) => rule.mode === "AUTO" && rule.status === "pending");
}

function recentAnalysisRounds(taskId, limit = 8) {
  return state.analyses
    .filter((analysis) => String(analysis.taskId) === String(taskId))
    .slice(0, Math.max(1, Number(limit) || 8))
    .reverse()
    .map((analysis, index) => ({
      round: analysis.round ?? index + 1,
      trigger: analysis.trigger || "",
      route: analysis.route || "",
      createdAt: analysis.createdAt || null,
      market: {
        fingerprint: analysis.market?.fingerprint || "",
        symbol: analysis.market?.symbol || "",
        symbolName: analysis.market?.symbolName || "",
        timeframe: analysis.market?.timeframe || "",
        trend: analysis.market?.trend || "",
        latest: analysis.market?.latest || analysis.market?.quote || null,
        changePct: analysis.market?.changePct ?? null,
        indicators: analysis.market?.indicators || null,
        dataQuality: analysis.market?.dataQuality || "",
        missingFields: analysis.market?.missingFields || [],
      },
      decision: analysis.decision || holdDecision("PRIOR_DECISION_UNAVAILABLE", "当前轮次重新读取数据后判断"),
    }));
}

function buildDecisionContext(task, market, evidence, trigger, analysisMarket = market) {
  const layered = analysisMarket?.analysisLayers ? analysisMarket : buildLayeredAnalysisMarket(analysisMarket || task.market);
  return {
    market: {
      symbol: market.symbol,
      timeframe: layered.timeframe,
      trend: market.trend,
      anomaly: market.anomaly,
      freshnessSec: market.freshnessSec,
      indicators: market.indicators,
      latest: task.market.latest,
      historyCount: layered.historyCount,
      history: layered.history,
      ticks: [],
      timeline: layered.timeline,
      timeframes: layered.timeframes,
      availableTimeframes: layered.availableTimeframes,
      analysisLayers: layered.analysisLayers,
      quote: market.quote,
      dataQuality: market.dataQuality,
      missingFields: market.missingFields || [],
      marketClosed: Boolean(market.marketClosed),
      source: market.source,
      page: layered.page ?? task.market.page,
      raw: layered.raw,
    },
    account: {
      ...task.metrics,
      ...(market.account || {}),
    },
    rules: task.rules,
    evidence: evidence.map(({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, segmentId, rowStart, rowEnd, rowCount, contentHash }) => ({ evidenceId, type, excerpt, chunkId, skillId, version, title, score, segmentId, rowStart, rowEnd, rowCount, contentHash })),
    evidenceIds: evidence.map((item) => item.evidenceId).filter(Boolean),
    previousAnalysis: {
      fingerprint: task.lastAnalyzedFingerprint || null,
      succeeded: task.lastAnalysisSucceeded !== false,
      decision: task.decision,
      analyzedAt: task.lastAnalysisAt || null,
    },
    conversation: {
      round: Number(task.monitoringRound || 0) + 1,
      trigger,
      previousFingerprint: task.lastAnalyzedFingerprint || null,
      recentRounds: recentAnalysisRounds(task.id),
    },
  };
}

function segmentConcurrency() {
  const value = Number(process.env.ANALYSIS_SEGMENT_CONCURRENCY || 3);
  return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 3));
}

function segmentRetries() {
  const value = Number(process.env.ANALYSIS_SEGMENT_RETRIES || 1);
  return Math.min(2, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 1));
}

function segmentLabel(segment) {
  if (segment.kind === "kline" || segment.kind === "timeframe_ticks") return `${segment.timeframe} ${segment.kind === "kline" ? "K 线" : "逐笔"}`;
  if (segment.kind === "live_ticks") return "实时逐笔";
  if (segment.kind === "snapshot_context") return "报价与账户只读字段";
  if (segment.kind === "page") return "页面可见字段";
  return "只读原始字段";
}

function directAnalysisCoverage(market) {
  const timeframeEntries = Object.values(market?.timeframes || {});
  const totalKlineRows = timeframeEntries.length
    ? timeframeEntries.reduce((sum, snapshot) => sum + Number(snapshot?.historyCount ?? snapshot?.history?.length ?? 0), 0)
    : Number(market?.historyCount ?? market?.history?.length ?? 0);
  return {
    mode: "direct_full_snapshot",
    fingerprint: String(market?.fingerprint || ""),
    estimatedDirectBytes: estimateMarketContextBytes(market),
    totalSegments: 1,
    totalKlineRows,
    totalLiveTickRows: Array.isArray(market?.ticks) ? market.ticks.length : 0,
    reviewedSegments: 1,
    failedSegments: [],
    complete: true,
  };
}

async function reviewAllMarketSegments({ task, run, provider, runtime, market, evidence, assertCurrent = () => {} }) {
  assertCurrent();
  const plan = buildMarketAnalysisSegments(market);
  const reviews = new Array(plan.segments.length);
  const failures = [];
  let cursor = 0;
  let stopped = false;
  const segmentContext = {
    symbol: market.symbol,
    symbolName: market.symbolName,
    primaryTimeframe: market.timeframe,
    rules: task.rules,
    expertEvidence: evidence.map(({ evidenceId, type, excerpt, chunkId, skillId, version, title, score }) => ({ evidenceId, type, excerpt, chunkId, skillId, version, title, score })),
    coverage: plan.coverage,
  };
  appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "coverage", message: `分层行情已拆分为 ${plan.segments.length} 个 AI 分析片段，覆盖 ${plan.coverage.totalKlineRows} 根 K 线（分钟/小时/日/月，不含秒级逐笔）`, data: { coverage: plan.coverage } });
  const worker = async () => {
    while (true) {
      if (task.stopLocked) {
        stopped = true;
        return;
      }
      assertCurrent();
      const index = cursor;
      cursor += 1;
      if (index >= plan.segments.length) return;
      const segment = plan.segments[index];
      let review = null;
      let lastFailure = null;
      for (let attempt = 0; attempt <= segmentRetries(); attempt += 1) {
        if (task.stopLocked) {
          stopped = true;
          return;
        }
        assertCurrent();
        try {
          review = await runtime.requestSegmentReview(provider, segment, segmentContext, { timeoutMs: 45000 });
          assertCurrent();
          if (review?.ok && String(review.segmentId) === String(segment.segmentId) && String(review.contentHash) === String(segment.contentHash) && Number(review.rowCount) === Number(segment.rowCount)) break;
          lastFailure = review || { ok: false, code: "INVALID_SEGMENT_REVIEW" };
        } catch (error) {
          if (error instanceof CycleAbortError) throw error;
          lastFailure = { ok: false, code: error?.message || "SEGMENT_REVIEW_FAILED" };
        }
      }
      if (task.stopLocked) {
        stopped = true;
        return;
      }
      if (review?.ok && String(review.segmentId) === String(segment.segmentId) && String(review.contentHash) === String(segment.contentHash) && Number(review.rowCount) === Number(segment.rowCount)) {
        reviews[index] = review;
        appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "segment", message: `片段 ${index + 1}/${plan.segments.length} 已完成：${segmentLabel(segment)}，${segment.rowCount} 行`, data: { segmentId: segment.segmentId, contentHash: segment.contentHash, rowCount: segment.rowCount } });
      } else {
        const failure = { segmentId: segment.segmentId, kind: segment.kind, timeframe: segment.timeframe, rowStart: segment.rowStart, rowEnd: segment.rowEnd, rowCount: segment.rowCount, contentHash: segment.contentHash, code: String(lastFailure?.code || "SEGMENT_REVIEW_FAILED") };
        failures.push(failure);
        appendAgentOutput({ taskId: task.id, runId: run.id, stage: "analyze", kind: "segment", level: "error", message: `片段 ${index + 1}/${plan.segments.length} 未完成：${segmentLabel(segment)}，下一轮重试`, data: failure });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(segmentConcurrency(), plan.segments.length) }, () => worker()));
  assertCurrent();
  failures.sort((left, right) => String(left.segmentId).localeCompare(String(right.segmentId)));
  const coverage = {
    ...plan.coverage,
    reviewedSegments: reviews.filter(Boolean).length,
    failedSegments: failures,
    complete: !stopped && failures.length === 0 && reviews.filter(Boolean).length === plan.segments.length,
  };
  return { ...plan, reviews, failures, coverage, stopped };
}

export function enforceDecisionLimits(decision) {
  if (decision.action === "HOLD") return { ...decision, targetPositionPct: 0, maxOrderValuePct: 0 };
  const targetPositionPct = Number(decision.targetPositionPct) || 0;
  const maxOrderValuePct = Number(decision.maxOrderValuePct) || 0;
  if (targetPositionPct > executionLimits.maxPositionPct || maxOrderValuePct > executionLimits.maxOrderValuePct) {
    return {
      ...decision,
      targetPositionPct,
      maxOrderValuePct,
      riskFlags: [...new Set([...(decision.riskFlags || []), "RISK_LIMIT_EXCEEDED"])],
      invalidation: "模型建议超过服务端风险上限，调整策略后重试",
    };
  }
  return { ...decision, targetPositionPct, maxOrderValuePct };
}

export async function runAnalysis(taskId, providerId = "", { trigger = "manual", userId = "", skipIfUnchanged = false, runtime: runtimeOverrides = {} } = {}) {
  const existing = getTask(taskId);
  if (!existing) throw new Error("TASK_NOT_FOUND");
  const acquired = await acquireCycle(taskId, { wait: trigger === "manual" });
  if (!acquired) return { task: existing, market: existing.market || null, skipped: true, reason: "CYCLE_IN_PROGRESS", analysisTriggered: false };
  const task = getTask(taskId);
  if (!task) {
    activeCycles.delete(taskId);
    notifyCycleIdle(taskId);
    throw new Error("TASK_NOT_FOUND");
  }
  const runtime = resolveRuntime(runtimeOverrides);
  const run = startAgentRun(taskId, { trigger });
  const generation = taskGeneration(task);
  const assertCurrent = () => assertCycleCurrent(task, generation);
  const statusBeforeCycle = task.status;
  try {
    assertCurrent();
    task.status = "ANALYZING";
    task.lastCycleAt = new Date().toISOString();
    persistTask(task);
    const connector = getConnector(task.target.connectorId);
    const opened = await ensureConnected(task, connector, run, runtime, assertCurrent);
    assertCurrent();
    const loginResult = opened?.ok
      ? await ensureLoggedIn(task, connector, run, opened, runtime, assertCurrent)
      : { ok: false, authenticated: false, code: opened?.code || "BROWSER_NOT_OPENED", message: opened?.message || "目标页面未打开" };
    assertCurrent();
    if (!loginResult.ok || !loginResult.authenticated) return stopForLoginFailure(task, run, loginResult);

    logStage(task, run, "collect", "读取网页可见数据与只读行情");
    const market = await runtime.observeMarket(task, connector);
    assertCurrent();
    if (!market.ok) {
      const paused = market.code === "REAUTH_REQUIRED";
      const route = paused ? "REAUTH_REQUIRED" : "COLLECT_FAILED";
      task.decision = holdDecision(market.code, paused ? "重新登录后重试" : "数据采集恢复后重试");
      task.status = paused ? "BLOCKED" : "PAUSED";
      task.target.loginStatus = paused ? "REAUTH_REQUIRED" : task.target.loginStatus;
      appendAgentOutput({ taskId, runId: run.id, stage: "collect", level: "error", message: `数据采集暂停：${market.message}`, data: { code: market.code } });
      addEvent("market_paused", `数据采集暂停：${market.message}`, { taskId, code: market.code, runId: run.id });
      finishAgentRun(run.id, { status: "paused", action: "HOLD", route, code: market.code });
      persistTask(task);
      return { task, market, run, route };
    }
    task.market = toTaskMarket(market);
    syncTaskMetricsFromMarket(task, market);
    task.lastPolledAt = new Date().toISOString();
    task.lastObservedFingerprint = String(market.fingerprint || "");
    task.monitorFailureCount = 0;
    completeWorkflow(task, "collect", `${task.market.historyCount} 根 K 线 · ${market.source}`);
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "collect",
      message: `已采集 ${task.symbol} 最新价 ${task.market.latest.price}，趋势 ${market.trend}，来源 ${market.source}`,
      data: { source: market.source, freshnessSec: market.freshnessSec, historyCount: task.market.historyCount, missingFields: market.missingFields || [] },
    });
    const marketUnchanged = Boolean(skipIfUnchanged && market.fingerprint && task.lastAnalyzedFingerprint === market.fingerprint && task.lastAnalysisSucceeded !== false && !decisionExpired(task));
    if (marketUnchanged) {
      const pendingRule = task.rules.some((rule) => rule.status === "pending");
      task.status = monitoringIntent(task)
        ? (["PAUSED", "BLOCKED"].includes(statusBeforeCycle) && pendingRule ? statusBeforeCycle : "MONITORING")
        : "MANUAL_CONTROL";
      task.nextTrigger = "行情未变化，等待下一次只读检查";
      completeWorkflow(task, "analyze", "行情指纹未变化，跳过模型请求");
      completeWorkflow(task, "rules", "本轮未触发新分析");
      completeWorkflow(task, "action", "沿用上一轮建议，未执行任何动作");
      appendAgentOutput({ taskId, runId: run.id, stage: "system", kind: "poll", message: "本轮只读行情与上轮一致，跳过模型请求并继续监测" });
      finishAgentRun(run.id, { status: "skipped", action: task.decision.action, route: "WAITING_FOR_CHANGE", code: "MARKET_UNCHANGED" });
      setNextPoll(task);
      persistTask(task);
      return { task, market, run, skipped: true, reason: "MARKET_UNCHANGED", route: "WAITING_FOR_CHANGE", analysisTriggered: false };
    }
    if (skipIfUnchanged && market.fingerprint && task.lastAnalyzedFingerprint === market.fingerprint && decisionExpired(task)) {
      appendAgentOutput({ taskId, runId: run.id, stage: "system", kind: "poll", message: "上一轮建议已过期，重新请求模型确认" });
    }
    applyFreshnessRules(task, market);
    const qualityIssues = marketQualityIssues(market);
    const automaticRuleFailures = failedAutomaticRules(task);

    logStage(task, run, "analyze", "检索专家经验并请求模型结构化建议");
    const analysisMarket = buildLayeredAnalysisMarket(task.market);
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      kind: "coverage",
      message: `分析粒度已分层（不含秒级逐笔）：${describeAnalysisLayers(analysisMarket)}`,
      data: analysisMarket.analysisLayers,
    });
    const knowledge = searchKnowledge(`${market.symbol || task.symbol} ${task.timeframe} ${market.trend} 趋势 突破 回撤 红线`, { ownerUserId: userId }, 4);
    const evidence = [
      { evidenceId: market.evidenceId, type: "market_snapshot", excerpt: `${market.symbol} ${market.timeframe} ${market.trend} · ${market.historyCount} 根主周期 K 线 · ${market.availableTimeframes?.length || 0} 个周期 · EMA20 ${market.indicators?.ema20} · RSI ${market.indicators?.rsi14}` },
      ...knowledge,
    ];
    appendAgentOutput({ taskId, runId: run.id, stage: "analyze", message: `检索到 ${knowledge.length} 条已发布经验切片` });
    const resolvedProviderId = resolveDefaultProviderId(userId, providerId || task.providerId);
    const provider = findProviderForUser(resolvedProviderId, userId);
    if (provider?.id) task.providerId = provider.id;
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      message: provider?.encryptedKey
        ? `使用 ${provider.name}（${provider.model}）请求结构化建议`
        : "未配置可用 Provider，将保持观望",
    });
    let decision;
    let providerSucceeded = true;
    let analysisCoverage = directAnalysisCoverage(analysisMarket);
    let segmentReviews = [];
    try {
      assertCurrent();
      if (provider?.encryptedKey && shouldUseSegmentedAnalysis(analysisMarket)) {
        const segmented = await reviewAllMarketSegments({ task, run, provider, runtime, market: analysisMarket, evidence, assertCurrent });
        assertCurrent();
        analysisCoverage = segmented.coverage;
        task.analysisCoverage = analysisCoverage;
        if (segmented.stopped) return stoppedRunResult(task, run, task.market);
        segmentReviews = segmented.reviews.filter(Boolean).map(compactSegmentReview);
        const coverageEvidenceId = `evidence:coverage:${String(market.fingerprint || "snapshot").slice(0, 24)}`;
        evidence.push({
          evidenceId: coverageEvidenceId,
          type: "market_coverage",
          excerpt: `分层覆盖 ${analysisCoverage.totalSegments} 个片段、${analysisCoverage.totalKlineRows} 根 K 线；完成 ${analysisCoverage.reviewedSegments} 个片段`,
          contentHash: String(market.fingerprint || ""),
        });
        for (const segment of segmented.segments) {
          const review = segmented.reviews[segment.segmentIndex];
          const failure = segmented.failures.find((item) => item.segmentId === segment.segmentId);
          evidence.push({
            evidenceId: `evidence:${segment.segmentId}`,
            type: review ? "market_segment_review" : "market_segment_failure",
            excerpt: review ? `${segmentLabel(segment)}：${review.summary}` : `${segmentLabel(segment)}：${failure?.code || "SEGMENT_REVIEW_FAILED"}`,
            segmentId: segment.segmentId,
            rowStart: segment.rowStart,
            rowEnd: segment.rowEnd,
            rowCount: segment.rowCount,
            contentHash: segment.contentHash,
          });
        }
        if (!analysisCoverage.complete) {
          decision = holdDecision("ANALYSIS_INCOMPLETE", "全量行情片段全部完成 AI 复核后重新决策");
          decision.evidenceIds = [coverageEvidenceId, ...segmentReviews.slice(0, 7).map((review) => `evidence:${review.segmentId}`)];
          providerSucceeded = false;
          appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "coverage", level: "error", message: `全量分析未完成：${analysisCoverage.failedSegments.length} 个片段失败；本轮不生成方向性决策，后台将重试`, data: { coverage: analysisCoverage } });
        } else {
          appendAgentOutput({ taskId, runId: run.id, stage: "analyze", kind: "coverage", message: "全部数据片段已完成 AI 复核，开始结合多轮上下文生成最终建议", data: { coverage: analysisCoverage } });
          const decisionContext = buildDecisionContext(task, market, evidence, trigger, analysisMarket);
          decision = await runtime.requestDecision(provider, {
            ...decisionContext,
            analysisMode: "hierarchical_full_coverage",
            market: summarizeMarketForDecision(analysisMarket, analysisCoverage),
            coverage: analysisCoverage,
            segmentReviews,
          }, { timeoutMs: 45000 });
          assertCurrent();
        }
      } else {
        task.analysisCoverage = analysisCoverage;
        decision = await runtime.requestDecision(provider, buildDecisionContext(task, market, evidence, trigger, analysisMarket), { timeoutMs: 45000 });
        assertCurrent();
      }
      providerSucceeded = providerSucceeded && !["PROVIDER_NOT_CONFIGURED", "PROVIDER_NOT_READY", "PROVIDER_REQUEST_FAILED", "EMPTY_MODEL_RESPONSE", "INVALID_MODEL_JSON", "ANALYSIS_INCOMPLETE"].some((code) => (decision.riskFlags || []).includes(code));
    } catch (error) {
      if (error instanceof CycleAbortError) throw error;
      providerSucceeded = false;
      decision = {
        action: "HOLD",
        confidence: 0,
        targetPositionPct: 0,
        maxOrderValuePct: 0,
        reasonCodes: [],
        evidenceIds: [market.evidenceId],
        invalidation: "模型请求失败后保持观望",
        riskFlags: ["PROVIDER_REQUEST_FAILED"],
        decisionTtlSec: 300,
      };
      appendAgentOutput({ taskId, runId: run.id, stage: "analyze", level: "error", message: `模型请求失败：${provider?.name || "Provider"} ${error.message}` });
    }
    assertCurrent();
    analysisCoverage = { ...analysisCoverage, finalDecisionCompleted: providerSucceeded, complete: analysisCoverage.complete && providerSucceeded };
    task.analysisCoverage = analysisCoverage;
    decision = enforceDecisionLimits(decision);
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    const invalidEvidenceReference = (decision.evidenceIds || []).some((evidenceId) => !evidenceIds.has(evidenceId));
    decision.evidenceIds = (decision.evidenceIds || []).filter((evidenceId) => evidenceIds.has(evidenceId));
    if (invalidEvidenceReference) decision.riskFlags = [...(decision.riskFlags || []), "INVALID_EVIDENCE_REFERENCE"];
    if (qualityIssues.length) decision.riskFlags = [...new Set([...(decision.riskFlags || []), ...qualityIssues])];
    if (automaticRuleFailures.length) decision.riskFlags = [...new Set([...(decision.riskFlags || []), "AUTO_RULE_FAILED"])];
    task.lastAnalysisSucceeded = providerSucceeded;
    if (providerSucceeded && market.fingerprint) task.lastAnalyzedFingerprint = market.fingerprint;
    task.lastAnalysisAt = new Date().toISOString();
    task.monitoringRound = Number(task.monitoringRound || 0) + 1;
    task.decision = { ...decision, createdAt: new Date().toISOString(), ttlSec: decision.decisionTtlSec || 300 };
    completeWorkflow(task, "analyze", `${decision.action} · ${Math.round((decision.confidence || 0) * 100)}%`);
    appendAgentOutput({
      taskId,
      runId: run.id,
      stage: "analyze",
      kind: "decision",
      message: `模型输出 ${decision.action}，置信度 ${Math.round((decision.confidence || 0) * 100)}%`,
      data: { action: decision.action, reasonCodes: decision.reasonCodes, riskFlags: decision.riskFlags },
    });

    logStage(task, run, "rules", "执行确定性规则与红线检查");
    task.status = "RISK_CHECK";
    const blocked = task.rules.some((rule) => rule.status === "pending" && rule.mode === "BLOCK");
    const reviewRequired = task.rules.some((rule) => rule.status === "pending" && rule.mode === "REVIEW");
    const rulePaused = blocked || reviewRequired || automaticRuleFailures.length > 0;
    let route = "SUGGESTION_PENDING";
    const decisionFlags = new Set(decision.riskFlags || []);
    const invalidEvidence = decisionFlags.has("INVALID_EVIDENCE_REFERENCE");
    const providerUnavailable = decisionFlags.has("PROVIDER_NOT_CONFIGURED") || decisionFlags.has("PROVIDER_REQUEST_FAILED");
    const riskLimitExceeded = decisionFlags.has("RISK_LIMIT_EXCEEDED");
    const holdRequired = decision.action === "HOLD" || invalidEvidence || providerUnavailable || riskLimitExceeded || qualityIssues.length > 0;
    if (blocked || reviewRequired || automaticRuleFailures.length || holdRequired) {
      if (blocked) decisionFlags.add("RED_LINE_TRIGGERED");
      if (reviewRequired) decisionFlags.add("HUMAN_REVIEW_REQUIRED");
      if (automaticRuleFailures.length) decisionFlags.add("AUTO_RULE_FAILED");
      for (const issue of qualityIssues) decisionFlags.add(issue);
      task.decision.riskFlags = [...decisionFlags];
      task.status = rulePaused ? "PAUSED" : "MONITORING";
      route = blocked ? "BLOCKED"
        : reviewRequired ? "REVIEW"
          : automaticRuleFailures.length ? "HOLD_RULE"
            : qualityIssues.length ? "HOLD_DATA_QUALITY"
              : riskLimitExceeded ? "RISK_BLOCKED"
                : invalidEvidence ? "HOLD_INVALID_EVIDENCE"
                  : providerUnavailable ? "HOLD_PROVIDER"
                    : "HOLD";
      const actionLabel = task.decision.action === "BUY" ? "买入" : task.decision.action === "SELL" ? "卖出" : "观望";
      const ruleMessage = blocked
        ? `${actionLabel}建议已保留，但红线触发，自动动作暂停`
        : reviewRequired
          ? `${actionLabel}建议已保留，等待人工复核`
          : automaticRuleFailures.length
            ? `${actionLabel}建议已保留，自动规则未通过`
            : task.decision.action === "HOLD"
              ? "模型建议观望，当前轮次无需动作"
              : riskLimitExceeded
                ? `${actionLabel}建议已保留，但仓位超过服务端上限`
                : "当前数据或模型结果不足，保持观望";
      completeWorkflow(task, "rules", ruleMessage);
      appendAgentOutput({ taskId, runId: run.id, stage: "rules", message: ruleMessage });
    } else {
      completeWorkflow(task, "rules", isLiveTask(task) ? "规则通过，等待弹窗确认后下单" : "规则通过，买卖意图转为建议");
      appendAgentOutput({ taskId, runId: run.id, stage: "rules", message: isLiveTask(task) ? "规则通过；确认后才会下单" : "规则通过；观察模式不会自动下单" });
    }

    logStage(task, run, "action", "路由最终建议，等待确认后决定是否下单");
    assertCurrent();
    const execution = await runtime.executeDecision(task, task.decision, connector);
    assertCurrent();
    task.decision.riskFlags = [...new Set([...(task.decision.riskFlags || []), ...(execution.ok ? [] : [execution.code].filter(Boolean))])];
    if (task.decision.action === "BUY" || task.decision.action === "SELL") {
      await openPendingAction(task, { runtime, run });
    } else {
      clearPendingAction(task, { persist: false });
    }
    if (execution.code === "SUGGESTION_PENDING" || execution.code === "TRADING_DISABLED") {
      task.status = task.stopLocked ? "MANUAL_CONTROL" : rulePaused ? "PAUSED" : "MONITORING";
      const pending = task.pendingAction?.status === "WAITING";
      completeWorkflow(task, "action", pending ? `${task.decision.action} 建议待弹窗确认` : `${task.decision.action} 建议已生成`);
      appendAgentOutput({ taskId, runId: run.id, stage: "action", kind: "suggestion", message: pending ? `${task.decision.action === "BUY" ? "买入" : "卖出"}建议待确认；${isLiveTask(task) ? "确认后才会下单" : "观察模式不会下单"}` : `${task.decision.action === "BUY" ? "买入" : task.decision.action === "SELL" ? "卖出" : "观望"}建议已生成`, data: { action: task.decision.action, route, executionCode: execution.code, pendingActionId: task.pendingAction?.id || null } });
    } else if (!execution.ok) {
      task.status = "PAUSED";
      route = execution.route || "BLOCKED";
      completeWorkflow(task, "action", execution.message || execution.code);
      appendAgentOutput({ taskId, runId: run.id, stage: "action", level: "error", message: `动作未执行：${execution.message}`, data: { code: execution.code } });
    } else {
      task.status = task.stopLocked ? "MANUAL_CONTROL" : rulePaused ? "PAUSED" : "MONITORING";
      completeWorkflow(task, "action", execution.reason === "HOLD" ? "保持观望" : "已记录受控动作");
      appendAgentOutput({ taskId, runId: run.id, stage: "action", message: execution.reason === "HOLD" ? "决策为 HOLD，无需动作" : "建议已记录，等待确认" });
    }
    const analysis = {
      id: run.id,
      taskId,
      round: task.monitoringRound,
      trigger,
      market: task.market,
      evidence,
      decision: task.decision,
      coverage: analysisCoverage,
      segmentReviews,
      route,
      createdAt: new Date().toISOString(),
    };
    state.analyses.unshift(analysis);
    if (state.analyses.length > 200) state.analyses.length = 200;
    persistAnalysis(analysis);
    finishAgentRun(run.id, { status: "completed", action: task.decision.action, route, code: execution.code || route });
    if (monitoringIntent(task)) setNextPoll(task);
    persistTask(task);
    return { task, market: task.market, evidence, execution, run, route, analysisTriggered: true };
  } catch (error) {
    if (error instanceof CycleAbortError) {
      return error.code === "STOP_LOCKED"
        ? stoppedRunResult(task, run, task.market)
        : invalidatedRunResult(taskId, run, task.market);
    }
    task.monitorFailureCount = Number(task.monitorFailureCount || 0) + 1;
    task.status = task.stopLocked ? "MANUAL_CONTROL" : "PAUSED";
    if (monitoringIntent(task)) setNextPoll(task, monitorRetryDelay(task));
    appendAgentOutput({ taskId, runId: run.id, stage: "system", level: "error", message: `分析异常：${error.message}` });
    finishAgentRun(run.id, { status: "error", code: error.message });
    addEvent("analysis_paused", `分析异常，已暂停自动动作：${error.message}`, { taskId, runId: run.id });
    persistTask(task);
    throw error;
  } finally {
    activeCycles.delete(taskId);
    notifyCycleIdle(taskId);
    if (taskGeneration(task) === generation && !task.stopLocked) {
      task.updatedAt = new Date().toISOString();
      persistTask(task);
    }
  }
}

export async function runMonitoringCycle(taskId, { providerId = "", userId = "", runtime = {} } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (!monitoringIntent(task)) return { task, skipped: true, reason: "MONITORING_STOPPED" };
  const generation = taskGeneration(task);
  if (task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= Date.now()) {
    task.status = "PAUSED";
    task.decision = holdDecision("LEASE_EXPIRED", "监控租约已恢复，等待下一轮只读检查");
    addEvent("lease_expired", "任务租约曾过期，已锁定交易动作并恢复只读监控", { taskId });
  }
  renewLease(task);
  const result = await runAnalysis(taskId, providerId || task.providerId || "", {
    trigger: "controller",
    userId: userId || userIdsForTask(taskId)[0] || "",
    skipIfUnchanged: true,
    runtime,
  });
  const current = getTask(taskId);
  if (!current || taskGeneration(current) !== generation || current.stopLocked) {
    return { ...result, task: current || task, market: result.market || current?.market || null };
  }
  if (result.skipped && result.reason === "CYCLE_IN_PROGRESS") {
    if (monitoringIntent(task)) setNextPoll(task, monitoringPollIntervalMs(task));
    persistTask(task);
    return { ...result, market: result.market || task.market || null, route: "CYCLE_IN_PROGRESS", analysisTriggered: false };
  }
  const failed = result.market?.ok !== true || result.task.lastAnalysisSucceeded === false || ["REAUTH_REQUIRED", "CONNECT_FAILED", "COLLECT_FAILED"].includes(result.route);
  task.monitorFailureCount = failed ? Math.max(1, Number(task.monitorFailureCount || 0)) : 0;
  if (monitoringIntent(task)) setNextPoll(task, failed ? monitorRetryDelay(task) : monitoringPollIntervalMs(task));
  persistTask(task);
  return result;
}

function scheduleController(taskId, delayMs) {
  const entry = controllerLoops.get(taskId);
  if (!entry || entry.stopped || entry.timer) return;
  const task = getTask(taskId);
  if (!monitoringIntent(task)) {
    stopController(taskId);
    return;
  }
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    if (entry.stopped || controllerLoops.get(taskId) !== entry) return;
    const scheduledTask = getTask(taskId);
    if (!scheduledTask || taskGeneration(scheduledTask) !== entry.generation || scheduledTask.stopLocked) {
      stopController(taskId);
      return;
    }
    entry.running = true;
    try {
      await entry.runCycle(taskId);
    } catch (error) {
      const current = getTask(taskId);
      if (current && taskGeneration(current) === entry.generation && monitoringIntent(current)) {
        current.monitorFailureCount = Number(current.monitorFailureCount || 0) + 1;
        current.status = "PAUSED";
        setNextPoll(current, monitorRetryDelay(current));
        addEvent("analysis_retry_scheduled", `本轮失败，将继续重试：${error?.message || "未知错误"}`, { taskId, failureCount: current.monitorFailureCount });
        persistTask(current);
      }
    } finally {
      entry.running = false;
      if (controllerLoops.get(taskId) === entry && !entry.stopped) {
        const current = getTask(taskId);
        if (current && taskGeneration(current) === entry.generation && monitoringIntent(current)) {
          const nextPollAt = new Date(current.nextPollAt || "").getTime();
          const fallbackDelay = monitoringPollIntervalMs(current);
          scheduleController(taskId, Number.isFinite(nextPollAt) ? Math.max(0, nextPollAt - Date.now()) : fallbackDelay);
        }
        else stopController(taskId);
      }
    }
  }, Math.max(0, Number(delayMs) || 0));
}

export function startController(taskId, options = {}) {
  if (controllerLoops.has(taskId)) return;
  const task = getTask(taskId);
  if (!monitoringIntent(task)) return;
  const runCycle = typeof options.runCycle === "function"
    ? options.runCycle
    : (id) => runMonitoringCycle(id, { providerId: options.providerId, userId: options.userId, runtime: options.runtime });
  const entry = { timer: null, running: false, stopped: false, generation: taskGeneration(task), runCycle };
  controllerLoops.set(taskId, entry);
  const persistedNextPoll = new Date(task.nextPollAt || "").getTime();
  scheduleController(taskId, Number.isFinite(persistedNextPoll) ? Math.max(0, persistedNextPoll - Date.now()) : 0);
}

export function stopController(taskId) {
  const entry = controllerLoops.get(taskId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  controllerLoops.delete(taskId);
}

export function stopAllControllers() {
  for (const taskId of [...controllerLoops.keys()]) stopController(taskId);
}
