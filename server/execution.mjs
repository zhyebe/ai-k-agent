import crypto from "node:crypto";
import { adapterCanExecute } from "./connectors.mjs";
import { addEvent, persistOrder, persistTask, state } from "./store.mjs";

export const executionLimits = Object.freeze({ maxPositionPct: 30, maxOrderValuePct: 8 });

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export function executeDecision(task, decision, connector) {
  if (task.stopLocked) return { ok: false, code: "STOP_LOCKED", message: "任务已停止，服务端禁止新动作" };
  if (decision.action === "HOLD") return { ok: true, skipped: true, reason: "HOLD" };
  if (task.mode === "LIVE") {
    addEvent("live_blocked", "实盘动作未启用：当前版本只允许模拟盘或影子交易", { taskId: task.id, action: decision.action });
    return { ok: false, code: "LIVE_EXECUTION_DISABLED", message: "实盘执行需要经审核的目标适配器和独立策略门禁" };
  }
  if (!connector || !adapterCanExecute(connector.adapterId, task.mode)) {
    addEvent("action_blocked", "目标适配器未审核，动作保持受控状态", { taskId: task.id, adapterId: connector?.adapterId || "" });
    return { ok: false, code: "ADAPTER_REVIEW_REQUIRED", message: "目标适配器未审核或不支持当前运行模式" };
  }
  const targetPositionPct = clamp(decision.targetPositionPct, 0, 100);
  const maxOrderValuePct = clamp(decision.maxOrderValuePct, 0, 100);
  if (targetPositionPct > executionLimits.maxPositionPct || maxOrderValuePct > executionLimits.maxOrderValuePct) {
    addEvent("risk_limit_blocked", "动作超过服务端硬风控上限，已拒绝执行", { taskId: task.id, targetPositionPct, maxOrderValuePct, limits: executionLimits });
    return { ok: false, code: "RISK_LIMIT_EXCEEDED", message: "动作超过服务端仓位或单笔金额上限", limits: executionLimits };
  }
  const idempotencyKey = `${task.id}:${decision.createdAt}:${decision.action}`;
  const existing = state.orders.find((order) => order.idempotencyKey === idempotencyKey);
  if (existing) return { ok: true, duplicate: true, order: existing };
  const order = {
    id: `order_${crypto.randomUUID()}`,
    idempotencyKey,
    taskId: task.id,
    symbol: task.symbol,
    action: decision.action,
    mode: task.mode,
    status: task.mode === "PAPER" ? "SIMULATED" : "SHADOW_RECORDED",
    targetPositionPct,
    maxOrderValuePct,
    createdAt: new Date().toISOString(),
  };
  state.orders.unshift(order);
  if (state.orders.length > 200) state.orders.length = 200;
  task.metrics.exposurePct = order.targetPositionPct;
  persistOrder(order);
  persistTask(task);
  addEvent(task.mode === "PAPER" ? "paper_order" : "shadow_order", `${task.mode === "PAPER" ? "模拟盘" : "影子交易"}${decision.action === "BUY" ? "买入" : "卖出"}动作已记录`, { taskId: task.id, order });
  return { ok: true, order };
}
