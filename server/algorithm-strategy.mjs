import { entryTimingBlock } from "./entry-policy.mjs";
import { heldDirection } from "./exit-policy.mjs";
import { candleWickState } from "./flash-k.mjs";
import { executableEntryQuote, matchesInstrument } from "./trading-plan.mjs";

const MINUTE_MS = 60_000;
const STATE_BARS = 12;
const PATH_BARS = 6;
const MAX_HOLD_BARS = 8;
const MAX_HISTORY = 720;
const MAX_PATHS = 24;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundPrice = value => Number(value.toFixed(6));

function quantile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const below = Math.floor(index), above = Math.ceil(index);
  return sorted[below] + (sorted[above] - sorted[below]) * (index - below);
}

function weightedQuantile(rows, fraction) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((left, right) => left.value - right.value);
  let remaining = sorted.reduce((weight, row) => weight + row.weight, 0) * fraction;
  for (const row of sorted) {
    remaining -= row.weight;
    if (remaining <= 0) return row.value;
  }
  return sorted.at(-1).value;
}

function closedMinutes(book, now) {
  const minute = book?.timeframes?.["1m"] || (book?.timeframe === "1m" ? book : null);
  const rows = new Map();
  for (const candle of (minute?.history || []).slice(-MAX_HISTORY)) {
    const timestamp = Number(candle.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp + MINUTE_MS > now) continue;
    if (candleWickState(candle) !== "HAS_WICK" || (candle.confirmation?.status || candle.confirmation) === "PROVISIONAL") continue;
    if (Number(candle.confirmation?.lastObservedAt) > now) continue;
    rows.set(timestamp, { ...candle, timestamp });
  }
  return [...rows.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function slope(bars) {
  const start = bars[0].timestamp;
  const offsets = bars.map(candle => (candle.timestamp - start) / MINUTE_MS);
  const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const denominator = offsets.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return bars.reduce((sum, candle, index) => sum + (offsets[index] - mean) * (candle.close - bars[0].close), 0) / denominator;
}

function describeState(bars) {
  const first = bars[0], last = bars.at(-1);
  if (bars.length < 4 || last.timestamp - first.timestamp > (bars.length + 5) * MINUTE_MS) return null;
  const range = quantile(bars.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low, Math.abs(candle.high - bars[index].close), Math.abs(candle.low - bars[index].close),
  )), 0.5);
  if (!(range > 0)) return null;
  const short = bars.slice(-5);
  const fastSlope = slope(short);
  const slowSlope = slope(bars);
  const changes = bars.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - bars[index].close), 0);
  const near = bars.slice(-4);
  const low = quantile(near.map(candle => candle.low), 0.2);
  const high = quantile(near.map(candle => candle.high), 0.8);
  return { last, range, low, high, momentum: (fastSlope * 0.65 + slowSlope * 0.35) * 4 / range,
    efficiency: changes > 0 ? Math.abs(last.close - first.close) / changes : 0 };
}

function recentState(history, now, minimum = STATE_BARS) {
  const bars = history.slice(-STATE_BARS);
  if (bars.length < minimum || now - bars.at(-1).timestamp > 4 * MINUTE_MS) return null;
  return describeState(bars);
}

function awaitingPrice(book, now) {
  const minute = book?.timeframes?.["1m"] || (book?.timeframe === "1m" ? book : null);
  const candle = minute?.history?.at(-1);
  return entryTimingBlock(book, { requireConfirmed: true }) || Number(candle?.timestamp) > now
    || Number(candle?.confirmation?.lastObservedAt) > now;
}

function relativeLocation(state, price, direction) {
  return (direction === 1 ? price - state.low : state.high - price) / Math.max(state.range, state.high - state.low);
}

