import crypto from "node:crypto";
import { openBrowserPage, readVisiblePage } from "./browser.mjs";
import { extractHaohanPageInstrument, HAO_HAN_HOST, isHaohanTarget, parseHaohanPageSnapshot } from "./haohan.mjs";

const DEFAULT_WS_URL = "wss://smyt.haohandahan.cn/wsfront_tq";
const DEFAULT_MARKET_ID = 28;
const DEFAULT_QUOTE_MARKET_ID = 111;
const DEFAULT_HTTP_BASE_URL = "https://smyt.haohandahan.cn";
const DEFAULT_KLINE_COUNT = 2000;
const DEFAULT_ANALYSIS_TIMEFRAMES = Object.freeze([
  "1m",
  "1h",
  "1d",
  "1mo",
]);
const KLINE_PERIODS = Object.freeze({
  "1m": 0,
  "3m": 10,
  "5m": 1,
  "10m": 11,
  "15m": 2,
  "30m": 3,
  "1h": 4,
  "2h": 12,
  "4h": 9,
  "1d": 5,
  "1w": 6,
  "1mo": 7,
});
const TIMEFRAME_ALIASES = Object.freeze({
  "60m": "1h",
  "hour": "1h",
  "hourly": "1h",
  "day": "1d",
  "daily": "1d",
  "week": "1w",
  "weekly": "1w",
  "month": "1mo",
  "monthly": "1mo",
});
const TIMEFRAME_LABELS = Object.freeze({
  fs: "分时",
  "1m": "1 分钟",
  "3m": "3 分钟",
  "5m": "5 分钟",
  "10m": "10 分钟",
  "15m": "15 分钟",
  "30m": "30 分钟",
  "1h": "60 分钟",
  "2h": "2 小时",
  "4h": "4 小时",
  "1d": "日线",
  "1w": "周线",
  "1mo": "月线",
});
const TIMEFRAME_SECONDS = Object.freeze({
  fs: 60,
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
  "1mo": 2592000,
});

export const HAO_HAN_ANALYSIS_TIMEFRAMES = DEFAULT_ANALYSIS_TIMEFRAMES;

export function normalizeHaohanTimeframe(timeframe = "15m") {
  const raw = String(timeframe || "15m").trim().toLowerCase().replace(/[\s_/-]+/g, "");
  return TIMEFRAME_ALIASES[raw] || (raw === "fs" ? "fs" : KLINE_PERIODS[raw] !== undefined ? raw : "15m");
}

export function haohanTimeframeLabel(timeframe = "15m") {
  const normalized = normalizeHaohanTimeframe(timeframe);
  return TIMEFRAME_LABELS[normalized] || normalized;
}

export function haohanTimeframeSeconds(timeframe = "15m") {
  return TIMEFRAME_SECONDS[normalizeHaohanTimeframe(timeframe)] || TIMEFRAME_SECONDS["15m"];
}

export function haohanTimeframeList(timeframes = DEFAULT_ANALYSIS_TIMEFRAMES) {
  const values = Array.isArray(timeframes) ? timeframes : [timeframes];
  return [...new Set(values.map(normalizeHaohanTimeframe).filter((value) => value !== "fs"))];
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function positiveNumber(value) {
  const result = number(value);
  return result !== null && result > 0 ? result : null;
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_./\\-]+/g, "");
}

function validTimestamp(value) {
  const result = number(value);
  if (result === null) return null;
  if (result > 946684800000 && result < 4102444800000) return result;
  if (result > 946684800 && result < 4102444800) return result * 1000;
  return null;
}

function parsePercent(value) {
  const result = number(String(value ?? "").replace("%", ""));
  return result === null ? null : result;
}

function normalizeCandle({ timestamp, previousClose = null, open, high, low, close, volume, amount = null, inventory = null }) {
  if (!timestamp || close === null) return null;
  const partial = open === null || high === null || low === null;
  return {
    timestamp,
    previousClose,
    open,
    high,
    low,
    close,
    volume: volume !== null && volume >= 0 ? volume : null,
    amount: amount !== null && amount >= 0 ? amount : null,
    inventory: inventory !== null && inventory >= 0 ? inventory : null,
    partial,
  };
}

export function normalizeHaohanKlineRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const timestamp = validTimestamp(row[0]);
  const previousClose = positiveNumber(row[1]);
  const open = positiveNumber(row[2]);
  const high = positiveNumber(row[3]);
  const low = positiveNumber(row[4]);
  const close = positiveNumber(row[5]);
  const volume = number(row[6]);
  const amount = number(row[7]);
  const inventory = number(row[8]);
  return normalizeCandle({ timestamp, previousClose, open, high, low, close, volume, amount, inventory });
}

