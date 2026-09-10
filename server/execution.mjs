import { addEvent } from "./store.mjs";

export const executionLimits = Object.freeze({ maxPositionPct: 30, maxOrderValuePct: 8 });
export const tradingExecutionPolicy = Object.freeze({ enabled: false, mode: "SUGGESTION_ONLY" });
export const DEFAULT_AUTO_DECISION_COUNTDOWN_SEC = 30;

export function suggestOrderPreview(task, decision) {
  const price = Number(task?.market?.latest?.price);
  const equity = Number(task?.metrics?.equity || task?.market?.account?.availableFunds || 0);
  const requestedPct = Number(decision?.targetPositionPct || 0);
  const orderPct = Number(decision?.maxOrderValuePct || executionLimits.maxOrderValuePct);
  const pct = Math.min(
    requestedPct > 0 ? requestedPct : orderPct,
    orderPct > 0 ? orderPct : executionLimits.maxOrderValuePct,
    executionLimits.maxOrderValuePct,
  );
  const hasPrice = Number.isFinite(price) && price > 0;
  let suggestedQty = null;
  if (hasPrice && Number.isFinite(equity) && equity > 0 && pct > 0) {
    suggestedQty = Math.max(1, Math.floor((equity * (pct / 100)) / price));
  } else if (hasPrice) {
    suggestedQty = 1;
  }
  return {
    action: decision?.action === "SELL" ? "SELL" : decision?.action === "BUY" ? "BUY" : "HOLD",
    suggestedPrice: hasPrice ? price : null,
    suggestedQty,
    valuePct: pct,
    formSubmitBlocked: true,
  };
}

export function executeDecision(task, decision, connector) {
  if (task.stopLocked) return { ok: false, code: "STOP_LOCKED", message: "任务已停止，服务端禁止新动作" };
  if (decision.action === "HOLD") return { ok: true, skipped: true, reason: "HOLD", route: "HOLD", executionEnabled: tradingExecutionPolicy.enabled, orderCreated: false };
  const preview = suggestOrderPreview(task, decision);
  addEvent("automation_disabled", "买卖意图已记录为待确认建议，服务端禁止创建订单、调用交易写接口或点击交易控件", { taskId: task.id, action: decision.action, mode: task.mode, automationAuthorized: task.automationAuthorized === true, autoDecisionEnabled: task.autoDecisionEnabled === true });
  return {
    ok: false,
    code: "TRADING_DISABLED",
    message: "建议已生成，等待确认提交；测试阶段不会点击交易按钮",
    route: "SUGGESTION_PENDING",
    executionEnabled: tradingExecutionPolicy.enabled,
    orderCreated: false,
    writeRequestSent: false,
    action: decision.action,
    suggestedPrice: preview.suggestedPrice,
    suggestedQty: preview.suggestedQty,
  };
}
