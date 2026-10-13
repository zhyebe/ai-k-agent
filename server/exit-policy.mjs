import { summarizeOrderBook } from "./order-book.mjs";

export const DEFAULT_SESSION_CLOSE = Object.freeze({ time: "16:00", leadMinutes: 5, timezone: "Asia/Shanghai" });

export function parseSessionClose(value = DEFAULT_SESSION_CLOSE) {
  if (!value || typeof value !== "object" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return null;
  const leadMinutes = Number(value.leadMinutes);
  const [hour, minute] = value.time.split(":").map(Number);
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 1 || leadMinutes >= hour * 60 + minute) return null;
  if (value.timezone !== undefined && value.timezone !== "Asia/Shanghai") return null;
  return { time: value.time, leadMinutes, timezone: "Asia/Shanghai" };
}

export function sessionCloseWindow(task, now = Date.now()) {
  const config = parseSessionClose(task.sessionClose);
  if (!config) throw new Error("INVALID_SESSION_CLOSE");
  const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const closesAt = Date.parse(`${date}T${config.time}:00+08:00`);
  const startsAt = closesAt - config.leadMinutes * 60000;
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

export function normalizeExitPlans(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    positionId: String(item?.position_id ?? item?.positionId ?? "").trim(),
    heldSide: String(item?.held_side ?? item?.heldSide ?? ""),
    quantity: Number(item?.quantity),
    validForSec: Number(item?.valid_for_sec ?? item?.validForSec),
    takeProfitPrice: item?.take_profit_price ?? item?.takeProfitPrice ?? null,
    stopLossPrice: item?.stop_loss_price ?? item?.stopLossPrice ?? null,
    rationale: String(item?.rationale ?? "").slice(0, 1000),
  }));
}

export function validateExitPlans(decision, market, task, now = Date.now()) {
  const plans = [];
  const rejected = [];
  const observedAt = Date.parse(market.observedAt || "");
  const closing = sessionCloseWindow(task, now);
  const seen = new Set();
  for (const source of normalizeExitPlans(decision.exitPlans)) {
    const position = market.account?.positions?.find(p => p.positionOrderId === source.positionId);
    const tp = source.takeProfitPrice === null ? null : Number(source.takeProfitPrice);
    const sl = source.stopLossPrice === null ? null : Number(source.stopLossPrice);
    const expiresAt = Math.min(observedAt + source.validForSec * 1000, closing.startsAt);
    let code = null;
    if (market.account?.positionsVerified !== true) code = "POSITIONS_UNVERIFIED";
    else if (!position || !source.positionId || seen.has(source.positionId)) code = "EXIT_PLAN_POSITION_INVALID";
    else if (source.heldSide !== heldDirection(position) || !["LONG", "SHORT"].includes(source.heldSide) || source.quantity !== Number(position.quantity)) code = "EXIT_PLAN_POSITION_MISMATCH";
    else if (!Number.isFinite(observedAt) || !Number.isSafeInteger(source.validForSec) || source.validForSec <= 0 || source.validForSec > 3600 || !Number.isFinite(expiresAt) || expiresAt <= now) code = "EXIT_PLAN_EXPIRED";
    else if ((tp === null && sl === null) || (tp !== null && (!Number.isFinite(tp) || tp <= 0)) || (sl !== null && (!Number.isFinite(sl) || sl <= 0)) || (tp !== null && sl !== null && (source.heldSide === "LONG" ? tp <= sl : tp >= sl))) code = "EXIT_PLAN_PRICE_INVALID";
    if (code) { rejected.push({ positionId: source.positionId, code }); continue; }
    seen.add(source.positionId);
    plans.push({ ...source, takeProfitPrice: tp, stopLossPrice: sl, observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), status: "ARMED" });
  }
  return { plans, rejected };
}

export function evaluateExitPlan(plan, market, now = Date.now()) {
  if (now >= Date.parse(plan.expiresAt) || !Number.isFinite(Date.parse(plan.expiresAt))) return { status: "EXPIRED" };
  if (market.account?.positionsVerified !== true) return { status: "POSITIONS_UNVERIFIED" };
  const position = market.account.positions.find(p => p.positionOrderId === plan.positionId);
  if (!position) return { status: "POSITION_CLOSED" };
  if (heldDirection(position) !== plan.heldSide || Number(position.quantity) !== plan.quantity) return { status: "POSITION_CHANGED" };
  const quote = executableExitQuote(market, position, now);
  if (!quote) return { status: "QUOTE_UNVERIFIED" };
  const long = plan.heldSide === "LONG";
  const stop = plan.stopLossPrice !== null && (long ? quote.price <= plan.stopLossPrice : quote.price >= plan.stopLossPrice);
  const profit = plan.takeProfitPrice !== null && (long ? quote.price >= plan.takeProfitPrice : quote.price <= plan.takeProfitPrice);
  if (!stop && !profit) return { status: "ARMED", quotePrice: quote.price };
  const exitType = stop ? "STOP_LOSS" : "TAKE_PROFIT";
  const triggerPrice = stop ? plan.stopLossPrice : plan.takeProfitPrice;
  return {
    status: "TRIGGERED", position, quotePrice: quote.price,
    decision: { action: long ? "SELL" : "BUY", orderType: "MARKET", exitType, targetPositionIds: [plan.positionId], targetSymbol: position.symbol, targetSymbolName: position.symbolName, targetInstrumentId: position.instrumentId,
      exitGuard: { positionId: plan.positionId, heldSide: plan.heldSide, quantity: plan.quantity, expiresAt: plan.expiresAt, triggerPrice, comparison: (long && profit) || (!long && stop) ? "GTE" : "LTE" } },
  };
}

export function exitGuardAllowsPrice(guard, price, now = Date.now()) {
  if (!guard || !Number.isFinite(Date.parse(guard.expiresAt)) || now >= Date.parse(guard.expiresAt) || !Number.isFinite(Number(price)) || Number(price) <= 0) return false;
  if (guard.comparison === "GTE") return Number(price) >= guard.triggerPrice;
  if (guard.comparison === "LTE") return Number(price) <= guard.triggerPrice;
  return false;
}