function normalizeCandleObject(row) {
  if (!row || typeof row !== "object") return null;
  const timestamp = validTimestamp(row.timestamp ?? row.time ?? row.occurTime ?? row.date);
  const open = positiveNumber(row.open ?? row.openPrice);
  const high = positiveNumber(row.high ?? row.highPrice);
  const low = positiveNumber(row.low ?? row.lowPrice);
  const close = positiveNumber(row.close ?? row.closePrice ?? row.price);
  const volume = number(row.volume ?? row.quantity ?? row.amount);
  return normalizeCandle({ timestamp, open, high, low, close, volume, amount: number(row.amount), inventory: number(row.inventory ?? row.holdQuantity) });
}

export function normalizeHaohanTimelineRow(row) {
  return Array.isArray(row) ? normalizeHaohanKlineRow(row) : normalizeCandleObject(row);
}

function normalizeTick(item) {
  if (!item || typeof item !== "object") return null;
  const price = number(item.price ?? item.close);
  const volume = number(item.volume ?? item.quantity ?? item.amount);
  const occurTime = validTimestamp(item.occurTime ?? item.timestamp ?? item.time);
  if (price === null || !occurTime || price <= 0 || (volume !== null && volume < 0)) return null;
  return { price, volume: volume ?? 0, timestamp: occurTime };
}

export function normalizeHaohanTimelineTick(row) {
  if (Array.isArray(row)) {
    const timestamp = validTimestamp(row[0]);
    const price = positiveNumber(row[1]);
    const volume = number(row[3]);
    if (!timestamp || price === null || (volume !== null && volume < 0)) return null;
    return {
      timestamp,
      price,
      volume: volume ?? 0,
      referencePrice: positiveNumber(row[2]),
      averagePrice: positiveNumber(row[4]),
      flag: String(row[5] ?? ""),
    };
  }
  return normalizeTick(row);
}

function matchesInstrument(detail, requested) {
  const target = normalize(requested);
  return Boolean(target && [detail?.symbol, detail?.symbolId, detail?.code, detail?.symbolCode, detail?.commodityCode, detail?.contractId, detail?.name, detail?.symbolName, detail?.shortName].some((value) => normalize(value) === target));
}

export function haohanPeriodForTimeframe(timeframe = "15m") {
  const normalized = normalizeHaohanTimeframe(timeframe);
  return KLINE_PERIODS[normalized] ?? KLINE_PERIODS["15m"];
}

async function readJson(url, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("HAOHAN_HTTP_UNAVAILABLE");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
  });
  if (!response.ok) throw new Error(`HAOHAN_HTTP_${response.status}`);
  return response.json();
}

function klineUrl(path, baseUrl, params) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function isLongPeriod(timeframe) {
  return ["1d", "1w", "1mo"].includes(normalizeHaohanTimeframe(timeframe));
}

function serializeRawRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => Array.isArray(row) ? row.slice(0, 12) : row).filter(Boolean) : [];
}

function uniqueCandles(candles) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    if (!candle?.timestamp) continue;
    byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export async function fetchHaohanKlineHistory({ contractId, timeframe = "15m", count = DEFAULT_KLINE_COUNT, baseUrl = DEFAULT_HTTP_BASE_URL, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  if (!contractId) return { ok: false, code: "CONTRACT_ID_REQUIRED", message: "需要目标合约 ID" };
  const normalizedTimeframe = normalizeHaohanTimeframe(timeframe);
  if (normalizedTimeframe === "fs") return { ok: false, code: "TIMELINE_IS_NOT_KLINE", message: "分时数据使用逐笔时间线接口", timeframe: normalizedTimeframe };
  const period = haohanPeriodForTimeframe(normalizedTimeframe);
  const normalizedCount = Math.min(2000, Math.max(20, Number(count) || DEFAULT_KLINE_COUNT));
  const pageUrl = klineUrl("/qtfront_tq/klinePage", baseUrl, { contractId, period, count: normalizedCount, first: "200001010000" });
  const fullUrl = klineUrl("/qtfront_tq/kline", baseUrl, { symbol: contractId, period, count: normalizedCount });
  const urls = isLongPeriod(normalizedTimeframe) ? [fullUrl, pageUrl] : [pageUrl, fullUrl];
  let lastCode = "HAOHAN_KLINE_UNAVAILABLE";
  for (const url of urls) {
    try {
      const payload = await readJson(url, timeoutMs, fetchImpl);
      if (Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
        lastCode = "HAOHAN_KLINE_RESPONSE_INVALID";
        continue;
      }
      const history = uniqueCandles(payload.data.map(normalizeHaohanKlineRow).filter(Boolean));
      if (history.length) {
      return {
          ok: true,
          source: "haohan-readonly-kline",
          endpoint: new URL(String(url)).pathname,
          timeframe: normalizedTimeframe,
          period,
          history,
          responseCount: payload.data.length,
          requestedCount: normalizedCount,
          firstTimestamp: history[0].timestamp,
          lastTimestamp: history.at(-1).timestamp,
          rawData: serializeRawRows(payload.data),
          url: String(url),
        };
      }
      lastCode = "HAOHAN_KLINE_EMPTY";
    } catch (error) {
      lastCode = error?.message || lastCode;
    }
  }
  return { ok: false, code: lastCode, message: "只读历史 K 线暂时不可用", timeframe: normalizedTimeframe, period };
}

function send(socket, payload) {
  socket.send(JSON.stringify(payload));
}

function openSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      reject(new Error("HAOHAN_WS_TIMEOUT"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("HAOHAN_WS_UNREACHABLE"));
    });
  });
}

