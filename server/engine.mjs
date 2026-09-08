import { requestDecision } from "./provider.mjs";
import { searchKnowledge } from "./rag.mjs";
import { executeDecision } from "./execution.mjs";
import { observeMarket } from "./market.mjs";
import { credentialExists } from "./vault.mjs";
import { addEvent, getConnector, getTask, persistTask, state } from "./store.mjs";

const activeCycles = new Set();
const controllerLoops = new Map();

function transitionWorkflow(task, activeKey) {
  task.workflow = task.workflow.map((step) => {
    if (step.key === activeKey) return { ...step, status: "active" };
    const index = task.workflow.findIndex((item) => item.key === step.key);
    const activeIndex = task.workflow.findIndex((item) => item.key === activeKey);
    return { ...step, status: index < activeIndex ? "complete" : "pending" };
  });
}

function startupChecks(task) {
  const credentialReady = task.target.credentialStatus === "已托管"
    && (task.target.credentialRef === "credential:demo" || credentialExists(task.target.credentialRef));
  return [
    { key: "target", label: "目标连接", passed: task.target.connectionStatus === "connected" },
    { key: "credentials", label: "凭据托管", passed: credentialReady },
    { key: "risk", label: "风控配置", passed: Boolean(task.riskProfile) },
    { key: "mode", label: "模拟/实盘模式", passed: task.mode === "PAPER" || task.mode === "SHADOW" },
    { key: "adapter", label: "目标适配器", passed: Boolean(task.target.connectorId) },
  ];
}

export function startTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (["MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING", "STARTING"].includes(task.status)) return task;
  const checks = startupChecks(task);
  const failed = checks.filter((check) => !check.passed);
  if (failed.length) {
    task.status = "BLOCKED";
    addEvent("startup_blocked", `启动检查未通过：${failed.map((item) => item.label).join("、")}`, { taskId, checks });
    persistTask(task);
    return task;
  }
  task.status = "STARTING";
  task.stopLocked = false;
  transitionWorkflow(task, "connect");
  addEvent("task_starting", "开始启动检查，正在恢复账户现场", { taskId });
  task.status = "MONITORING";
  task.heartbeatAt = new Date().toISOString();
  task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  transitionWorkflow(task, "analyze");
  task.updatedAt = new Date().toISOString();
  addEvent("task_monitoring", "启动检查通过，Agent 已进入持续监控", { taskId });
  persistTask(task);
  startController(taskId);
  return task;
}

export function stopTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (task.status === "MANUAL_CONTROL" && task.stopLocked) return task;
  task.stopLocked = true;
  stopController(taskId);
  task.status = "STOPPING";
  addEvent("stop_requested", "已阻断新决策和新订单，开始撤单与对账", { taskId });
  task.workflow = task.workflow.map((step) => ({
    ...step,
    status: step.key === "connect" || step.key === "login" ? "complete" : "pending",
  }));
  task.status = "MANUAL_CONTROL";
  task.target.connectionStatus = "connected";
  task.updatedAt = new Date().toISOString();
  addEvent("manual_control", "撤单与对账完成，已切换人工接管；现有持仓未自动平仓", { taskId });
  persistTask(task);
  return task;
}

