import { summarizeOrderBook } from "./order-book.mjs";
import { effectiveTradingSession } from "./trading-session.mjs";

export const DEFAULT_SESSION_CLOSE = Object.freeze({ leadMinutes: 5, timezone: "Asia/Shanghai" });
export const POSITION_MIN_PROFIT_POINTS = 1;
export const POSITION_MAX_PROFIT_POINTS = 4;

export function parseSessionClose(value = DEFAULT_SESSION_CLOSE) {
  if (!value || typeof value !== "object") return null;
  const leadMinutes = Number(value.leadMinutes);
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 24 * 60) return null;
  if (value.timezone !== undefined && value.timezone !== "Asia/Shanghai") return null;
  return { leadMinutes, timezone: "Asia/Shanghai" };
}

export function sessionCloseWindow(task, now = Date.now()) {
  const config = parseSessionClose(task?.sessionClose) || DEFAULT_SESSION_CLOSE;
  const closesAt = Date.parse(effectiveTradingSession(task?.tradingSession, now).closesAt);
  const startsAt = closesAt - config.leadMinutes * 60000;
  const date = new Date(closesAt + 8 * 3600000).toISOString().slice(0, 10);
  return { ...config, date, startsAt, closesAt, active: now >= startsAt, overdue: now >= closesAt };
}

export function heldDirection(position) {
  if (/卖|空|short/i.test(String(position?.side || ""))) return "SHORT";
  if (/买|多|long/i.test(String(position?.side || ""))) return "LONG";
  return "UNKNOWN";
}

function sameInstrument(a, b) {
  const values = (item) => [item?.symbol, item?.symbolName, item?.instrumentId].map(v => String(v || "").trim().toLowerCase()).filter(Boolean);
  const av = values(a);
  return values(b).some(v => av.includes(v));
}

function numericValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