function createResponseInbox(socket) {
  const queue = [];
  const waiters = new Set();
  const onMessage = (event) => {
    let payload;
    try { payload = JSON.parse(String(event.data)); } catch { return; }
    const waiter = [...waiters].find((item) => item.predicate(payload));
    if (waiter) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    } else queue.push(payload);
  };
  const onError = () => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("HAOHAN_WS_UNREACHABLE"));
    }
    waiters.clear();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  return {
    waitFor(predicate, timeoutMs) {
      const queuedIndex = queue.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("HAOHAN_WS_RESPONSE_TIMEOUT")); }, timeoutMs) };
        waiters.add(waiter);
      });
    },
    close() {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("HAOHAN_WS_CLOSED"));
      }
      waiters.clear();
    },
  };
}

function ema(values, period) {
  if (!values.length) return null;
  const multiplier = 2 / (period + 1);
  let result = values[0];
  for (const value of values.slice(1)) result = (value - result) * multiplier + result;
  return result;
}

function rsi(values, period) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(candles, period) {
  if (candles.length < period) return null;
  return candles.slice(-period).reduce((sum, candle) => sum + candle.high - candle.low, 0) / period;
}

function round(value, digits = 4) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

function isCompleteCandle(candle) {
  return Boolean(candle)
    && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
    && (candle.volume === null || (Number.isFinite(candle.volume) && candle.volume >= 0));
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function standardDeviation(values, period) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const mean = window.reduce((sum, value) => sum + value, 0) / period;
  return Math.sqrt(window.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / period);
}

function macd(values) {
  if (values.length < 26) return { line: null, signal: null, histogram: null };
  const lines = [];
  for (let index = 25; index < values.length; index += 1) {
    const window = values.slice(0, index + 1);
    lines.push(ema(window, 12) - ema(window, 26));
  }
  const line = lines.at(-1);
  const signal = lines.length >= 9 ? ema(lines, 9) : null;
  return { line, signal, histogram: signal === null ? null : line - signal };
}

function calculateIndicators(candles) {
  const usable = candles.filter(isCompleteCandle);
  const closes = usable.map((candle) => candle.close);
  const volumes = usable.map((candle) => candle.volume ?? 0);
  const ema20 = closes.length >= 20 ? ema(closes.slice(-80), 20) : null;
  const previousEma = closes.length >= 21 ? ema(closes.slice(-81, -1), 20) : null;
  const ema50 = closes.length >= 50 ? ema(closes.slice(-150), 50) : null;
  const rsi14 = closes.length >= 15 ? rsi(closes, 14) : null;
  const atr14 = usable.length >= 14 ? atr(usable, 14) : null;
  const sma20 = sma(closes, 20);
  const deviation20 = standardDeviation(closes, 20);
  const macdValue = macd(closes);
  const current = usable.at(-1);
  const previous = usable.at(-2);
  const averageVolume = volumes.length >= 21 ? volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / 20 : null;
  const volumeRatio = current && averageVolume !== null ? (current.volume ?? 0) / Math.max(1, averageVolume) : null;
  const trend = ema20 === null || previousEma === null || !current
    ? "unknown"
    : current.close >= ema20 && ema20 >= previousEma
      ? "up"
      : current.close < ema20 && ema20 < previousEma
        ? "down"
        : "range";
  const anomaly = Boolean(current && atr14 && current.high - current.low > atr14 * 3);
  const recentHigh = usable.length >= 20 ? Math.max(...usable.slice(-20).map((candle) => candle.high)) : null;
  const recentLow = usable.length >= 20 ? Math.min(...usable.slice(-20).map((candle) => candle.low)) : null;
  return {
    ema20,
    ema50,
    sma20,
    rsi14,
    atr14,
    volumeRatio,
    macd: macdValue,
    bollinger: sma20 === null || deviation20 === null ? { middle: null, upper: null, lower: null } : { middle: sma20, upper: sma20 + deviation20 * 2, lower: sma20 - deviation20 * 2 },
    recentHigh,
    recentLow,
    lastReturnPct: current && previous ? ((current.close - previous.close) / previous.close) * 100 : null,
    trend,
    anomaly,
    completeHistoryCount: usable.length,
  };
}