export function claimManual(taskId) {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  task.stopLocked = true;
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

export async function runAnalysis(taskId, providerId = "provider_deepseek") {
  const task = getTask(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  if (activeCycles.has(taskId)) return { task, skipped: true, reason: "CYCLE_IN_PROGRESS" };
  activeCycles.add(taskId);
  try {
    if (task.stopLocked) return { task, skipped: true, reason: "STOP_LOCKED" };
    task.status = "ANALYZING";
    transitionWorkflow(task, "analyze");
    const connector = getConnector(task.target.connectorId);
    const market = observeMarket(task, connector);
    if (!market.ok) {
      task.decision = { action: "HOLD", confidence: 0, targetPositionPct: 0, maxOrderValuePct: 0, reasonCodes: [], evidenceIds: [], invalidation: "适配器审核或数据恢复后重试", riskFlags: [market.code], createdAt: new Date().toISOString(), ttlSec: 300 };
      task.status = "PAUSED";
      transitionWorkflow(task, "collect");
      addEvent("market_paused", `数据采集暂停：${market.message}`, { taskId, code: market.code });
      persistTask(task);
      return { task, market };
    }
    task.market = market;
    task.workflow = task.workflow.map((step) => step.key === "collect" ? { ...step, status: "complete", detail: `${market.historyCount} 根 K 线 · ${market.source}` } : step);
    const anomalyRule = task.rules.find((rule) => rule.mode === "BLOCK");
    if (anomalyRule) {
      anomalyRule.status = market.anomaly ? "pending" : "standby";
      anomalyRule.detail = market.anomaly ? "ATR 异常放大，自动动作已锁定" : "未触发";
    }
    const knowledge = searchKnowledge(`${task.symbol} ${task.timeframe} ${market.trend} 趋势 突破 回撤`, { tag: task.symbol }, 4);
    const evidence = [{ evidenceId: market.evidenceId, type: "market_snapshot", excerpt: `${market.symbol} ${market.timeframe} ${market.trend} · EMA20 ${market.indicators.ema20} · RSI ${market.indicators.rsi14}` }, ...knowledge];
    const provider = state.providers.find((item) => item.id === providerId);
    const decision = await requestDecision(provider, {
      market,
      account: task.metrics,
      rules: task.rules,
      evidence: evidence.map(({ evidenceId, type, excerpt, chunkId, skillId, version, title, score }) => ({ evidenceId, type, excerpt, chunkId, skillId, version, title, score })),
      evidenceIds: evidence.map((item) => item.evidenceId),
    });
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    const invalidEvidenceReference = decision.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId));
    decision.evidenceIds = decision.evidenceIds.filter((evidenceId) => evidenceIds.has(evidenceId));
    if (invalidEvidenceReference) {
      decision.action = "HOLD";
      decision.riskFlags = [...(decision.riskFlags || []), "INVALID_EVIDENCE_REFERENCE"];
    }
    if (task.stopLocked || task.status === "MANUAL_CONTROL") {
      task.decision = { action: "HOLD", confidence: 0, targetPositionPct: 0, maxOrderValuePct: 0, reasonCodes: [], evidenceIds: [market.evidenceId], invalidation: "任务已停止或人工接管", riskFlags: ["STOP_LOCKED"], createdAt: new Date().toISOString(), ttlSec: 300 };
      return { task, evidence, skipped: true, reason: "STOP_LOCKED" };
    }
    task.decision = { ...decision, createdAt: new Date().toISOString(), ttlSec: decision.decisionTtlSec };
    task.status = "RISK_CHECK";
    transitionWorkflow(task, "rules");
    const blocked = task.rules.some((rule) => rule.status === "pending" && rule.mode === "BLOCK");
    const reviewRequired = task.rules.some((rule) => rule.status === "pending" && rule.mode === "REVIEW");
    if (blocked || reviewRequired || decision.action === "HOLD" || decision.riskFlags.includes("INVALID_EVIDENCE_REFERENCE")) {
      task.decision.action = "HOLD";
      task.decision.riskFlags = [...(decision.riskFlags || []), ...(blocked ? ["RED_LINE_TRIGGERED"] : []), ...(reviewRequired ? ["HUMAN_REVIEW_REQUIRED"] : [])];
      task.status = blocked || reviewRequired ? "PAUSED" : "MONITORING";
      addEvent("decision_held", blocked ? "红线规则触发，已暂停自动执行" : reviewRequired ? "规则要求人工处理，已暂停自动执行" : decision.riskFlags.includes("INVALID_EVIDENCE_REFERENCE") ? "模型证据引用无效，已保持 HOLD" : "决策保持 HOLD，继续监控", { taskId, evidence });
      persistTask(task);
      return { task, evidence };
    }
    task.status = "EXECUTING";
    transitionWorkflow(task, "action");
    const execution = executeDecision(task, decision, connector);
    if (!execution.ok) {
      task.decision.action = "HOLD";
      task.decision.riskFlags = [...(decision.riskFlags || []), execution.code];
      task.status = "PAUSED";
      addEvent("action_paused", `动作未执行，任务已暂停：${execution.message}`, { taskId, code: execution.code, evidence });
      persistTask(task);
      return { task, evidence, execution };
    }
    task.status = "MONITORING";
    transitionWorkflow(task, "analyze");
    persistTask(task);
    return { task, evidence };
  } finally {
    activeCycles.delete(taskId);
    task.updatedAt = new Date().toISOString();
    persistTask(task);
  }
}

export function startController(taskId) {
  if (controllerLoops.has(taskId)) return;
  const timer = setInterval(async () => {
    const task = getTask(taskId);
    if (!task || task.stopLocked || !["MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING"].includes(task.status)) {
      stopController(taskId);
      return;
    }
    if (task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= Date.now()) {
      task.stopLocked = true;
      task.status = "PAUSED";
      addEvent("lease_expired", "任务租约已过期，自动动作已锁定", { taskId });
      persistTask(task);
      stopController(taskId);
      return;
    }
    task.heartbeatAt = new Date().toISOString();
    task.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    if (!task.lastHeartbeatEventAt || Date.now() - new Date(task.lastHeartbeatEventAt).getTime() > 60000) {
      task.lastHeartbeatEventAt = task.heartbeatAt;
      addEvent("controller_heartbeat", "任务租约已续期，服务端监控保持在线", { taskId, leaseExpiresAt: task.leaseExpiresAt });
    }
    if (!task.lastAnalysisAt || Date.now() - new Date(task.lastAnalysisAt).getTime() > 60000) {
      task.lastAnalysisAt = task.heartbeatAt;
      await runAnalysis(taskId).catch((error) => {
        task.status = "PAUSED";
        addEvent("analysis_paused", `分析异常，已暂停自动动作：${error.message}`, { taskId });
        persistTask(task);
      });
    }
  }, 15000);
  controllerLoops.set(taskId, timer);
}

export function stopController(taskId) {
  const timer = controllerLoops.get(taskId);
  if (!timer) return;
  clearInterval(timer);
  controllerLoops.delete(taskId);
}

export function stopAllControllers() {
  for (const taskId of controllerLoops.keys()) stopController(taskId);
}