function analoguePaths(history, current, price, direction) {
  const candidates = [];
  const location = relativeLocation(current, price, direction);
  for (let index = STATE_BARS - 1; index + PATH_BARS < history.length - STATE_BARS; index += 1) {
    const prior = describeState(history.slice(index - STATE_BARS + 1, index + 1));
    if (!prior || prior.momentum * direction <= 0) continue;
    const path = history.slice(index + 1, index + 1 + PATH_BARS);
    if (path.some((candle, step) => candle.timestamp - prior.last.timestamp !== (step + 1) * MINUTE_MS)) continue;
    const distance = Math.abs(clamp(current.momentum, -3, 3) - clamp(prior.momentum, -3, 3))
      + Math.abs(location - relativeLocation(prior, prior.last.close, direction))
      + Math.abs(current.efficiency - prior.efficiency);
    if (distance > 1.8) continue;
    const points = (value) => (value - prior.last.close) * direction * current.range / prior.range;
    candidates.push({ index, distance, weight: 1 / (1 + distance) ** 2,
      path: path.map(candle => ({ favorable: points(direction === 1 ? candle.high : candle.low),
        adverse: points(direction === 1 ? candle.low : candle.high), close: points(candle.close) })) });
  }
  candidates.sort((left, right) => left.distance - right.distance || right.index - left.index);
  const neighbors = [];
  for (const candidate of candidates) {
    if (neighbors.some(row => Math.abs(row.index - candidate.index) <= PATH_BARS)) continue;
    neighbors.push(candidate);
    if (neighbors.length === MAX_PATHS) break;
  }
  return neighbors;
}

function scoreTargets(neighbors, loss, structuralTarget, range) {
  if (!neighbors.length) return { reward: structuralTarget, expectedPoints: null, hits: [] };
  const totalWeight = neighbors.reduce((sum, row) => sum + row.weight, 0);
  const priorWeight = 12 / (neighbors.length + 12);
  const levels = [1, 0.75, 0.9, 1.2, 1.5].map(factor => clamp(structuralTarget * factor, range * 0.65, range * 3));
  let best;
  for (const reward of new Set(levels)) {
    const hits = [];
    const totalPoints = neighbors.reduce((sum, row) => {
      const barrier = row.path.findIndex(step => step.adverse <= -loss || step.favorable >= reward);
      if (barrier < 0) return sum + row.weight * row.path.at(-1).close;
      if (row.path[barrier].adverse <= -loss) return sum - row.weight * loss;
      hits.push({ value: barrier + 1, weight: row.weight });
      return sum + row.weight * reward;
    }, 0);
    const expectedPoints = totalPoints / totalWeight;
    const score = (1 - priorWeight) * expectedPoints - priorWeight * Math.abs(reward - structuralTarget);
    if (!best || score > best.score) best = { score, reward, expectedPoints, hits };
  }
  return best;
}

function makePlan(history, state, entry, direction, zone) {
  const { low, high, last, range } = state;
  const support = direction === 1 ? low : high;
  const resistance = direction === 1 ? high : low;
  const loss = clamp((entry - support) * direction + range * 0.25, range * 0.75, range * 1.65);
  const structuralTarget = clamp((resistance - entry) * direction + range * 0.25, range, range * 2.6);
  const neighbors = analoguePaths(history, state, entry, direction);
  const { reward, expectedPoints, hits } = scoreTargets(neighbors, loss, structuralTarget, range);
  const expectedExitBars = weightedQuantile(hits, 0.5);
  const takeProfitPrice = roundPrice(entry + direction * reward);
  const stopLossPrice = roundPrice(entry - direction * loss);
  const hardStopPrice = roundPrice(entry - direction * (loss + range * 0.65));
  if (!(Math.min(takeProfitPrice, stopLossPrice, hardStopPrice) > 0)
    || (takeProfitPrice - entry) * direction <= 0 || (entry - stopLossPrice) * direction <= 0) return null;
  return {
    forecast: { matchedPaths: neighbors.length, targetHits: hits.length, expectedExitBars,
      historicalExpectedPoints: expectedPoints === null ? null : roundPrice(expectedPoints) },
    plan: {
      setup: "ALGORITHM_TREND_PULLBACK",
      entryZone: zone,
      anchorPrice: last.close,
      anchorTimestamp: new Date(last.timestamp).toISOString(),
      takeProfitPrice,
      stopLossPrice,
      hardStopPrice,
      stopConfirmationSec: 20,
      validForSec: 900,
      maxHoldSec: MAX_HOLD_BARS * 60,
      profitProtection: { activationPrice: roundPrice(entry + direction * reward * 0.8),
        floorPrice: roundPrice(entry + direction * reward * 0.35), trailingDistance: roundPrice(Math.max(range * 0.45, reward * 0.25)) },
      rationale: `短线趋势、波动与 ${neighbors.length} 段相似历史路径共同估算目标`,
      invalidation: `可成交报价连续 20 秒越过 ${stopLossPrice} 或定价后触及硬止损 ${hardStopPrice}`,
    },
  };
}