export function positionEntryPrice(position) {
  const price = Number(position?.orderPrice ?? position?.entryPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function exitNetPnl(position, exitPrice) {
  const entryPrice = positionEntryPrice(position);
  const price = Number(exitPrice);
  const quantity = Number(position?.quantity || 0);
  if (entryPrice === null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) return null;
  const direction = heldDirection(position);
  if (direction !== "LONG" && direction !== "SHORT") return null;
  const gross = (direction === "LONG" ? price - entryPrice : entryPrice - price) * quantity;
  // Only explicitly supplied whole-position round-trip costs have this unit.
  // Missing cost data is unknown, never a claim that trading is free.
  const fees = numericValue(position?.roundTripFee, position?.totalFees);
  return { entryPrice, exitPrice: price, quantity, grossPnl: gross, netPnl: fees === null ? null : gross - fees, fees };
}

export function isNonLosingExit(position, exitPrice) {
  const pnl = exitNetPnl(position, exitPrice);
  if (!pnl) return false;
  const long = heldDirection(position) === "LONG";
  const breakEvenPrice = positionAmountTriggerPrice(pnl, long, 0);
  const minimumPrice = pnl.entryPrice + (long ? 1 : -1) * POSITION_MIN_PROFIT_POINTS;
  return long ? pnl.exitPrice >= Math.max(minimumPrice, breakEvenPrice) : pnl.exitPrice <= Math.min(minimumPrice, breakEvenPrice);
}

export function positionLossSignature(position = {}) {
  // The exact platform position ID survives full/quick snapshots whose symbol
  // aliases may differ. Direction, quantity and real entry cost must also agree.
  return JSON.stringify([position.positionOrderId, heldDirection(position), Number(position.quantity), positionEntryPrice(position)]);
}

export function isRecoveryExit(record, position, price, now = Date.now()) {
  const identity = position && positionLossSignature(position);
  if (!record?.recovered || record.signature !== identity || record.startedAt === null || record.netPnl === null || record.netPnl < 0
    || now < record.lastObservedAt || now - record.lastObservedAt > 15_000 || record.lastObservedAt < record.flashUntil) return false;
  const pnl = exitNetPnl({ ...position, roundTripFee: position.roundTripFee ?? position.totalFees ?? record.fees }, price);
  return pnl?.netPnl !== null && pnl?.netPnl >= 0;
}

function validProfitTarget(position, price) {
  if (!isNonLosingExit(position, price)) return false;
  const long = heldDirection(position) === "LONG";
  const ceiling = positionEntryPrice(position) + (long ? 1 : -1) * POSITION_MAX_PROFIT_POINTS;
  return long ? price <= ceiling : price >= ceiling;
}

export function executableExitQuote(market, position, now = Date.now()) {
  const book = (market.books || []).find(book => sameInstrument(book, position)) || (sameInstrument(market, position) ? market : null);
  const observedAt = Date.parse(book?.observedAt || market.observedAt || "");
  if (!Number.isFinite(observedAt) || now < observedAt || now - observedAt > 5000) return null;
  const depth = summarizeOrderBook(book?.orderBook || book?.pageView?.orderBook);
  if (depth.status === "CROSSED") return null;
  const direction = heldDirection(position);
  const quote = direction === "LONG" ? depth.bids[0] : direction === "SHORT" ? depth.asks[0] : null;
  return quote?.price > 0 && quote.volume > 0 ? { price: quote.price, volume: quote.volume, observedAt } : null;
}

function positionAmountTriggerPrice(pnl, long, amount) {
  return pnl.entryPrice + (long ? 1 : -1) * (amount + (pnl.fees ?? 0)) / pnl.quantity;
}

function positionExitCandidate(position, quote, pnl, now, exitType, triggerPrice, boundary) {
  const long = heldDirection(position) === "LONG";
  const profit = exitType === "TAKE_PROFIT";
  return {
    position, quotePrice: quote.price, grossPnl: pnl.grossPnl, netPnl: pnl.netPnl,
    decision: { action: long ? "SELL" : "BUY", orderType: "MARKET", exitType,
      targetPositionIds: [position.positionOrderId], targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      exitGuard: { positionId: position.positionOrderId, heldSide: long ? "LONG" : "SHORT", quantity: pnl.quantity,
        entryPrice: pnl.entryPrice, exitType, expiresAt: new Date(now + 10000).toISOString(),
        triggerPrice, comparison: boundary.positionPoints ? (long ? "GTE" : "LTE") : long === profit ? "GTE" : "LTE",
        ...boundary } },
  };
}

// AI chooses a realized profit point once the position reaches one favorable
// point. The host only supplies the hard four-point ceiling. Unknown fees stay
// unknown; known negative net PnL is never called profit.
export function positionProfitExit(position, market, now = Date.now()) {
  if (market.account?.positionsVerified !== true || !position?.positionOrderId || Number(position.frozenQuantity || 0) !== 0) return null;
  const quote = executableExitQuote(market, position, now);
  const pnl = quote && exitNetPnl(position, quote.price);
  if (!pnl) return null;
  const long = heldDirection(position) === "LONG";
  const ceiling = pnl.entryPrice + (long ? 1 : -1) * POSITION_MAX_PROFIT_POINTS;
  const atCeiling = long ? quote.price >= ceiling : quote.price <= ceiling;
  if (!atCeiling) return null;
  const profitable = isNonLosingExit(position, quote.price);
  return positionExitCandidate(position, quote, pnl, now, profitable ? "TAKE_PROFIT" : "STOP_LOSS", ceiling,
    { positionPoints: { threshold: POSITION_MAX_PROFIT_POINTS, fees: pnl.fees, programCeiling: true } });
}

export function positionAmountGuardAllowsPrice(guard, position, price) {
  if (guard?.positionAmount) return false; // Retired fixed-amount exits cannot resume after upgrade.
  const boundary = guard?.positionPoints;
  if (!boundary) return true;
  const profit = guard.exitType === "TAKE_PROFIT";
  if (boundary.threshold !== (profit ? POSITION_MIN_PROFIT_POINTS : POSITION_MAX_PROFIT_POINTS)
    && !(boundary.programCeiling === true && boundary.threshold === POSITION_MAX_PROFIT_POINTS)
    || (!profit && guard.exitType !== "STOP_LOSS")
    || !position || position.positionOrderId !== guard.positionId || heldDirection(position) !== guard.heldSide
    || Number(position.quantity) !== guard.quantity || Number(position.frozenQuantity || 0) !== 0
    || positionEntryPrice(position) !== guard.entryPrice) return false;
  // Keep already verified costs when a subsequent DOM snapshot omits them.
  const fees = numericValue(position.roundTripFee, position.totalFees, boundary.fees);
  const pnl = exitNetPnl({ ...position, roundTripFee: fees }, price);
  if (!pnl) return false;
  const long = guard.heldSide === "LONG";
  if (profit) {
    if (boundary.programCeiling === true) {
      const ceiling = pnl.entryPrice + (long ? 1 : -1) * POSITION_MAX_PROFIT_POINTS;
      if (!(long ? pnl.exitPrice >= ceiling : pnl.exitPrice <= ceiling)) return false;
    }
    return isNonLosingExit({ ...position, roundTripFee: fees }, price);
  }
  const ceiling = pnl.entryPrice + (long ? 1 : -1) * POSITION_MAX_PROFIT_POINTS;
  return pnl.netPnl !== null && pnl.netPnl < 0 && (long ? pnl.exitPrice >= ceiling : pnl.exitPrice <= ceiling);
}

export function normalizeExitPlans(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    positionId: String(item?.position_id ?? item?.positionId ?? "").trim(),
    heldSide: String(item?.held_side ?? item?.heldSide ?? ""),
    quantity: Number(item?.quantity),
    validForSec: Number(item?.valid_for_sec ?? item?.validForSec),
    takeProfitPrice: item?.take_profit_price ?? item?.takeProfitPrice ?? null,
    stopLossPrice: item?.stop_loss_price ?? item?.stopLossPrice ?? null,
    ...((item?.realtime_take_profit ?? item?.realtimeTakeProfit) ? { realtimeTakeProfit: normalizeRealtimeTakeProfit(item.realtime_take_profit ?? item.realtimeTakeProfit) } : {}),
    rationale: String(item?.rationale ?? "").slice(0, 1000),
  }));
}