function serializeCandle(candle) {
  return {
    timestamp: candle.timestamp,
    previousClose: round(candle.previousClose, 6),
    open: round(candle.open, 6),
    high: round(candle.high, 6),
    low: round(candle.low, 6),
    close: round(candle.close, 6),
    volume: round(candle.volume, 4),
    amount: round(candle.amount, 4),
    inventory: round(candle.inventory, 4),
    partial: Boolean(candle.partial || !isCompleteCandle(candle)),
  };
}

function normalizeHistory(history) {
  return uniqueCandles((Array.isArray(history) ? history : []).filter((candle) => candle && candle.timestamp && candle.close > 0));
}

function timeframeMissingFields(history, indicators) {
  const missing = [];
  if (!history.length) missing.push("HISTORY_EMPTY");
  if (history.length < 20) missing.push("HISTORY_INSUFFICIENT");
  if (history.some((candle) => candle.partial || !isCompleteCandle(candle))) missing.push("HISTORY_PARTIAL_OHLC");
  if (indicators.completeHistoryCount < 20) missing.push("COMPLETE_OHLC_INSUFFICIENT");
  return missing;
}

function safeReadOnlyPayload(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => safeReadOnlyPayload(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/password|passwd|token|secret|api[_-]?key|cookie|authorization|sessionstr/i.test(key))
      .map(([key, item]) => [key, safeReadOnlyPayload(item, depth + 1)]));
  }
  return String(value);
}

function timeframeFingerprint(snapshot) {
  return {
    timeframe: snapshot.timeframe,
    period: snapshot.period,
    history: snapshot.history,
    ticks: snapshot.ticks || [],
    missingFields: snapshot.missingFields,
    code: snapshot.code || "",
  };
}

function normalizePageFingerprintText(value) {
  return String(value || "")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, "[date]")
    .replace(/\d{4}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}时\d{1,2}分(?:\d{1,2}秒)?)?/g, "[date]")
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, "[time]")
    .replace(/\s+/g, " ")
    .trim();
}

function pageContentFingerprint(page) {
  if (!page) return "";
  const hasObservableContent = Boolean(
    page.title
    || page.visibleText
    || (Array.isArray(page.tables) && page.tables.length)
    || (Array.isArray(page.chartSamples) && page.chartSamples.length),
  );
  if (!hasObservableContent && page.contentFingerprint) return String(page.contentFingerprint);
  const material = JSON.stringify({
    title: normalizePageFingerprintText(page.title),
    visibleText: normalizePageFingerprintText(page.visibleText),
    tables: page.tables || [],
    chartSamples: page.chartSamples || [],
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function canonicalFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFingerprintValue(value[key])]).filter(([, item]) => item !== undefined));
  }
  return value;
}

export function marketDataFingerprint(market = {}) {
  const timeframes = market.timeframes && typeof market.timeframes === "object"
    ? Object.fromEntries(Object.entries(market.timeframes).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, timeframeFingerprint(value)]))
    : {};
  const material = {
    symbol: market.symbol,
    symbolName: market.symbolName,
    instrumentId: market.instrumentId,
    quote: market.quote || market.latest,
    ticks: market.ticks || [],
    history: market.history || [],
    timeframes,
    account: market.account || null,
    changePct: market.changePct,
    dataQuality: market.dataQuality || "",
    missingFields: market.missingFields || [],
    marketClosed: Boolean(market.marketClosed),
    page: market.page ? {
      url: market.page.url,
      instrument: market.page.instrument || null,
      contentFingerprint: pageContentFingerprint(market.page),
    } : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalFingerprintValue(material))).digest("hex");
}

function buildTimeframeSnapshot({ timeframe, period = null, history = [], source = "", rawData = [], endpoint = "", responseCount = 0, requestedCount = null, dataAt = null, ticks = [], ok = true, code = "", message = "" }) {
  const normalizedTimeframe = normalizeHaohanTimeframe(timeframe);
  const normalizedHistory = normalizeHistory(history);
  const indicators = calculateIndicators(normalizedHistory);
  const missingFields = timeframeMissingFields(normalizedHistory, indicators);
  if (!ok) missingFields.unshift(code || "KLINE_UNAVAILABLE");
  return {
    ok: Boolean(ok),
    code: String(code || (ok ? "KLINE_READ" : "KLINE_UNAVAILABLE")),
    message: String(message || ""),
    timeframe: normalizedTimeframe,
    label: haohanTimeframeLabel(normalizedTimeframe),
    kind: "kline",
    period,
    source,
    endpoint,
    responseCount: Number(responseCount || normalizedHistory.length),
    requestedCount: Number(requestedCount ?? rawData.length),
    history: normalizedHistory.map(serializeCandle),
    historyCount: normalizedHistory.length,
    completeHistoryCount: indicators.completeHistoryCount,
    firstTimestamp: normalizedHistory[0]?.timestamp || null,
    lastTimestamp: normalizedHistory.at(-1)?.timestamp || null,
    dataAt: dataAt || (normalizedHistory.at(-1) ? new Date(normalizedHistory.at(-1).timestamp).toISOString() : null),
    indicators: Object.fromEntries(Object.entries(indicators).map(([key, value]) => {
      if (key === "macd" || key === "bollinger") return [key, Object.fromEntries(Object.entries(value).map(([innerKey, innerValue]) => [innerKey, round(innerValue, 6)]))];
      return [key, typeof value === "number" ? round(value, 6) : value];
    })),
    trend: indicators.trend,
    anomaly: indicators.anomaly,
    missingFields,
    dataQuality: missingFields.length ? "LIMITED" : "VERIFIED",
    ticks: Array.isArray(ticks) ? ticks : [],
    rawData: safeReadOnlyPayload(rawData),
  };
}

