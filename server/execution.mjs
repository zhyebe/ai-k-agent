import { addEvent } from "./store.mjs";

export const executionLimits = Object.freeze({ maxPositionPct: 30, maxOrderValuePct: 8 });
export const tradingExecutionPolicy = Object.freeze({ enabled: true, mode: "CONFIRM_THEN_SUBMIT" });
export const DEFAULT_AUTO_DECISION_COUNTDOWN_SEC = 30;
export const MAX_LIVE_ENTRY_QUANTITY = 1;

export function isTradingSwitchOn() {
  return process.env.AXIOM_TRADING_ENABLED !== "0";
}

export function isLiveTask(task) {
  return String(task?.mode || "") === "LIVE";
}

export function isAutomaticAction(task, decision = task?.pendingAction || task?.decision) {
  return task?.autoDecisionEnabled === true
    || (isLiveTask(task) && ["TAKE_PROFIT", "STOP_LOSS"].includes(decision?.exitType));
}

export function shouldSubmitLiveOrder(task, source = "manual_confirm") {
  return isLiveTask(task)
    && task?.stopLocked !== true
    && isAutomaticAction(task)
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

export function suggestOrderPreview(task, decision, { enforceQuantityLimit = false } = {}) {
  const targetMarket = previewMarketForDecision(task, decision);
  const modelPrice = decision?.exitType === "TAKE_PROFIT"
    ? decision?.takeProfitPrice
    : decision?.exitType === "STOP_LOSS"
      ? decision?.stopLossPrice
      : decision?.targetPrice ?? decision?.entryPrice;
  const requestedPrice = decision?.orderType === "LIMIT" ? Number(modelPrice) : NaN;
  const price = Number.isFinite(requestedPrice) && requestedPrice > 0
    ? requestedPrice
    : Number(targetMarket?.latest?.price ?? targetMarket?.quote?.price);
  const equity = Number(task?.metrics?.equity || task?.market?.account?.availableFunds || 0);
  const requestedPct = Number(decision?.targetPositionPct || 0);
  const orderPct = Number(decision?.maxOrderValuePct || executionLimits.maxOrderValuePct);
  const requestedValuePct = requestedPct > 0 && orderPct > 0
    ? Math.min(requestedPct, orderPct)
    : requestedPct > 0 ? requestedPct : orderPct > 0 ? orderPct : 0;
  const pct = String(task?.mode || "") === "LIVE"
    ? requestedValuePct
    : Math.min(requestedValuePct, executionLimits.maxOrderValuePct);
  const hasPrice = Number.isFinite(price) && price > 0;
  let suggestedQty = null;
  const positions = Array.isArray(task?.market?.account?.positions) ? task.market.account.positions : [];
  const targetIds = new Set(Array.isArray(decision?.targetPositionIds) ? decision.targetPositionIds.map(String) : []);
  const targetValues = normalizedTargetValues({ symbol: decision?.targetSymbol, symbolName: decision?.targetSymbolName, instrumentId: decision?.targetInstrumentId });
  const openPositions = positions.filter((position) => Number(position?.quantity) > 0);
  const targetMatches = decision?.exitType
    ? openPositions.filter((position) => targetIds.size
      ? targetIds.has(String(position?.positionOrderId || ""))
      : [position?.symbol, position?.symbolName, position?.instrumentId].some((value) => String(value || "") && targetValues.includes(String(value).trim().toLocaleLowerCase())))
    : [];
  const targetQuantity = targetMatches.reduce((sum, position) => sum + Number(position?.quantity || 0), 0);
  if (decision?.exitType && targetQuantity > 0) {
    suggestedQty = targetQuantity;
  } else if (!decision?.exitType && hasPrice && Number.isFinite(equity) && equity > 0 && pct > 0) {
    suggestedQty = Math.max(1, Math.floor((equity * (pct / 100)) / price));
  } else if (!decision?.exitType && hasPrice) {
    suggestedQty = 1;
  }
  const quantityLimitApplied = enforceQuantityLimit && !decision?.exitType && suggestedQty !== null && suggestedQty > MAX_LIVE_ENTRY_QUANTITY;
  if (quantityLimitApplied) suggestedQty = MAX_LIVE_ENTRY_QUANTITY;
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
  const auto = isAutomaticAction(task, decision);
  addEvent("suggestion_ready", live
    ? (auto ? "分析通过，全自动接管将直接下单或离场" : "买卖建议已生成，AI 填表后由用户在目标页提交")
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
      ? (auto ? "分析通过，全自动接管将直接执行" : "建议已生成，等待用户在目标页提交")
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
