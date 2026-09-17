import { addEvent } from "./store.mjs";

export const executionLimits = Object.freeze({ maxPositionPct: 30, maxOrderValuePct: 8 });
export const tradingExecutionPolicy = Object.freeze({ enabled: true, mode: "CONFIRM_THEN_SUBMIT" });
export const DEFAULT_AUTO_DECISION_COUNTDOWN_SEC = 30;
export const MAX_AUTOMATED_QUANTITY = 20;
export const TEST_AUTOMATED_QUANTITY = 1;

export function automatedQuantityLimit(task) {
  return task?.automationTestMode === false ? MAX_AUTOMATED_QUANTITY : TEST_AUTOMATED_QUANTITY;
}

export function isTradingSwitchOn() {
  return process.env.AXIOM_TRADING_ENABLED !== "0";
}

export function isLiveTask(task) {
  return String(task?.mode || "") === "LIVE";
}

export function shouldSubmitLiveOrder(task, source = "manual_confirm") {
  return isLiveTask(task)
    && (source === "manual_confirm" || (source === "auto_timeout" && task?.autoDecisionEnabled === true))
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

export function suggestOrderPreview(task, decision, { enforceAutomationQuantity = false } = {}) {
  const targetMarket = previewMarketForDecision(task, decision);
  const requestedPrice = decision?.orderType === "LIMIT" ? Number(decision?.targetPrice) : NaN;
  const price = Number.isFinite(requestedPrice) && requestedPrice > 0
    ? requestedPrice
    : Number(targetMarket?.latest?.price ?? targetMarket?.quote?.price);
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
  const positions = Array.isArray(task?.market?.account?.positions) ? task.market.account.positions : [];
  const targetIds = new Set(Array.isArray(decision?.targetPositionIds) ? decision.targetPositionIds.map(String) : []);
  const openPositions = positions.filter((position) => Number(position?.quantity) > 0);
  const targetPosition = decision?.exitType && (
    openPositions.find((position) => {
      if (targetIds.size && targetIds.has(String(position?.positionOrderId || ""))) return true;
      return [position?.symbol, position?.symbolName, position?.positionOrderId].some((value) => String(value || "") && normalizedTargetValues(decision).includes(String(value).trim().toLocaleLowerCase()));
    }) || openPositions[0]
  );
  if (decision?.exitType && Number(targetPosition?.quantity) > 0) {
    suggestedQty = Number(targetPosition.quantity);
  } else if (hasPrice && Number.isFinite(equity) && equity > 0 && pct > 0) {
    suggestedQty = Math.max(1, Math.floor((equity * (pct / 100)) / price));
  } else if (hasPrice) {
    suggestedQty = 1;
  }
  const quantityLimit = automatedQuantityLimit(task);
  const quantityLimitApplied = enforceAutomationQuantity && suggestedQty !== null && suggestedQty > quantityLimit;
  if (quantityLimitApplied) suggestedQty = quantityLimit;
  return {
    action: decision?.action === "SELL" ? "SELL" : decision?.action === "BUY" ? "BUY" : "HOLD",
    exitType: decision?.exitType || null,
    orderType: decision?.orderType === "LIMIT" ? "LIMIT" : "MARKET",
    targetPositionIds: Array.isArray(decision?.targetPositionIds) ? decision.targetPositionIds : [],
    targetPrice: Number.isFinite(requestedPrice) && requestedPrice > 0 ? requestedPrice : null,
    suggestedPrice: hasPrice ? price : null,
    suggestedQty,
    quantityLimitApplied,
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
  const auto = task.autoDecisionEnabled === true;
  addEvent("suggestion_ready", live
    ? (auto ? "分析通过，全自动接管将直接下单或离场" : "买卖建议已生成，等待确认后才会下单或离场")
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
    message: live
      ? (auto ? "分析通过，全自动接管将直接执行" : "建议已生成，等待确认后下单或离场")
      : "建议已生成，等待确认；观察模式不会下单",
    route: "SUGGESTION_PENDING",
    executionEnabled: false,
    orderCreated: false,
    writeRequestSent: false,
    action: decision.action,
    suggestedPrice: preview.suggestedPrice,
    suggestedQty: preview.suggestedQty,
  };
}