export function enrichReadOnlyMarket({ symbol, symbolName, instrumentId = null, timeframe, history = [], ticks = [], quote = {}, observedAt, dataAt = null, source, marketClosed = false, timeframes = {}, raw = null, page = null, account = null, pageView = null }) {
  const primaryTimeframe = normalizeHaohanTimeframe(timeframe || "15m");
  const timeframeEntries = new Map();
  for (const [key, value] of Object.entries(timeframes || {})) {
    if (!value || typeof value !== "object") continue;
    const normalized = normalizeHaohanTimeframe(key || value.timeframe || primaryTimeframe);
    timeframeEntries.set(normalized, buildTimeframeSnapshot({ timeframe: normalized, ...value }));
  }
  if (!timeframeEntries.has(primaryTimeframe)) {
    timeframeEntries.set(primaryTimeframe, buildTimeframeSnapshot({ timeframe: primaryTimeframe, history, source }));
  }
  const primary = timeframeEntries.get(primaryTimeframe);
  const normalizedTicks = Array.isArray(ticks) ? ticks : [];
  const primaryHistory = primary.history;
  const current = primaryHistory.at(-1);
  const previous = primaryHistory.at(-2);
  const latestPrice = number(quote?.price ?? current?.close);
  const changePct = number(quote?.quoteChangePct) ?? (latestPrice !== null && previous?.close ? ((latestPrice - previous.close) / previous.close) * 100 : null);
  const missingFields = [...primary.missingFields];
  if (latestPrice === null || latestPrice <= 0) missingFields.unshift("LATEST_PRICE");
  if (!normalizedTicks.length) missingFields.push("LIVE_TICKS_MISSING");
  if (marketClosed) missingFields.push("MARKET_CLOSED");
  for (const [key, snapshot] of timeframeEntries) {
    for (const field of snapshot.missingFields) {
      if (key !== primaryTimeframe) missingFields.push(`TIMEFRAME_${key.toUpperCase()}_${field}`);
    }
  }
  const availableTimeframes = [...timeframeEntries.entries()]
    .filter(([, snapshot]) => snapshot.ok !== false && snapshot.historyCount > 0)
    .map(([key]) => key);
  const latestDataTimestamp = Math.max(
    current?.timestamp || 0,
    ...availableTimeframes.map((key) => timeframeEntries.get(key)?.lastTimestamp || 0),
    ...normalizedTicks.map((tick) => tick.timestamp || 0),
  );
  const resolvedDataAt = dataAt || (latestDataTimestamp ? new Date(latestDataTimestamp).toISOString() : observedAt || new Date().toISOString());
  const resolvedObservedAt = observedAt || new Date().toISOString();
  const freshnessTimestamp = new Date(resolvedDataAt).getTime();
  const freshnessSec = Number.isFinite(freshnessTimestamp)
    ? Math.max(0, Number(((Date.now() - freshnessTimestamp) / 1000).toFixed(2)))
    : null;
  const result = {
    ok: latestPrice !== null && latestPrice > 0,
    code: latestPrice !== null && latestPrice > 0 ? "READONLY_MARKET_READ" : "READONLY_QUOTE_MISSING",
    message: latestPrice !== null && latestPrice > 0 ? "已读取目标只读行情数据" : "只读行情缺少有效最新价",
    source,
    sourceKind: "readonly-interface",
    executionEnabled: false,
    page: page ? safeReadOnlyPayload(page) : null,
    symbol: String(symbol),
    symbolName: String(symbolName || "").slice(0, 120),
    instrumentId: instrumentId ? String(instrumentId) : null,
    timeframe: primaryTimeframe,
    history: primaryHistory,
    ticks: normalizedTicks,
    timeframes: Object.fromEntries(timeframeEntries),
    availableTimeframes,
    timeline: {
      kind: "timeline",
      source: normalizedTicks.length ? "haohan-readonly-timeline" : "none",
      ticks: normalizedTicks,
      tickCount: normalizedTicks.length,
      dataAt: normalizedTicks.at(-1)?.timestamp ? new Date(normalizedTicks.at(-1).timestamp).toISOString() : null,
    },
    quote: {
      price: round(latestPrice, 6),
      open: round(number(quote?.open ?? current?.open), 6),
      high: round(number(quote?.high ?? current?.high), 6),
      low: round(number(quote?.low ?? current?.low), 6),
      volume: round(number(quote?.volume ?? current?.volume), 4),
      settlement: round(number(quote?.settlement), 6),
      inventory: round(number(quote?.inventory), 4),
      positionChange: round(number(quote?.positionChange), 4),
    },
    changePct: round(changePct, 4),
    indicators: primary.indicators,
    trend: primary.trend,
    anomaly: primary.anomaly,
    freshnessSec,
    dataQuality: missingFields.length ? "LIMITED" : "VERIFIED",
    missingFields: [...new Set(missingFields)],
    marketClosed: Boolean(marketClosed),
    account: account || { availableFunds: null, equity: null, riskRate: null, dayPnl: null },
    pageView: pageView || page?.view || null,
    historyCount: primary.historyCount,
    completeHistoryCount: primary.completeHistoryCount,
    evidenceId: "",
    fingerprint: "",
    observedAt: resolvedObservedAt,
    dataAt: resolvedDataAt,
    raw: safeReadOnlyPayload(raw),
  };
  result.fingerprint = marketDataFingerprint(result);
  result.evidenceId = `market:${result.fingerprint.slice(0, 18)}`;
  return result;
}