function normalizeRealtimeTakeProfit(value) {
  if (!value || typeof value !== "object") return null;
  return { valueAbove: value.value_above ?? value.valueAbove ?? null, takeProfitPrice: value.take_profit_price ?? value.takeProfitPrice ?? null };
}

export function validateExitPlans(decision, market, task, now = Date.now()) {
  const plans = [];
  const rejected = [];
  const observedAt = Date.parse(market.observedAt || "");
  const closing = sessionCloseWindow(task, now);
  const seen = new Set();
  for (const source of normalizeExitPlans(decision.exitPlans)) {
    const position = market.account?.positions?.find(p => p.positionOrderId === source.positionId);
    const recovery = task?.lossObservations?.[source.positionId];
    let tp = source.takeProfitPrice === null ? null : Number(source.takeProfitPrice);
    const sl = source.stopLossPrice === null ? null : Number(source.stopLossPrice);
    let realtime = source.realtimeTakeProfit;
    if (realtime) {
      const valueAbove = Number(realtime.valueAbove);
      const price = Number(realtime.takeProfitPrice);
      if (realtime.valueAbove === null || !Number.isFinite(valueAbove) || valueAbove < 0
        || !Number.isFinite(price) || price <= 0 || !validProfitTarget(position, price)
        || (sl !== null && (source.heldSide === "LONG" ? price <= sl : price >= sl))) {
        rejected.push({ positionId: source.positionId, code: "EXIT_PLAN_REALTIME_PROFIT_INVALID" });
        realtime = null;
      } else realtime = { valueAbove, takeProfitPrice: price };
    }
    const expiresAt = Math.min(observedAt + source.validForSec * 1000, closing.startsAt);
    let code = null;
    if (market.account?.positionsVerified !== true) code = "POSITIONS_UNVERIFIED";
    else if (!position || !source.positionId || seen.has(source.positionId)) code = "EXIT_PLAN_POSITION_INVALID";
    else if (source.heldSide !== heldDirection(position) || !["LONG", "SHORT"].includes(source.heldSide) || source.quantity !== Number(position.quantity)) code = "EXIT_PLAN_POSITION_MISMATCH";
    else if (!Number.isFinite(observedAt) || !Number.isSafeInteger(source.validForSec) || source.validForSec <= 0 || source.validForSec > 3600 || !Number.isFinite(expiresAt) || expiresAt <= now) code = "EXIT_PLAN_EXPIRED";
    else if ((tp === null && sl === null && !realtime) || (tp !== null && (!Number.isFinite(tp) || tp <= 0)) || (sl !== null && (!Number.isFinite(sl) || sl <= 0)) || (tp !== null && sl !== null && (source.heldSide === "LONG" ? tp <= sl : tp >= sl))) code = "EXIT_PLAN_PRICE_INVALID";
    if (!code && tp !== null && !validProfitTarget(position, tp)
      && !(isRecoveryExit(recovery, position, tp, now) && Math.abs(tp - positionEntryPrice(position)) <= POSITION_MAX_PROFIT_POINTS)) {
      tp = null;
      if (sl === null && !realtime) code = "EXIT_PLAN_TAKE_PROFIT_NOT_PROFITABLE";
      else rejected.push({ positionId: source.positionId, code: "EXIT_PLAN_TAKE_PROFIT_NOT_PROFITABLE" });
    }
    if (code) { rejected.push({ positionId: source.positionId, code }); continue; }
    seen.add(source.positionId);
    plans.push({ ...source, entryPrice: positionEntryPrice(position), takeProfitPrice: tp, stopLossPrice: sl, realtimeTakeProfit: realtime,
      ...(tp !== null && isRecoveryExit(recovery, position, tp, now) ? { lossRecovery: true, lossObservation: recovery } : {}),
      observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), status: "ARMED" });
  }
  return { plans, rejected };
}