function entryPlanAtPrice(book, now, readQuote) {
  const history = closedMinutes(book, now);
  const state = recentState(history, now, 8);
  const regime = !state ? "UNKNOWN" : state.momentum > 0.35 ? "UP" : state.momentum < -0.35 ? "DOWN" : "RANGE";
  const base = { decisionSource: "ALGORITHM", marketRegime: regime, action: "HOLD", confidence: null,
    targetPositionPct: 0, maxOrderValuePct: 0, reasonCodes: [], evidenceIds: [], riskFlags: [], decisionTtlSec: 20 };
  const hold = (code, message, fields) => ({ ...base, ...fields, riskFlags: [code], invalidation: message, analysisSummary: message });
  if (!state) return hold("ALGORITHM_HISTORY_INSUFFICIENT", "等待足够的新鲜定 K 分钟数据");
  if (regime === "RANGE") return hold("ALGORITHM_TREND_UNCLEAR", "短线方向未形成，继续观察");
  const direction = regime === "UP" ? 1 : -1;
  const action = direction === 1 ? "BUY" : "SELL";
  const sideLabel = direction === 1 ? "上涨等相对低位" : "下跌等相对高位";
  const width = Math.max(state.high - state.low, state.range);
  const fraction = Math.abs(state.momentum) >= 1.2 ? 0.72 : 0.62;
  const zone = direction === 1
    ? { min: roundPrice(Math.max(0.000001, state.low - state.range * 0.2)), max: roundPrice(state.low + width * fraction) }
    : { min: roundPrice(Math.max(0.000001, state.high - width * fraction)), max: roundPrice(state.high + state.range * 0.2) };
  const targets = { targetSymbol: book.symbol, targetSymbolName: book.symbolName, targetInstrumentId: book.instrumentId };
  const fields = { ...targets, algorithmForecast: { entryZone: zone } };
  const quote = readQuote(action);
  if (quote?.code === "ENTRY_AWAITING_CONFIRMED_PRICE") {
    return hold(quote.code, `${sideLabel}，等待观察到带影线的正常定价`, fields);
  }
  if (!quote) return hold("ENTRY_QUOTE_OR_DEPTH_UNVERIFIED", `${sideLabel}，等待新鲜可成交盘口`, fields);
  const insideZone = quote.price >= zone.min && quote.price <= zone.max;
  const entryPrice = clamp(quote.price, zone.min, zone.max);
  const projection = makePlan(history, state, entryPrice, direction, zone);
  if (!projection) return hold("ALGORITHM_PLAN_UNAVAILABLE", "当前报价无法得到有效的目标及止损价", fields);
  const { plan, forecast } = projection;
  const directionLabel = direction === 1 ? "UP" : "DOWN";
  const exitTiming = forecast.expectedExitBars === null ? "离场 K 数样本不足" : `同类路径触达目标中位数 ${forecast.expectedExitBars} 根 1 分钟 K`;
  const entryHits = insideZone ? [] : analoguePaths(history, state, quote.price, direction).flatMap(row => {
    const beyond = quote.price > zone.max ? 1 : -1;
    const threshold = (entryPrice - quote.price) * direction;
    const step = row.path.findIndex(range => beyond * direction === 1 ? range.adverse <= threshold : range.favorable >= threshold);
    return step < 0 ? [] : [{ value: step + 1, weight: row.weight }];
  });
  const expectedEntryBars = insideZone ? 0 : weightedQuantile(entryHits, 0.5);
  const observedAt = new Date(quote.observedAt).toISOString();
  const planned = { ...fields, observedAt, tradePlan: plan, algorithmForecast: { entryZone: zone, expectedEntryBars, ...forecast } };
  if (!insideZone) {
    return hold("ALGORITHM_WAITING_ENTRY_ZONE", `${sideLabel}，可成交价 ${quote.price}，关注 ${zone.min}～${zone.max}`, planned);
  }
  return { ...base, ...planned, action, orderType: "MARKET", signalTier: "ALGORITHM", entryPrice,
    takeProfitPrice: plan.takeProfitPrice, stopLossPrice: plan.stopLossPrice,
    reasonCodes: ["SHORT_TREND_PULLBACK", "ALGORITHM_PRICE_PLAN"],
    forecastHorizon: forecast.expectedExitBars === null ? null : {
      next10K: { direction: directionLabel, path: `第 ${forecast.expectedExitBars} 根附近触达 ${plan.takeProfitPrice}`, invalidation: plan.invalidation },
    },
    analysisSummary: `${sideLabel}，可成交价 ${quote.price} 位于 ${zone.min}～${zone.max}，目标 ${plan.takeProfitPrice}，${exitTiming}`,
    invalidation: plan.invalidation,
  };
}