export async function fetchHaohanMarket({ symbol, timeframe = "15m", timeoutMs = 8000, websocketUrl = DEFAULT_WS_URL, marketId = DEFAULT_MARKET_ID, quoteMarketId = DEFAULT_QUOTE_MARKET_ID, httpBaseUrl = DEFAULT_HTTP_BASE_URL, klineCount = DEFAULT_KLINE_COUNT, fetchImpl = globalThis.fetch } = {}) {
  if (!symbol) return { ok: false, code: "INSTRUMENT_REQUIRED", message: "需要目标商品代码或商品 ID" };
  let socket;
  let inbox;
  try {
    socket = await openSocket(websocketUrl, timeoutMs);
    inbox = createResponseInbox(socket);
    send(socket, { fid: "marketdetail-req", symbol: [], marketId });
    const detailResponse = await inbox.waitFor((payload) => ["marketdetail-resp", "marketdetail-response"].includes(payload?.fid), timeoutMs);
    if (Number(detailResponse.code) !== 0 || !Array.isArray(detailResponse.marketDetails)) return { ok: false, code: "HAOHAN_MARKET_RESPONSE_INVALID", message: "只读行情返回无效数据" };
    const instrument = detailResponse.marketDetails.find((item) => matchesInstrument(item, symbol));
    if (!instrument) return { ok: false, code: "INSTRUMENT_NOT_FOUND", message: "只读行情未返回所选商品" };
    const instrumentId = String(instrument.symbolId ?? instrument.contractId ?? instrument.code ?? symbol);
    const quotePromise = inbox.waitFor((payload) => payload?.fid === "pricedetail-resp", timeoutMs);
    const timelinePromise = inbox.waitFor((payload) => payload?.fid === "CurrencyTimeLineResponse", timeoutMs);
    const primaryTimeframe = normalizeHaohanTimeframe(timeframe || "15m");
    const requestedTimeframes = haohanTimeframeList(
      process.env.HAOHAN_ANALYSIS_TIMEFRAMES
        ? process.env.HAOHAN_ANALYSIS_TIMEFRAMES.split(",")
        : DEFAULT_ANALYSIS_TIMEFRAMES,
    );
    if (primaryTimeframe !== "fs" && !requestedTimeframes.includes(primaryTimeframe)) requestedTimeframes.push(primaryTimeframe);
    const klinePromises = requestedTimeframes.map((requestedTimeframe) => fetchHaohanKlineHistory({
      contractId: instrumentId,
      timeframe: requestedTimeframe,
      count: klineCount,
      baseUrl: httpBaseUrl,
      timeoutMs,
      fetchImpl,
    }));
    send(socket, { fid: "pricedetail-req", marketId: quoteMarketId, contractId: instrumentId, bCtrl: 1, positionIndex: -500, count: 100 });
    send(socket, { fid: "currencytimeline-req", contractId: instrumentId, timeFlag: 0 });
    const [quoteResult, timelineResult, ...klineResults] = await Promise.allSettled([quotePromise, timelinePromise, ...klinePromises]);
    const quoteResponse = quoteResult.status === "fulfilled" ? quoteResult.value : null;
    const timelineResponse = timelineResult.status === "fulfilled" ? timelineResult.value : null;
    const quoteTicks = Array.isArray(quoteResponse?.currentDataArray) ? quoteResponse.currentDataArray.map(normalizeTick).filter(Boolean) : [];
    const timelineTicks = Array.isArray(timelineResponse?.data) ? timelineResponse.data.map(normalizeHaohanTimelineTick).filter(Boolean) : [];
    const ticks = [...quoteTicks, ...timelineTicks]
      .sort((left, right) => left.timestamp - right.timestamp)
      .filter((tick, index, list) => index === list.findIndex((item) => item.timestamp === tick.timestamp && item.price === tick.price && item.volume === tick.volume));
    const klineSnapshots = {};
    requestedTimeframes.forEach((requestedTimeframe, index) => {
      const settled = klineResults[index];
      const result = settled?.status === "fulfilled" ? settled.value : { ok: false, code: settled?.reason?.message || "HAOHAN_KLINE_UNAVAILABLE", message: "只读历史 K 线暂时不可用", timeframe: requestedTimeframe, period: haohanPeriodForTimeframe(requestedTimeframe) };
      klineSnapshots[requestedTimeframe] = result.ok
        ? buildTimeframeSnapshot({
          timeframe: requestedTimeframe,
          period: result.period,
          history: result.history,
          source: result.source,
          rawData: result.rawData,
          endpoint: result.endpoint,
          responseCount: result.responseCount,
          requestedCount: result.requestedCount,
          dataAt: result.lastTimestamp ? new Date(result.lastTimestamp).toISOString() : null,
          ok: true,
          code: "KLINE_READ",
        })
        : buildTimeframeSnapshot({
          timeframe: requestedTimeframe,
          period: result.period,
          source: "haohan-readonly-kline",
          requestedCount: Number(klineCount) || DEFAULT_KLINE_COUNT,
          ok: false,
          code: result.code,
          message: result.message,
        });
    });
    const primarySnapshot = klineSnapshots[primaryTimeframe] || klineSnapshots["15m"];
    const history = primarySnapshot?.history || [];
    const latestTick = ticks.at(-1);
    const latestCandle = history.at(-1);
    const close = latestTick?.price ?? positiveNumber(instrument.close) ?? latestCandle?.close;
    if (close === null || close === undefined || close <= 0) return { ok: false, code: "HAOHAN_QUOTE_MISSING", message: "只读行情缺少最新价" };
    const observedAt = new Date().toISOString();
    const dataAt = new Date(latestTick?.timestamp ?? latestCandle?.timestamp ?? Date.now()).toISOString();
    const quote = {
      price: close,
      open: positiveNumber(instrument.open),
      high: positiveNumber(instrument.high),
      low: positiveNumber(instrument.low),
      quoteChangePct: parsePercent(instrument.quotechange ?? instrument.quoteChange),
      volume: number(instrument.amount) ?? latestCandle?.volume ?? ticks.reduce((sum, tick) => sum + tick.volume, 0),
      settlement: positiveNumber(instrument.clearPrice ?? instrument.settlement),
      inventory: number(instrument.holdQuantity ?? instrument.inventory),
      positionChange: number(instrument.warehouseBad ?? instrument.positionChange),
    };
    if (!history.length && !ticks.length) return { ok: false, code: "HAOHAN_HISTORY_MISSING", message: "只读行情没有历史或逐笔数据" };
    const marketClosed = !ticks.length && Number(instrument.amount || 0) === 0;
    return enrichReadOnlyMarket({
      ok: true,
      source: "haohan-readonly-api",
      symbol: String(symbol),
      symbolName: String(instrument.symbol ?? instrument.name ?? symbol),
      instrumentId,
      timeframe: primaryTimeframe === "fs" ? "15m" : primaryTimeframe,
      history,
      ticks,
      timeframes: klineSnapshots,
      quote,
      observedAt,
      dataAt,
      marketClosed,
      executionEnabled: false,
      historySource: primarySnapshot?.ok ? primarySnapshot.source : "none",
      raw: {
        marketDetail: safeReadOnlyPayload(detailResponse),
        quote: safeReadOnlyPayload(quoteResponse),
        timeline: safeReadOnlyPayload(timelineResponse),
      },
    });
  } catch (error) {
    return { ok: false, code: error?.message || "HAOHAN_MARKET_UNAVAILABLE", message: "目标只读行情暂时不可用" };
  } finally {
    try { inbox?.close(); } catch {}
    try { socket?.close(); } catch {}
  }
}