export function evaluateExitPlan(plan, market, now = Date.now(), { lossObservation = plan.lossObservation } = {}) {
  if (now >= Date.parse(plan.expiresAt) || !Number.isFinite(Date.parse(plan.expiresAt))) return { status: "EXPIRED" };
  if (market.account?.positionsVerified !== true) return { status: "POSITIONS_UNVERIFIED" };
  const position = market.account.positions.find(p => p.positionOrderId === plan.positionId);
  if (!position) return { status: "POSITION_CLOSED" };
  if (heldDirection(position) !== plan.heldSide || Number(position.quantity) !== plan.quantity) return { status: "POSITION_CHANGED" };
  if (plan.entryPrice !== undefined && plan.entryPrice !== positionEntryPrice(position)) return { status: "POSITION_CHANGED" };
  const quote = executableExitQuote(market, position, now);
  if (!quote) return { status: "QUOTE_UNVERIFIED" };
  const long = plan.heldSide === "LONG";
  const stop = plan.stopLossPrice !== null && (long ? quote.price <= plan.stopLossPrice : quote.price >= plan.stopLossPrice);
  const pnl = exitNetPnl(position, quote.price);
  const targetProfit = plan.takeProfitPrice !== null
    && (long ? quote.price >= plan.takeProfitPrice : quote.price <= plan.takeProfitPrice)
    && (isNonLosingExit(position, quote.price) || (plan.lossRecovery && isRecoveryExit(lossObservation, position, quote.price, now)));
  const realtimeProfit = plan.realtimeTakeProfit
    && realtimeValueAbove(market.account, plan.realtimeTakeProfit.valueAbove)
    && (long ? quote.price >= plan.realtimeTakeProfit.takeProfitPrice : quote.price <= plan.realtimeTakeProfit.takeProfitPrice)
    && isNonLosingExit(position, quote.price);
  const profit = targetProfit || realtimeProfit;
  if (!stop && !profit) return { status: "ARMED", quotePrice: quote.price };
  const exitType = stop ? "STOP_LOSS" : "TAKE_PROFIT";
  const triggerPrice = stop ? plan.stopLossPrice : targetProfit ? plan.takeProfitPrice : plan.realtimeTakeProfit.takeProfitPrice;
  return {
    status: "TRIGGERED", position, quotePrice: quote.price, netPnl: pnl?.netPnl ?? null, grossPnl: pnl?.grossPnl ?? null,
    decision: { action: long ? "SELL" : "BUY", orderType: "MARKET", exitType, targetPositionIds: [plan.positionId], targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      exitGuard: { positionId: plan.positionId, heldSide: plan.heldSide, quantity: plan.quantity, entryPrice: plan.entryPrice, exitType, authoredAt: plan.observedAt, expiresAt: plan.expiresAt, triggerPrice, comparison: (long && !stop) || (!long && stop) ? "GTE" : "LTE",
        ...(!stop && plan.lossRecovery ? { lossRecovery: true, lossObservation } : {}),
        ...(!stop && !targetProfit && realtimeProfit ? { realtimeValueAbove: plan.realtimeTakeProfit.valueAbove } : {}) } },
  };
}

export function realtimeValueAbove(account, threshold) {
  const value = account?.realtimeValueChange;
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    && Number.isFinite(Number(value)) && Number.isFinite(threshold) && Number(value) > threshold;
}

export function exitGuardAllowsPrice(guard, price, now = Date.now()) {
  if (!guard || guard.positionAmount || !Number.isFinite(Date.parse(guard.expiresAt)) || now >= Date.parse(guard.expiresAt) || !Number.isFinite(Number(price)) || Number(price) <= 0) return false;
  if (guard.comparison === "GT") return Number(price) > guard.triggerPrice;
  if (guard.comparison === "LT") return Number(price) < guard.triggerPrice;
  if (guard.comparison === "GTE") return Number(price) >= guard.triggerPrice;
  if (guard.comparison === "LTE") return Number(price) <= guard.triggerPrice;
  if (guard.comparison === "EQ") return Number(price) === guard.triggerPrice;
  return false;
}
