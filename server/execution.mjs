import { addEvent } from "./store.mjs";

export const executionLimits = Object.freeze({ maxPositionPct: 30, maxOrderValuePct: 8 });
export const tradingExecutionPolicy = Object.freeze({ enabled: true, mode: "CONFIRM_THEN_SUBMIT" });
export const DEFAULT_AUTO_DECISION_COUNTDOWN_SEC = 30;

export function isTradingSwitchOn() {
  return process.env.AXIOM_TRADING_ENABLED !== "0";
}

export function isLiveTask(task) {
  return String(task?.mode || "") === "LIVE";
}

export function shouldSubmitLiveOrder(task, source = "manual_confirm") {
  return isLiveTask(task)
    && source === "manual_confirm"
    && task?.stopLocked !== true
    && isTradingSwitchOn();
}

function normalizedTargetValues(value) {
  return [value?.symbol, value?.symbolName, value?.instrumentId]
    .map((item) => String(item || "").trim().toLocaleLowerCase())
    .filter(Boolean);
}

export function previewMarketForDecision(task, decision) {
  const books = Array.isArray(task?.market?.books) ? task.market.books.filter(Boolean) : [];
  const target = new Set(normalizedTargetValues({
    symbol: decision?.targetSymbol,
    symbolName: decision?.targetSymbolName,
    instrumentId: decision?.targetInstrumentId,
  }));
  if (target.size) {
    const matched = books.find((book) => normalizedTargetValues(book).some((value) => target.has(value)));
    if (matched) return matched;
  }
  return books.length === 1 ? books[0] : task?.market;
}

export function suggestOrderPreview(task, decision) {
  const targetMarket = previewMarketForDecision(task, decision);
  const price = Number(targetMarket?.latest?.price ?? targetMarket?.quote?.price);
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
    targetSymbol: String(decision?.targetSymbol || targetMarket?.symbol || ""),
    targetSymbolName: String(decision?.targetSymbolName || targetMarket?.symbolName || ""),
    targetInstrumentId: String(decision?.targetInstrumentId || targetMarket?.instrumentId || ""),
  };
}

export function executeDecision(task, decision, connector) {
  if (task.stopLocked) return { ok: false, code: "STOP_LOCKED", message: "任务已停止，服务端禁止新动作" };
  if (decision.action === "HOLD") return { ok: true, skipped: true, reason: "HOLD", route: "HOLD", executionEnabled: false, orderCreated: false };
  const preview = suggestOrderPreview(task, decision);
  const live = isLiveTask(task) && isTradingSwitchOn();
  addEvent("suggestion_ready", live
    ? "买卖建议已生成，等待弹窗确认后才会下单"
    : "买卖建议已生成，等待确认；当前模式不会提交实盘", {
    taskId: task.id,
    action: decision.action,
    targetSymbol: decision.targetSymbol || "",
    targetSymbolName: decision.targetSymbolName || "",
    targetInstrumentId: decision.targetInstrumentId || "",
    mode: task.mode,
    connectorId: connector?.adapterId || "",
    autoDecisionEnabled: task.autoDecisionEnabled === true,
  });
  return {
    ok: true,
    skipped: true,
    reason: "PENDING_CONFIRM",
    code: "SUGGESTION_PENDING",
    message: live ? "建议已生成，等待弹窗确认后下单" : "建议已生成，等待确认；观察模式不会下单",
    route: "SUGGESTION_PENDING",
    executionEnabled: false,
    orderCreated: false,
    writeRequestSent: false,
    action: decision.action,
    suggestedPrice: preview.suggestedPrice,
    suggestedQty: preview.suggestedQty,
  };
}