export function algorithmEntryDecision(book, { executionBook = book, quantity = 1, now = Date.now() } = {}) {
  return entryPlanAtPrice(book, now, action => awaitingPrice(executionBook, now)
    ? { code: "ENTRY_AWAITING_CONFIRMED_PRICE" } : executableEntryQuote(executionBook, action, quantity, now));
}

export function algorithmCandleProbeDecision(book, price, now) {
  if (!(Number.isFinite(price) && price > 0)) throw new Error("分钟 K 探测需要有效观察价");
  return entryPlanAtPrice(book, now, () => ({ price, observedAt: now }));
}

export function algorithmHoldingPlan(book, summary, now = Date.now()) {
  const history = closedMinutes(book, now);
  const state = recentState(history, now, 4);
  const entry = Number(summary?.averagePrice), side = heldDirection(summary);
  if (!state || !(entry > 0) || !["LONG", "SHORT"].includes(side)) return null;
  return makePlan(history, state, entry, side === "LONG" ? 1 : -1, { min: entry, max: entry })?.plan || null;
}

export function algorithmEntryPriceInPlan(plan, price, action) {
  if (!["BUY", "SELL"].includes(action)) return false;
  const { entryZone, takeProfitPrice, stopLossPrice } = plan || {};
  const direction = action === "BUY" ? 1 : -1;
  return price >= entryZone?.min && price <= entryZone?.max
    && (takeProfitPrice - price) * direction > 0 && (price - stopLossPrice) * direction > 0;
}

export function recheckAlgorithmEntry(book, { action, quantity, entryGuard, now = Date.now() }) {
  if (!(Date.parse(entryGuard.expiresAt) > now)) {
    return { ok: false, code: "ALGORITHM_ENTRY_EXPIRED", message: "入场计划已过期，等待新行情重算" };
  }
  if (awaitingPrice(book, now)) {
    return { ok: false, code: "ENTRY_AWAITING_CONFIRMED_PRICE", message: "闪K或未定价，等待真实定K后再下单" };
  }
  const bothIds = entryGuard.instrumentId && book.instrumentId;
  if (bothIds ? String(entryGuard.instrumentId) !== String(book.instrumentId) : !matchesInstrument(entryGuard, book)) {
    return { ok: false, code: "ENTRY_INSTRUMENT_CHANGED", message: "目标盘已变化" };
  }
  const quote = executableEntryQuote(book, action, quantity, now);
  if (!quote) return { ok: false, code: "ENTRY_QUOTE_OR_DEPTH_UNVERIFIED", message: "最新盘口不足以核实全部数量" };
  if (!algorithmEntryPriceInPlan(entryGuard.plan, quote.price, action)) {
    return { ok: false, code: "ALGORITHM_ENTRY_PRICE_MOVED", message: "报价已离开入场区间或触及计划边界，等待重算" };
  }
  return { ok: true, ...quote };
}
