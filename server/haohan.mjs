import crypto from "node:crypto";

export const HAO_HAN_HOST = "smyw.haohandahan.cn";
export const HAO_HAN_TARGET_URL = `https://${HAO_HAN_HOST}/client/#/transcc`;

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_./\\-]+/g, "");
}

function finiteNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}${url.hash}`;
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labeledValue(text, labels) {
  for (const label of labels) {
    const match = String(text || "").match(new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*(--|[-+]?\\d[\\d,]*(?:\\.\\d+)?%?)`, "i"));
    if (match && match[1] !== "--") return finiteNumber(match[1]);
  }
  return null;
}

function labeledRaw(text, labels) {
  for (const label of labels) {
    const match = String(text || "").match(new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*([^\\s]{1,80})`, "i"));
    if (match && match[1] !== "--") return match[1];
  }
  return "";
}

function parseTimestamp(value, fallback = Date.now()) {
  if (typeof value === "number" && value > 946684800000 && value < 4102444800000) return value;
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const normalized = raw.replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, " ").replace(/时/g, ":").replace(/分/g, ":").replace(/秒/g, "");
  const parsed = Date.parse(normalized);
  if (Number.isFinite(parsed)) return parsed;
  const timeMatch = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const date = new Date(fallback);
    date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3] || 0), 0);
    return date.getTime();
  }
  return fallback;
}

function validCandle(candle) {
  return candle && Number.isFinite(candle.timestamp)
    && Number.isFinite(candle.close) && candle.close > 0
    && [candle.open, candle.high, candle.low].every((value) => value === null || (Number.isFinite(value) && value > 0))
    && Number.isFinite(candle.volume) && candle.volume >= 0;
}

function parseCandleText(value, fallbackTimestamp) {
  const text = String(value?.text || value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const dateValue = labeledRaw(text, ["日期", "时间", "时间戳"]);
  const open = labeledValue(text, ["开盘", "开盘价"]);
  const high = labeledValue(text, ["最高", "最高价"]);
  const low = labeledValue(text, ["最低", "最低价"]);
  const close = labeledValue(text, ["收盘", "收盘价"]);
  const volume = labeledValue(text, ["数量", "成交量", "量"]);
  if (close === null || close <= 0) return null;
  const normalizedOpen = positiveNumber(open);
  const normalizedHigh = positiveNumber(high);
  const normalizedLow = positiveNumber(low);
  const candle = {
    timestamp: parseTimestamp(dateValue, fallbackTimestamp),
    open: normalizedOpen,
    high: normalizedHigh,
    low: normalizedLow,
    close,
    volume: volume === null ? 0 : Math.max(0, volume),
    partial: [open, high, low].some((item) => positiveNumber(item) === null),
  };
  return validCandle(candle) ? candle : null;
}

function parseTableCandles(tables = [], fallbackTimestamp) {
  const candles = [];
  for (const table of Array.isArray(tables) ? tables : []) {
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (!rows.length) continue;
    const header = rows[0].map((cell) => String(cell || "").replace(/\s+/g, "").toLowerCase());
    const indexes = {
      timestamp: header.findIndex((cell) => /日期|时间|timestamp/.test(cell)),
      open: header.findIndex((cell) => /开盘/.test(cell)),
      high: header.findIndex((cell) => /最高/.test(cell)),
      low: header.findIndex((cell) => /最低/.test(cell)),
      close: header.findIndex((cell) => /收盘/.test(cell)),
      volume: header.findIndex((cell) => /数量|成交量|volume/.test(cell)),
    };
    if ([indexes.open, indexes.high, indexes.low, indexes.close].some((index) => index < 0)) continue;
    for (const row of rows.slice(1)) {
      const values = row.map((cell) => String(cell || "").trim());
      const close = positiveNumber(values[indexes.close]);
      if (close === null) continue;
      const open = positiveNumber(values[indexes.open]);
      const high = positiveNumber(values[indexes.high]);
      const low = positiveNumber(values[indexes.low]);
      const candle = {
        timestamp: parseTimestamp(indexes.timestamp >= 0 ? values[indexes.timestamp] : "", fallbackTimestamp),
        open,
        high,
        low,
        close,
        volume: indexes.volume >= 0 ? Math.max(0, finiteNumber(values[indexes.volume]) ?? 0) : 0,
        partial: open === null || high === null || low === null,
      };
      if (validCandle(candle)) candles.push(candle);
    }
  }
  return candles;
}

function parseTicks(tables = []) {
  const ticks = [];
  for (const table of Array.isArray(tables) ? tables : []) {
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (!rows.length) continue;
    const header = rows[0].map((cell) => String(cell || "").replace(/\s+/g, ""));
    const timeIndex = header.findIndex((cell) => /时间|日期/.test(cell));
    const priceIndex = header.findIndex((cell) => /价格|最新价/.test(cell));
    const volumeIndex = header.findIndex((cell) => /数量|成交量/.test(cell));
    if (timeIndex < 0 || priceIndex < 0) continue;
    for (const row of rows.slice(1)) {
      const values = row.map((cell) => String(cell || "").trim());
      const price = finiteNumber(values[priceIndex]);
      const volume = volumeIndex >= 0 ? finiteNumber(values[volumeIndex]) : 0;
      if (price === null || price <= 0) continue;
      ticks.push({ timestamp: parseTimestamp(values[timeIndex]), price, volume: volume === null ? 0 : Math.max(0, volume) });
    }
  }
  return ticks.slice(-200);
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
  const ranges = candles.slice(-period).map((candle) => candle.high - candle.low);
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function calculateIndicators(candles) {
  const usable = candles.filter((candle) => candle && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0));
  const closes = usable.map((candle) => candle.close);
  if (closes.length < 20) return { ema20: null, rsi14: null, atr14: null, volumeRatio: null, trend: "unknown", anomaly: false };
  const ema20 = ema(closes.slice(-80), 20);
  const previousEma = ema(closes.slice(-81, -1), 20);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(usable, 14);
  const current = usable.at(-1);
  const averageVolume = usable.slice(-21, -1).reduce((sum, candle) => sum + candle.volume, 0) / 20;
  const volumeRatio = current.volume / Math.max(1, averageVolume);
  const trend = current.close >= ema20 && ema20 >= previousEma ? "up" : current.close < ema20 && ema20 < previousEma ? "down" : "range";
  const anomaly = Boolean(atr14 && current.high - current.low > atr14 * 3);
  return { ema20, rsi14, atr14, volumeRatio, trend, anomaly };
}

function round(value, digits = 4) {
  return value === null || value === undefined ? null : Number(Number(value).toFixed(digits));
}

export function isHaohanTarget(value) {
  try { return new URL(String(value || "")).hostname === HAO_HAN_HOST; } catch { return false; }
}

export function extractHaohanPageInstrument(snapshot = {}) {
  const supplied = snapshot.instrument && typeof snapshot.instrument === "object" ? snapshot.instrument : {};
  const source = [snapshot.visibleText, snapshot.title].filter(Boolean).join("\n");
  const lines = String(source)
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let detected = { symbol: String(supplied.symbol || "").trim(), symbolName: String(supplied.symbolName || "").trim() };
  for (const line of lines) {
    const pipeMatch = line.match(/(?:^|\s)([A-Z][A-Z0-9_-]{1,15})\s*\|\s*([^|]{2,100})/);
    if (pipeMatch) {
      detected = { symbol: pipeMatch[1], symbolName: pipeMatch[2].trim() };
      break;
    }
    const productMatch = line.match(/(?:^|\s)商品\s+([A-Z][A-Z0-9_-]{1,15})\s+(.{2,100}?)(?=\s+(?:订立|转让|买价|买量|买入|卖出)\b|$)/);
    if (productMatch) {
      detected = { symbol: productMatch[1], symbolName: productMatch[2].trim() };
      break;
    }
  }
  return {
    symbol: detected.symbol,
    symbolName: detected.symbolName,
  };
}

export function parseHaohanPageSnapshot(snapshot = {}, { symbol = "DGJJ", timeframe = "15m", now = Date.now() } = {}) {
  const pageUrl = normalizeUrl(snapshot.url);
  const title = String(snapshot.title || "").slice(0, 160);
  const visibleText = String(snapshot.visibleText || "").replace(/\s+/g, " ").trim();
  const capturedAt = Number.isFinite(Number(snapshot.capturedAt)) ? Number(snapshot.capturedAt) : now;
  if (!isHaohanTarget(pageUrl)) return { ok: false, code: "BROWSER_TARGET_MISMATCH", message: "当前页面不是浩瀚数贸目标", page: { url: pageUrl, title } };
  const instrument = extractHaohanPageInstrument(snapshot);
  if (/#\/login(?:\?|$)/.test(String(snapshot.url || "")) || (!/最新价/.test(visibleText) && /登录|密码登录/.test(visibleText))) {
    return { ok: false, code: "REAUTH_REQUIRED", message: "目标网页登录态已失效，需要重新登录", page: { url: pageUrl, title, instrument }, instrument, observedAt: new Date(capturedAt).toISOString(), executionEnabled: false };
  }
  if (instrument.symbol && symbol && normalize(instrument.symbol) !== normalize(symbol)) {
    return {
      ok: false,
      code: "PAGE_INSTRUMENT_MISMATCH",
      message: `网页当前品种 ${instrument.symbol} 与任务配置 ${symbol} 不一致`,
      page: { url: pageUrl, title, instrument },
      instrument,
      requestedSymbol: String(symbol),
      executionEnabled: false,
    };
  }
  const resolvedSymbol = instrument.symbol || String(symbol || "");
  const resolvedSymbolName = instrument.symbolName || String(snapshot.symbolName || "").slice(0, 120);

  const price = positiveNumber(labeledValue(visibleText, ["最新价", "当前价", "现价"]));
  const changePct = labeledValue(visibleText, ["涨跌幅"]);
  const open = positiveNumber(labeledValue(visibleText, ["开盘价", "开盘"]));
  const high = positiveNumber(labeledValue(visibleText, ["最高价", "最高"]));
  const low = positiveNumber(labeledValue(visibleText, ["最低价", "最低"]));
  const settlement = labeledValue(visibleText, ["结算价"]);
  const inventory = labeledValue(visibleText, ["存货量"]);
  const positionChange = labeledValue(visibleText, ["仓差"]);
  const availableFunds = labeledValue(visibleText, ["可用资金"]);
  const riskRate = labeledValue(visibleText, ["风险率"]);
  const closed = /(?:^|\s)闭市(?:\s|$)/.test(visibleText);
  const tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
  const chartSamples = Array.isArray(snapshot.chartSamples) ? snapshot.chartSamples : [];
  const candles = [...parseTableCandles(tables, capturedAt), ...chartSamples.map((sample, index) => parseCandleText(sample, capturedAt - (chartSamples.length - index) * 60 * 1000)).filter(Boolean)]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((candle, index, list) => index === list.findIndex((item) => item.timestamp === candle.timestamp));
  const ticks = parseTicks(tables);
  const indicators = calculateIndicators(candles);
  const missingFields = [];
  if (price === null || price <= 0) missingFields.push("LATEST_PRICE");
  if (candles.length < 20) missingFields.push("HISTORY_INSUFFICIENT");
  if (open === null) missingFields.push("OPEN_PRICE");
  if (high === null) missingFields.push("HIGH_PRICE");
  if (low === null) missingFields.push("LOW_PRICE");
  if (candles.some((candle) => candle.partial)) missingFields.push("HISTORY_PARTIAL_OHLC");
  if (!ticks.length) missingFields.push("LIVE_TICKS_MISSING");
  if (closed) missingFields.push("MARKET_CLOSED");
  const observedAt = new Date(capturedAt).toISOString();
  const latestCandle = candles.at(-1);
  const latest = {
    price: round(price ?? latestCandle?.close, 6),
    open: round(open ?? latestCandle?.open, 6),
    high: round(high ?? latestCandle?.high, 6),
    low: round(low ?? latestCandle?.low, 6),
    volume: round(latestCandle?.volume ?? ticks.reduce((sum, tick) => sum + tick.volume, 0), 4),
    settlement: round(settlement, 6),
    inventory: round(inventory, 4),
    positionChange: round(positionChange, 4),
  };
  const contentFingerprint = crypto.createHash("sha256").update(JSON.stringify({ visibleText, tables, chartSamples })).digest("hex").slice(0, 24);
  const evidenceMaterial = JSON.stringify({ pageUrl, symbol: resolvedSymbol, timeframe, latest, historyCount: candles.length, observedAt, missingFields, contentFingerprint });
  const evidenceId = `market:${crypto.createHash("sha256").update(evidenceMaterial).digest("hex").slice(0, 18)}`;
  return {
    ok: latest.price !== null && latest.price > 0,
    code: latest.price !== null && latest.price > 0 ? "VISIBLE_PAGE_READ" : "VISIBLE_QUOTE_MISSING",
    message: latest.price !== null && latest.price > 0 ? "已读取目标网页可见数据" : "目标网页未显示有效最新价",
    source: "browser-dom",
    sourceKind: "visible-page",
    executionEnabled: false,
    page: { url: pageUrl, title, instrument },
    instrument,
    symbol: resolvedSymbol,
    symbolName: resolvedSymbolName,
    timeframe,
    history: candles.map((candle) => ({ ...candle, open: round(candle.open, 6), high: round(candle.high, 6), low: round(candle.low, 6), close: round(candle.close, 6), volume: round(candle.volume, 4) })),
    ticks,
    quote: latest,
    changePct: round(changePct, 4),
    indicators: {
      ema20: round(indicators.ema20, 6),
      rsi14: round(indicators.rsi14, 4),
      atr14: round(indicators.atr14, 6),
      volumeRatio: round(indicators.volumeRatio, 4),
    },
    trend: indicators.trend,
    anomaly: indicators.anomaly,
    freshnessSec: Math.max(0, Number(((now - capturedAt) / 1000).toFixed(2))),
    dataQuality: missingFields.length ? "LIMITED" : "VERIFIED",
    missingFields,
    marketClosed: closed,
    account: { availableFunds: round(availableFunds, 2), riskRate: round(riskRate, 4) },
    historyCount: candles.length,
    contentFingerprint,
    evidenceId,
    observedAt,
  };
}

export const haohanReadOnlyConfig = Object.freeze({
  host: HAO_HAN_HOST,
  targetUrl: HAO_HAN_TARGET_URL,
  source: "browser-dom",
  executionEnabled: false,
  blockedActions: Object.freeze(["buy", "sell", "submit", "cancel", "withdraw"]),
});