function connectorTarget(connector, task) {
  return String(task?.target?.url || connector?.target || "");
}

export async function openMarketBrowser(task, connector) {
  const url = connectorTarget(connector, task);
  if (!url) return { ok: false, code: "TARGET_URL_REQUIRED", message: "目标网址未配置" };
  let expectedHostname = "";
  try { expectedHostname = new URL(url).hostname; } catch {}
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  const current = await readVisiblePage(sessionId);
  if (current.ok) {
    try {
      const expected = new URL(url);
      const actual = new URL(current.url);
      const expectedHash = expected.hash.split("?")[0];
      const actualHash = actual.hash.split("?")[0];
      if (actual.hostname === expected.hostname && actual.pathname === expected.pathname && actualHash === expectedHash) {
        return { ...current, sessionId, mode: "reused", reused: true };
      }
    } catch {}
  }
  return openBrowserPage({ sessionId, url, expectedHostname });
}

export function resolveObservedHaohanSymbol(pageInstrument, taskSymbol) {
  const pageSymbol = String(pageInstrument?.symbol || "").trim();
  const configured = String(taskSymbol || "").trim();
  return pageSymbol || configured;
}

export async function observeMarket(task, connector) {
  if (!connector || connector.reviewStatus !== "APPROVED") return { ok: false, code: "MARKET_ADAPTER_REVIEW_REQUIRED", message: "目标适配器未审核，无法读取可验证行情" };
  if (!connector.capabilities.includes("read_visible_market") || connector.adapterId !== "haohan-readonly") {
    return { ok: false, code: "READONLY_MARKET_ADAPTER_UNAVAILABLE", message: "当前目标没有只读行情适配器" };
  }
  const sessionId = task.target.browserSessionId || `task:${task.id}`;
  let pageSnapshot = await readVisiblePage(sessionId);
  if (!pageSnapshot.ok) {
    const opened = await openMarketBrowser(task, connector);
    if (!opened.ok) return opened;
    pageSnapshot = opened;
  }
  if (!isHaohanTarget(pageSnapshot.url)) return { ok: false, code: "BROWSER_TARGET_MISMATCH", message: "当前浏览器页面不是浩瀚数贸目标" };
  const configuredSymbol = String(task.symbol || "").trim();
  const pageInstrument = extractHaohanPageInstrument(pageSnapshot);
  const observedSymbol = resolveObservedHaohanSymbol(pageInstrument, configuredSymbol) || "DGJJ";
  const parsed = parseHaohanPageSnapshot(pageSnapshot, { symbol: observedSymbol, timeframe: task.timeframe || "15m" });
  if (parsed.code === "REAUTH_REQUIRED") return parsed;
  const apiResult = await fetchHaohanMarket({ symbol: observedSymbol, timeframe: task.timeframe || "15m" });
  const page = {
    url: pageSnapshot.url,
    title: pageSnapshot.title,
    visibleText: pageSnapshot.visibleText,
    tables: pageSnapshot.tables,
    chartSamples: pageSnapshot.chartSamples,
    instrument: pageInstrument.symbol ? pageInstrument : (pageSnapshot.instrument || parsed.instrument || null),
    view: parsed.pageView || null,
    capturedAt: pageSnapshot.capturedAt,
    contentFingerprint: parsed.contentFingerprint || "",
  };
  if (apiResult.ok) {
    const pageSymbol = page.instrument?.symbol || parsed.instrument?.symbol || observedSymbol;
    const symbolMismatch = Boolean(configuredSymbol && pageSymbol && normalize(configuredSymbol) !== normalize(pageSymbol));
    const mergedQuote = Object.fromEntries(Object.entries(apiResult.quote || {}).map(([key, value]) => [key, value ?? parsed.quote?.[key]]));
    const enriched = enrichReadOnlyMarket({
      ...apiResult,
      page,
      pageView: parsed.pageView || null,
      quote: mergedQuote,
      account: Object.fromEntries(Object.entries({ ...(parsed.account || {}), ...(apiResult.account || {}) }).map(([key, value]) => [key, value ?? parsed.account?.[key]])),
      raw: { ...apiResult.raw, page },
    });
    if (symbolMismatch) {
      enriched.missingFields = [...new Set([...(enriched.missingFields || []), "SYMBOL_PAGE_MISMATCH"])];
      enriched.dataQuality = "LIMITED";
    }
    return enriched;
  }
  if (parsed.ok) {
    return enrichReadOnlyMarket({ ...parsed, page, raw: { page } });
  }
  return { ok: false, code: apiResult.code || parsed.code || "MARKET_UNAVAILABLE", message: apiResult.message || parsed.message || "无法读取目标只读行情" };
}

export const haohanMarketConfig = Object.freeze({
  host: HAO_HAN_HOST,
  readOnly: true,
  browserSource: "visible-dom",
  interfaceSource: "read-only-websocket",
  blockedWritePaths: Object.freeze([
    "/intraday-trade/trade/make",
    "/intraday-trade/trade/marketTake",
    "/intraday-trade/trade/cancel",
    "/intraday-trade/trade/cancelAll",
  ]),
});
