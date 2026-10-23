import crypto from "node:crypto";

const DEFAULT_DIRECT_CONTEXT_BYTES = 220000;
const DEFAULT_SEGMENT_BYTES = 180000;
const DEFAULT_SEGMENT_ROWS = 1800;
const MAX_SEGMENT_BYTES = 240000;
const MAX_SEGMENT_ROWS = 2000;

function setting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || 0);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function byteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return Buffer.byteLength(text, "utf8");
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hash(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");
}

function sanitizeReadOnlyValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeReadOnlyValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/password|passwd|token|secret|api[_-]?key|cookie|authorization|sessionstr/i.test(key))
      .map(([key, item]) => [key, sanitizeReadOnlyValue(item)]));
  }
  return String(value);
}

export function compactMarketCandle(candle = {}) {
  return [
    finiteNumber(candle.timestamp),
    finiteNumber(candle.previousClose),
    finiteNumber(candle.open),
    finiteNumber(candle.high),
    finiteNumber(candle.low),
    finiteNumber(candle.close),
    finiteNumber(candle.volume),
    finiteNumber(candle.amount),
    finiteNumber(candle.inventory),
    candle.partial ? 1 : 0,
  ];
}

export function compactMarketTick(tick = {}) {
  return [
    finiteNumber(tick.timestamp),
    finiteNumber(tick.price),
    finiteNumber(tick.volume),
    finiteNumber(tick.referencePrice),
    finiteNumber(tick.averagePrice),
    String(tick.flag || ""),
  ];
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfUtcMinute(ms) {
  return Math.floor(Number(ms) / MINUTE_MS) * MINUTE_MS;
}

export function startOfShanghaiHour(ms) {
  const shifted = Number(ms) + SHANGHAI_OFFSET_MS;
  return Math.floor(shifted / HOUR_MS) * HOUR_MS - SHANGHAI_OFFSET_MS;
}

export function startOfShanghaiDay(ms) {
  const shifted = Number(ms) + SHANGHAI_OFFSET_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export function startOfShanghaiMonth(ms) {
  const shifted = new Date(Number(ms) + SHANGHAI_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
}

export function startOfPreviousShanghaiMonth(ms) {
  const shifted = new Date(Number(ms) + SHANGHAI_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() - 1, 1) - SHANGHAI_OFFSET_MS;
}

function maxNum(left, right) {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minNum(left, right) {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function addNum(left, right) {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  if (a === null && b === null) return null;
  return (a || 0) + (b || 0);
}

function mergeCandle(current, candle, timestamp) {
  if (!current) {
    return {
      timestamp,
      previousClose: finiteNumber(candle.previousClose),
      open: finiteNumber(candle.open ?? candle.close ?? candle.price),
      high: finiteNumber(candle.high ?? candle.close ?? candle.price),
      low: finiteNumber(candle.low ?? candle.close ?? candle.price),
      close: finiteNumber(candle.close ?? candle.price),
      volume: finiteNumber(candle.volume) ?? 0,
      amount: finiteNumber(candle.amount),
      inventory: finiteNumber(candle.inventory),
      partial: Boolean(candle.partial),
    };
  }
  return {
    timestamp,
    previousClose: current.previousClose,
    open: current.open,
    high: maxNum(current.high, candle.high ?? candle.close ?? candle.price),
    low: minNum(current.low, candle.low ?? candle.close ?? candle.price),
    close: finiteNumber(candle.close ?? candle.price) ?? current.close,
    volume: addNum(current.volume, candle.volume) ?? 0,
    amount: addNum(current.amount, candle.amount),
    inventory: finiteNumber(candle.inventory) ?? current.inventory,
    partial: Boolean(current.partial || candle.partial),
  };
}

function historyForTimeframe(market, timeframe) {
  const snapshot = market?.timeframes?.[timeframe];
  if (Array.isArray(snapshot?.history) && snapshot.history.length) return snapshot.history;
  if (String(market?.timeframe || "") === timeframe && Array.isArray(market?.history) && market.history.length) return market.history;
  return [];
}

export const LIVE_KLINE_PERIOD_MS = MINUTE_MS;
export const LIVE_KLINE_PRINT_OFFSET_MS = 50 * 1000;
export const LIVE_KLINE_PRINT_SECOND = 50;

export const LIVE_BOARD_STRATEGY = Object.freeze({
  id: "haohan-live-k50",
  loop: {
    summary: "普通入场只能由AI明确BUY/SELL决定；程序不从指标、盘口或预测字段推导开仓。AI负责下一根及随后1～3根K预测与入场择时，救单除外。程序独立读持仓汇总：多单bid-均价>=0.5点、空单均价-ask>=0.5点整行转让，超过1点也退出。亏损不足3点继续观察，达到3点反向救单；同商品多空汇总实时货值变化合计>=-1金额后整商品退出，触发后持续完成剩余方向。救单满10分钟未恢复时独立请求AI预测未来5分钟内可达离场价，到价退出该商品多空汇总；过期重新预测，汇总金额>=-1仍优先立即退出。收盘清仓保留，普通离场不等AI计划。",
    stages: ["OBSERVE", "ANALYZE", "RESULT", "ENTRY", "OBSERVE_WHILE_HOLDING", "EXIT"],
    aiCompletes: ["ANALYZE", "RESULT", "ENTRY_DIRECTION", "ENTRY_TIMING"],
    hostCompletes: ["OBSERVE_PAGE", "FEED_CONTEXT", "EXECUTE_AI_ENTRY", "MONITOR_SUMMARY_EXIT", "AUTOMATIC_RESCUE", "EXECUTE_VISIBLE_CLICKS"],
    entry: { emptyOnly: false, buyUp: "买入订立", buyDown: "卖出订立", decisionMode: "AI_ONLY", minimumProbability: null,
      timing: "买多预测阶段低位入、买空预测阶段高位入。只有AI顶层action明确BUY/SELL才可普通入场；程序仅执行与核实。MARKET不等待预测价，未到合适点位可HOLD或明确LIMIT挂单。",
      whileHolding: "普通持仓不锁新入场；单笔entryQuantity不是总持仓上限。同K及同一未成交意图防重复，救单期间禁止普通新开仓。" },
    exit: { whileHolding: true, positionList: ["持仓汇总", "转让"], priority: "BEFORE_ENTRY", decisionMode: "PROGRAM_ONLY",
      summaryProfitPoints: { minimum: 0.5, exitAboveTarget: true }, profitUnit: "DIRECTIONAL_PRICE_POINTS",
      rescueLossPoints: 3, recoveryAmount: -1, recoveryScope: "COMMODITY_LONG_SHORT_SUMMARIES", latchRecoveryExit: true, rescueTimeoutMinutes: 10, rescueForecastHorizonMinutes: 5,
      realtimeValueRule: "普通离场比较当前可成交bid/ask与订立均价，不乘数量。救单恢复只按同商品多空持仓汇总实时货值变化合计金额>=-1判断，账户总额不代替商品汇总。触发后继续平掉剩余方向，不等AI或净利>=0；未知费用仍未知。",
      onExitDecision: "SUMMARY_TRANSFER_IMMEDIATELY", automaticInBothEntryModes: true },
    noSecondEntryWhileHolding: false,
  },
  kline: {
    summary: "标准情况固定每分钟第50秒出K；正常约45秒至50秒之间出现。走完的K只作历史证据，近端预测针对下一根将在第50秒打印的K；AI用大趋势与延续路径判断入场；程序离场与救单独立按持仓汇总及当前可成交价执行，不等定K。报价/逐笔可能每秒更新，不要等整分:00收盘，也不要把已经走完的K当成预测目标。",
    printSecond: LIVE_KLINE_PRINT_SECOND,
    periodMs: LIVE_KLINE_PERIOD_MS,
    printOffsetMs: LIVE_KLINE_PRINT_OFFSET_MS,
    normalPrintWindowSec: [45, 50],
    closedBarsAreEvidenceOnly: true,
    forecastTarget: "NEXT_CANDLE",
    doNotWaitForMinuteCloseAt00: true,
    liveQuotesMayUpdateEverySecond: true,
    flashK: {
      summary: "闪K是未确认盘中事件，可能反映主动拉盘、砸盘、试盘或扫单，结合真实报价、逐笔和深度分析，不能一律判假、删除或忽略。未确认OHLC不进入已确认历史指标；新鲜bid/ask独立触发1点兑现与保护，不等K稳定。单次跳价不能证明操盘者身份或意图。",
      excludeTransientDisplayPriceFromAnalysis: false,
      analyzeTransientEvents: true,
      priceSpikeAloneProvesFlash: false,
      preserveVerifiedExecutableQuotes: true,
    },
  },
  analysis: {
    summary: "分析期间每2秒独立读取盘面并监控AI已授权条件；持仓、已确认K线证据变化或已有保护条件触发时中止旧分析；普通跳价在结果返回后复核，仅执行仍满足的AI条件，读取最新数据重算；新结果执行前和弹窗确认前再次核对。",
    waitForResult: true,
    invalidateOnMarketChange: true,
    independentObservationIntervalMs: 2000,
    onComplete: "CONTINUE_NEXT_ROUND",
  },
  counterparty: {
    summary: "对盘可能由AI控盘。必须从盘口、出K时点、补量、重复手数和每分钟第50秒附近的同步行为寻找对策，禁止把猜测写成事实。",
    mayBeAiControlled: true,
    requireCountermeasures: true,
  },
});

export function analysisTimeoutMs() {
  const configured = Number(process.env.ANALYSIS_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(20, Math.round(configured));
  return 0;
}

export function analysisNow(market = {}, nowMs = null) {
  return finiteNumber(nowMs)
    || finiteNumber(new Date(market.observedAt || "").getTime())
    || Date.now();
}

export function lastKlinePrintTime(nowMs) {
  const now = Number(nowMs);
  const minuteStart = Math.floor(now / LIVE_KLINE_PERIOD_MS) * LIVE_KLINE_PERIOD_MS;
  const thisPrint = minuteStart + LIVE_KLINE_PRINT_OFFSET_MS;
  return now >= thisPrint ? thisPrint : thisPrint - LIVE_KLINE_PERIOD_MS;
}

export function nextKlinePrintTime(nowMs) {
  return lastKlinePrintTime(nowMs) + LIVE_KLINE_PERIOD_MS;
}

export function liveBarPeriodMs(_market = {}) {
  return LIVE_KLINE_PERIOD_MS;
}

function alignPeriod(ms, periodMs) {
  const period = Math.max(1000, Number(periodMs) || 1000);
  return Math.floor(Number(ms) / period) * period;
}

export function closedCandlesForAnalysis(history, nowMs, periodMs = MINUTE_MS) {
  const openTime = alignPeriod(nowMs, periodMs);
  return (Array.isArray(history) ? history : []).filter((candle) => {
    const timestamp = finiteNumber(candle?.timestamp);
    return timestamp !== null && alignPeriod(timestamp, periodMs) < openTime;
  });
}

// A page can expose the current minute candle before the exchange prints it.
// It is still changing, so it must never enter the fixed-candle history sent
// to the model. Live ticks remain available through nextCandle/timeline.
export function confirmedCandlesForAnalysis(history, timeframe, nowMs = Date.now()) {
  const values = (Array.isArray(history) ? history : []).filter((candle) => candle?.partial !== true && candle?.confirmation?.status !== "PROVISIONAL");
  if (String(timeframe || "") !== "1m") return values;
  const cutoff = lastKlinePrintTime(nowMs);
  return values.filter((candle) => {
    const timestamp = finiteNumber(candle?.timestamp);
    const printAt = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS + LIVE_KLINE_PRINT_OFFSET_MS;
    return timestamp !== null && timestamp <= cutoff
      && (candle.confirmation?.status === "CONFIRMED" || printAt < Math.floor(nowMs / MINUTE_MS) * MINUTE_MS);
  });
}

function recentLiveTicks(ticks, nowMs, windowMs = MINUTE_MS) {
  return (Array.isArray(ticks) ? ticks : []).filter((tick) => {
    const timestamp = finiteNumber(tick?.timestamp);
    return timestamp !== null && timestamp >= nowMs - windowMs && timestamp <= nowMs;
  }).slice(-120);
}

export function nextCandleTarget(market = {}, nowMs = null) {
  const now = analysisNow(market, nowMs);
  const periodMs = LIVE_KLINE_PERIOD_MS;
  const lastPrint = lastKlinePrintTime(now);
  const nextPrint = lastPrint + periodMs;
  const minuteHistory = historyForTimeframe(market, "1m");
  const closedMinutes = confirmedCandlesForAnalysis(minuteHistory, "1m", now);
  const lastClosed = closedMinutes.at(-1) || null;
  const liveTicks = recentLiveTicks(market.ticks, now);
  const formingTicks = ticksAsCandles(liveTicks).filter((candle) => {
    const timestamp = finiteNumber(candle?.timestamp);
    return timestamp !== null && timestamp >= lastPrint && timestamp < nextPrint;
  });
  const forming = formingTicks.reduce((current, candle) => mergeCandle(current, candle, lastPrint), null);
  const latestTickPrice = finiteNumber(liveTicks.at(-1)?.price);
  const livePrice = finiteNumber(market?.quote?.price ?? market?.latest?.price ?? latestTickPrice ?? forming?.close);
  const open = finiteNumber(forming?.open ?? market?.quote?.open) ?? livePrice;
  const high = maxNum(maxNum(forming?.high, market?.quote?.high), livePrice);
  const low = minNum(minNum(forming?.low, market?.quote?.low), livePrice);
  return {
    timeframe: "1m",
    periodMs,
    printSecond: LIVE_KLINE_PRINT_SECOND,
    printOffsetMs: LIVE_KLINE_PRINT_OFFSET_MS,
    kind: "NEXT_CANDLE",
    openTime: lastPrint,
    closeTime: nextPrint,
    lastClosedTime: lastClosed?.timestamp ?? null,
    lastClosedClose: lastClosed?.close ?? null,
    livePrice,
    open,
    high,
    low,
    close: livePrice,
    volume: finiteNumber(forming?.volume ?? market?.quote?.volume),
    elapsedMs: Math.max(0, now - lastPrint),
    remainingMs: Math.max(0, nextPrint - now),
    partial: true,
    standardPrint: "each minute at second 50",
  };
}

function sliceCandles(history, start, end, includeEnd = false) {
  return (Array.isArray(history) ? history : []).filter((candle) => {
    const timestamp = finiteNumber(candle?.timestamp);
    if (timestamp === null || timestamp < start) return false;
    return includeEnd ? timestamp <= end : timestamp < end;
  });
}

function aggregateCandles(history, start, end, align, includeEnd = false) {
  const buckets = new Map();
  for (const candle of Array.isArray(history) ? history : []) {
    const timestamp = finiteNumber(candle?.timestamp);
    if (timestamp === null || timestamp < start) continue;
    if (includeEnd ? timestamp > end : timestamp >= end) continue;
    const key = align(timestamp);
    if (key < start || (includeEnd ? key > end : key >= end)) continue;
    buckets.set(key, mergeCandle(buckets.get(key), candle, key));
  }
  return [...buckets.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function ticksAsCandles(ticks) {
  return (Array.isArray(ticks) ? ticks : []).map((tick) => ({
    timestamp: tick.timestamp,
    open: tick.price,
    high: tick.price,
    low: tick.price,
    close: tick.price,
    volume: tick.volume,
    amount: null,
    inventory: null,
    previousClose: tick.referencePrice ?? null,
    partial: true,
  }));
}

function layerCandles(market, { timeframe, start, end, includeEnd, align, sources }) {
  for (const source of sources) {
    const history = source === "ticks" ? ticksAsCandles(market.ticks) : historyForTimeframe(market, source);
    if (source === timeframe) {
      const native = sliceCandles(history, start, end, includeEnd);
      if (native.length) return native;
      continue;
    }
    const aggregated = aggregateCandles(history, start, end, align, includeEnd);
    if (aggregated.length) return aggregated;
  }
  return [];
}

export function analysisLayerWindows(nowMs = Date.now()) {
  const now = Number(nowMs);
  const oneHourAgo = now - HOUR_MS;
  const yesterdayStart = startOfShanghaiDay(now) - DAY_MS;
  const lastMonthStart = startOfPreviousShanghaiMonth(now);
  return {
    timezone: "Asia/Shanghai",
    now,
    layers: [
      { timeframe: "1m", label: "近1小时·分钟", start: oneHourAgo, end: now, includeEnd: true, align: startOfUtcMinute, sources: ["1m", "ticks"] },
      { timeframe: "1h", label: "昨晨至1小时前·小时", start: yesterdayStart, end: oneHourAgo, includeEnd: false, align: startOfShanghaiHour, sources: ["1h", "1m"] },
      { timeframe: "1d", label: "上月至昨天·日", start: lastMonthStart, end: yesterdayStart, includeEnd: false, align: startOfShanghaiDay, sources: ["1d", "1h", "1m"] },
      { timeframe: "1mo", label: "上月以前·月", start: 0, end: lastMonthStart, includeEnd: false, align: startOfShanghaiMonth, sources: ["1mo", "1d", "1h", "1m"] },
    ],
  };
}

export function buildLayeredAnalysisMarket(market = {}, nowMs = null) {
  const now = analysisNow(market, nowMs);
  market = excludeUnconfirmedAnalysisData(market, now);
  const windows = analysisLayerWindows(now);
  const timeframes = {};
  const layers = windows.layers.map((layer) => {
    const sourceSnapshot = market.timeframes?.[layer.timeframe] || {};
    const history = confirmedCandlesForAnalysis(
      layerCandles(market, layer),
      layer.timeframe,
      now,
    );
    timeframes[layer.timeframe] = {
      timeframe: layer.timeframe,
      label: layer.label,
      history,
      historyCount: history.length,
      completeHistoryCount: history.filter((candle) => !candle.partial).length,
      firstTimestamp: history[0]?.timestamp || null,
      lastTimestamp: history.at(-1)?.timestamp || null,
      dataQuality: history.length ? "LAYERED" : "EMPTY",
      missingFields: history.length ? [] : [`LAYER_${layer.timeframe.toUpperCase()}_EMPTY`],
      analysisLayer: { start: layer.start, end: layer.end, timezone: windows.timezone },
      ok: history.length > 0,
      trend: "unknown",
      anomaly: false,
      indicators: {},
    };
    return { timeframe: layer.timeframe, label: layer.label, start: layer.start, end: layer.end, rowCount: history.length };
  });
  const primary = ["1m", "1h", "1d", "1mo"].find((timeframe) => timeframes[timeframe]?.historyCount) || "1m";
  const history = timeframes[primary]?.history || [];
  const nextCandle = nextCandleTarget({
    ...market,
    quote: market.quote,
    latest: market.latest || market.quote,
  }, now);
  const liveTicks = recentLiveTicks(market.ticks, now);
  const raw = market.raw && typeof market.raw === "object" && !Array.isArray(market.raw)
    ? Object.fromEntries(Object.entries(market.raw).filter(([key]) => key !== "timeline"))
    : market.raw;
  const layeredBooks = Array.isArray(market.books)
    ? market.books.map((book) => {
      if (!book || typeof book !== "object") return null;
      const rest = { ...book };
      delete rest.books;
      return buildLayeredAnalysisMarket(rest, now);
    }).filter(Boolean)
    : [];
  if (timeframes["1m"]) timeframes["1m"].nextCandle = nextCandle;
  return {
    ...market,
    timeframe: primary,
    history,
    historyCount: history.length,
    completeHistoryCount: timeframes[primary]?.completeHistoryCount || 0,
    nextCandle,
    strategy: LIVE_BOARD_STRATEGY,
    ticks: liveTicks,
    timeline: { kind: "live", ticks: liveTicks, tickCount: liveTicks.length },
    timeframes,
    availableTimeframes: ["1m", "1h", "1d", "1mo"],
    analysisLayers: { timezone: windows.timezone, now, layers },
    books: layeredBooks,
    bookCount: layeredBooks.length,
    raw,
    operatorContext: operatorContext(market),
  };
}

// Empty-position controller polls use the latest minute window; open positions keep full layered K-lines for exit timing.
export function buildRecentMonitoringMarket(market = {}, nowMs = null) {
  const layered = market?.analysisLayers ? market : buildLayeredAnalysisMarket(market, nowMs);
  const recent = layered.timeframes?.["1m"] || {
    timeframe: "1m",
    label: "近1小时·分钟",
    history: [],
    historyCount: 0,
    completeHistoryCount: 0,
    dataQuality: "EMPTY",
    missingFields: ["LAYER_1M_EMPTY"],
    analysisLayer: layered.analysisLayers?.layers?.[0] || null,
    ok: false,
    trend: "unknown",
    anomaly: false,
    indicators: {},
  };
  const books = Array.isArray(layered.books)
    ? layered.books.map((book) => buildRecentMonitoringMarket(book, layered.analysisLayers?.now)).filter(Boolean)
    : [];
  return {
    ...layered,
    timeframe: "1m",
    history: recent.history || [],
    historyCount: recent.historyCount ?? recent.history?.length ?? 0,
    completeHistoryCount: recent.completeHistoryCount ?? 0,
    timeframes: { "1m": recent },
    availableTimeframes: ["1m"],
    analysisLayers: layered.analysisLayers ? { ...layered.analysisLayers, layers: layered.analysisLayers.layers?.slice(0, 1) || [] } : null,
    nextCandle: layered.nextCandle || nextCandleTarget(layered, nowMs),
    strategy: layered.strategy || LIVE_BOARD_STRATEGY,
    books,
    bookCount: books.length,
  };
}

export function describeAnalysisLayers(market = {}) {
  const layers = market?.analysisLayers?.layers;
  if (!Array.isArray(layers) || !layers.length) return "未分层";
  return layers.map((layer) => `${layer.label} ${layer.rowCount} 根`).join("，");
}

function chunkRows(rows, maxRows, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = byteLength(row);
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && (current.length >= maxRows || currentBytes + separatorBytes + rowBytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += (current.length > 1 ? 1 : 0) + rowBytes;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

function serializedFragments(value, maxBytes) {
  const serialized = JSON.stringify(sanitizeReadOnlyValue(value ?? null));
  if (byteLength(serialized) <= maxBytes) return [serialized];
  const fragments = [];
  let current = "";
  let currentBytes = 0;
  for (const character of serialized) {
    const characterBytes = byteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      fragments.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) fragments.push(current);
  return fragments;
}

function timeframeEntries(market) {
  const entries = Object.entries(market?.timeframes || {})
    .filter(([, snapshot]) => snapshot && typeof snapshot === "object")
    .sort(([left], [right]) => left.localeCompare(right));
  const primaryTimeframe = String(market?.timeframe || "15m");
  if (!entries.length) return [[primaryTimeframe, { timeframe: primaryTimeframe, history: market?.history || [], historyCount: market?.history?.length || 0 }]];
  if (!entries.some(([key]) => key === primaryTimeframe) && Array.isArray(market?.history) && market.history.length) {
    entries.push([primaryTimeframe, { timeframe: primaryTimeframe, history: market.history, historyCount: market.history.length }]);
  }
  return entries;
}

function segmentBase({ fingerprint, kind, timeframe = "", index, rowStart = null, rowEnd = null, rowCount = 0, firstTimestamp = null, lastTimestamp = null, metadata = {}, rows = [], payloadFragment = null, payloadIndex = null, payloadCount = null, payloadHash = "" }) {
  const content = { rows, payloadFragment, metadata };
  return {
    segmentId: `segment:${fingerprint || "snapshot"}:${kind}:${timeframe || "global"}:${index}`,
    kind,
    timeframe,
    segmentIndex: index,
    rowStart,
    rowEnd,
    rowCount,
    firstTimestamp,
    lastTimestamp,
    metadata,
    rows,
    ...(payloadFragment === null ? {} : { payloadFragment, payloadEncoding: "json", payloadIndex, payloadCount, payloadHash }),
    contentHash: hash(content),
  };
}

function timeframeMetadata(timeframe, snapshot, history) {
  return sanitizeReadOnlyValue({
    timeframe,
    label: snapshot.label || timeframe,
    period: snapshot.period ?? null,
    trend: snapshot.trend || "unknown",
    anomaly: Boolean(snapshot.anomaly),
    flashK: snapshot.flashK || null,
    intrabarEvidence: snapshot.intrabarEvidence || null,
    indicators: snapshot.indicators || null,
    dataQuality: snapshot.dataQuality || "UNKNOWN",
    missingFields: Array.isArray(snapshot.missingFields) ? snapshot.missingFields : [],
    requestedCount: snapshot.requestedCount ?? history.length,
    historyCount: snapshot.historyCount ?? history.length,
    completeHistoryCount: snapshot.completeHistoryCount ?? 0,
    firstTimestamp: history[0]?.timestamp || null,
    lastTimestamp: history.at(-1)?.timestamp || null,
  });
}

// Keep unconfirmed intrabar events separate from confirmed-history indicators.
// Remove duplicated derived chart/page copies while preserving quotes and ticks.
function excludeUnconfirmedAnalysisData(market, now) {
  const excluded = [];
  const cleanSnapshot = (snapshot, timeframe) => {
    const original = snapshot.history || [];
    const history = confirmedCandlesForAnalysis(original, timeframe, now);
    const kept = new Set(history);
    const removed = original.filter(c => !kept.has(c));
    excluded.push(...removed);
    return { ...snapshot, history, historyCount: history.length,
      ...(removed.length || snapshot.flashK?.suspected ? { indicators: {}, trend: "unknown", anomaly: false, rawData: undefined } : {}) };
  };
  const timeframes = Object.fromEntries(Object.entries(market.timeframes || {}).map(([key, snapshot]) => [key, cleanSnapshot(snapshot, snapshot.timeframe || key)]));
  const primary = cleanSnapshot(market, market.timeframe || "1m");
  const dirty = excluded.length > 0 || market.flashK?.suspected;
  const quote = value => !value || !dirty ? value : { ...value, open: null, high: null, low: null, changePct: null, quoteChangePct: null };
  const ticks = Array.isArray(market.ticks) ? market.ticks : [];
  // Preserve intrabar observations as labelled evidence, never confirmed bars.
  const intrabarEvidence = market.intrabarEvidence || (dirty ? {
    confirmed: false, source: "LIVE_DISPLAY", candles: excluded.slice(-3).map(compactMarketCandle),
    transientEvent: market.flashK?.suspected ? market.flashK : null,
    limitations: "盘中显示不证明成交或操盘者身份；结合实时可成交报价、逐笔与深度判断拉盘/砸盘及回吐风险",
  } : null);
  return { ...primary, timeframes, ticks, intrabarEvidence, quote: quote(market.quote), latest: quote(market.latest),
    books: (market.books || []).map(book => excludeUnconfirmedAnalysisData(book, now)),
    ...(dirty ? { indicators: {}, trend: "unknown", anomaly: false, changePct: null, raw: undefined,
      page: market.page ? { url: market.page.url, title: market.page.title, instrument: market.page.instrument } : null,
      pageView: market.pageView ? { instrument: market.pageView.instrument, orderBook: market.pageView.orderBook } : null,
      candleEvidence: { excludedCount: excluded.length, reason: "UNCONFIRMED_HISTORY_ONLY", derivedIndicatorsExcluded: true } } : {}) };
}

// Normalized OHLCV and page fields are canonical; raw API copies repeat the same rows.
export function compactCollectedMarket(market = {}) {
  const { raw, ...result } = market;
  result.timeframes = Object.fromEntries(Object.entries(market.timeframes || {}).map(([key, snapshot]) => {
    const { rawData, ...fields } = snapshot;
    return [key, fields];
  }));
  if (market.page) {
    const { klines, ...page } = market.page;
    result.page = page;
  }
  result.books = (market.books || []).map(compactCollectedMarket);
  return result;
}

export function estimateMarketContextBytes(market = {}) {
  return byteLength(sanitizeReadOnlyValue(market));
}

export function shouldUseSegmentedAnalysis(market = {}) {
  if (process.env.ANALYSIS_FORCE_SEGMENTED === "1") return true;
  return estimateMarketContextBytes(market) > setting("ANALYSIS_DIRECT_CONTEXT_MAX_BYTES", DEFAULT_DIRECT_CONTEXT_BYTES, 20000, 1000000);
}

export function buildMarketAnalysisSegments(market = {}, options = {}) {
  const fingerprint = String(market.fingerprint || "");
  const now = analysisNow(market, options.nowMs);
  market = excludeUnconfirmedAnalysisData(market, now);
  const maxRows = Math.round(Math.min(MAX_SEGMENT_ROWS, Math.max(20, Number(options.maxRows || setting("ANALYSIS_SEGMENT_ROWS", DEFAULT_SEGMENT_ROWS, 20, MAX_SEGMENT_ROWS)))));
  const maxBytes = Math.round(Math.min(MAX_SEGMENT_BYTES, Math.max(20000, Number(options.maxBytes || setting("ANALYSIS_SEGMENT_BYTES", DEFAULT_SEGMENT_BYTES, 20000, MAX_SEGMENT_BYTES)))));
  const rowBudget = Math.max(12000, maxBytes - 1800);
  const segments = [];
  let nextIndex = 0;
  const coverageByTimeframe = [];

  for (const [timeframeKey, rawSnapshot] of timeframeEntries(market)) {
    const timeframe = String(rawSnapshot.timeframe || timeframeKey);
    const snapshot = sanitizeReadOnlyValue(rawSnapshot);
    const history = confirmedCandlesForAnalysis(
      rawSnapshot.history,
      timeframe,
      now,
    );
    const rows = history.map(compactMarketCandle);
    const chunks = history.length ? chunkRows(rows, maxRows, rowBudget) : [];
    const timeframeStart = segments.length;
    let rowOffset = 0;
    chunks.forEach((chunk) => {
      const start = rowOffset;
      rowOffset += chunk.length;
      const sourceRows = history.slice(start, start + chunk.length);
      segments.push(segmentBase({
        fingerprint,
        kind: "kline",
        timeframe,
        index: nextIndex++,
        rowStart: start,
        rowEnd: start + chunk.length,
        rowCount: chunk.length,
        firstTimestamp: sourceRows[0]?.timestamp || null,
        lastTimestamp: sourceRows.at(-1)?.timestamp || null,
        metadata: timeframeMetadata(timeframe, snapshot, history),
        rows: chunk,
      }));
    });
    const timeframeTicks = rawSnapshot.ticks || [];
    if (timeframeTicks.length) {
      const tickRows = timeframeTicks.map(compactMarketTick);
      let tickOffset = 0;
      chunkRows(tickRows, maxRows, rowBudget).forEach((chunk) => {
        const start = tickOffset;
        tickOffset += chunk.length;
        const sourceRows = timeframeTicks.slice(start, start + chunk.length);
        segments.push(segmentBase({
          fingerprint,
          kind: "timeframe_ticks",
          timeframe,
          index: nextIndex++,
          rowStart: start,
          rowEnd: start + chunk.length,
          rowCount: chunk.length,
          firstTimestamp: sourceRows[0]?.timestamp || null,
          lastTimestamp: sourceRows.at(-1)?.timestamp || null,
          metadata: timeframeMetadata(timeframe, snapshot, history),
          rows: chunk,
        }));
      });
    }
    coverageByTimeframe.push({
      timeframe,
      requestedRows: rows.length,
      coveredRows: rows.length,
      segments: segments.slice(timeframeStart).filter((segment) => segment.kind === "kline").length,
      firstTimestamp: history[0]?.timestamp || null,
      lastTimestamp: history.at(-1)?.timestamp || null,
      contentHash: hash(rows),
      dataQuality: snapshot.dataQuality || "UNKNOWN",
      missingFields: Array.isArray(snapshot.missingFields) ? snapshot.missingFields : [],
    });
  }

  const primarySymbol = String(market.symbol || "").trim().toLowerCase();
  for (const book of Array.isArray(market.books) ? market.books : []) {
    if (!book || typeof book !== "object") continue;
    if (String(book.symbol || "").trim().toLowerCase() === primarySymbol) continue;
    for (const [timeframeKey, rawSnapshot] of timeframeEntries(book)) {
      const timeframe = String(rawSnapshot.timeframe || timeframeKey);
      const snapshot = sanitizeReadOnlyValue(rawSnapshot);
      const history = confirmedCandlesForAnalysis(
        rawSnapshot.history,
        timeframe,
        now,
      );
      const rows = history.map(compactMarketCandle);
      const chunks = history.length ? chunkRows(rows, maxRows, rowBudget) : [];
      chunks.forEach((chunk, chunkIndex) => {
        const start = chunks.slice(0, chunkIndex).reduce((sum, item) => sum + item.length, 0);
        const sourceRows = history.slice(start, start + chunk.length);
        segments.push(segmentBase({
          fingerprint,
          kind: "kline",
          timeframe,
          index: nextIndex++,
          rowStart: start,
          rowEnd: start + chunk.length,
          rowCount: chunk.length,
          firstTimestamp: sourceRows[0]?.timestamp || null,
          lastTimestamp: sourceRows.at(-1)?.timestamp || null,
          metadata: { ...timeframeMetadata(timeframe, snapshot, history), symbol: book.symbol, symbolName: book.symbolName, instrumentId: book.instrumentId || null },
          rows: chunk,
        }));
      });
    }
  }

  const ticks = Array.isArray(market.ticks) ? market.ticks : [];
  let liveTickOffset = 0;
  if (ticks.length) {
    chunkRows(ticks.map(compactMarketTick), maxRows, rowBudget).forEach((chunk) => {
      const start = liveTickOffset;
      liveTickOffset += chunk.length;
      const sourceRows = ticks.slice(start, start + chunk.length);
      segments.push(segmentBase({
        fingerprint,
        kind: "live_ticks",
        index: nextIndex++,
        rowStart: start,
        rowEnd: start + chunk.length,
        rowCount: chunk.length,
        firstTimestamp: sourceRows[0]?.timestamp || null,
        lastTimestamp: sourceRows.at(-1)?.timestamp || null,
        metadata: { source: "live_timeline", totalRows: ticks.length },
        rows: chunk,
      }));
    });
  }

  const contextPayload = sanitizeReadOnlyValue({
    symbol: market.symbol,
    symbolName: market.symbolName,
    instrumentId: market.instrumentId,
    instrument: market.instrument,
    quote: market.quote || market.latest,
    intrabarEvidence: market.intrabarEvidence || null,
    flashK: market.flashK || null,
    account: market.account,
    pageView: market.pageView || market.page?.view || null,
    orderBook: market.orderBook || null,
    books: (market.books || []).map((book) => ({ symbol: book.symbol, symbolName: book.symbolName, instrumentId: book.instrumentId, intrabarEvidence: book.intrabarEvidence || null, flashK: book.flashK || null, orderBook: book.orderBook || book.pageView?.orderBook || null })),
    changePct: market.changePct,
    marketClosed: market.marketClosed,
    source: market.source,
    dataAt: market.dataAt,
    observedAt: market.observedAt,
  });
  segments.push(segmentBase({ fingerprint, kind: "snapshot_context", index: nextIndex++, metadata: { fields: Object.keys(contextPayload) }, payloadFragment: JSON.stringify(contextPayload), payloadIndex: 0, payloadCount: 1, payloadHash: hash(contextPayload) }));

  for (const [kind, payload] of [["page", market.page], ["raw_readonly", market.raw]]) {
    if (payload === null || payload === undefined) continue;
    const payloadHash = hash(sanitizeReadOnlyValue(payload));
    const fragments = serializedFragments(payload, rowBudget);
    fragments.forEach((payloadFragment, payloadIndex) => {
      segments.push(segmentBase({
        fingerprint,
        kind,
        index: nextIndex++,
        metadata: { fragmentOf: kind, fragmentIndex: payloadIndex, fragmentCount: fragments.length },
        payloadFragment,
        payloadIndex,
        payloadCount: fragments.length,
        payloadHash,
      }));
    });
  }

  const totalKlineRows = coverageByTimeframe.reduce((sum, item) => sum + item.requestedRows, 0);
  const coverage = {
    mode: "segmented_full_coverage",
    fingerprint,
    totalSegments: segments.length,
    totalKlineRows,
    totalLiveTickRows: ticks.length,
    totalPayloadSegments: segments.filter((segment) => segment.payloadFragment !== undefined).length,
    timeframes: coverageByTimeframe,
    complete: true,
  };
  return { segments, coverage, maxRows, maxBytes, estimatedDirectBytes: estimateMarketContextBytes(market) };
}

function recentRows(history, limit, mapper) {
  const values = Array.isArray(history) ? history.slice(-limit) : [];
  return values.map(mapper);
}

function operatorContext(market = {}) {
  const books = Array.isArray(market.books) ? market.books : [];
  const ticks = Array.isArray(market.ticks) ? market.ticks : [];
  const orderBooks = [market, ...books].map((book) => book?.orderBook || book?.pageView?.orderBook).filter(Boolean);
  const levels = orderBooks.reduce((count, book) => count + (book.bids?.length || 0) + (book.asks?.length || 0), 0);
  const intervals = ticks.slice(1).map((tick, index) => Number(tick.timestamp) - Number(ticks[index].timestamp)).filter((value) => Number.isFinite(value) && value > 0);
  const fixedInterval = intervals.length >= 4 && new Set(intervals.map((value) => Math.round(value / 1000))).size <= 2;
  return {
    observationCount: ticks.length,
    orderBookSnapshotCount: orderBooks.length,
    visibleOrderBookLevelCount: levels,
    fixedIntervalTickPattern: intervals.length >= 4 ? fixedInterval : null,
    tickIntervalSampleMs: intervals.slice(-12),
    automationSignals: fixedInterval ? ["FIXED_INTERVAL_TICKS"] : [],
    limitations: [
      "仅凭公开盘口、K 线和逐笔数据不能确认操盘者身份",
      "缺少撤单、改单、订单来源和跨账户关联数据",
      "对盘可能AI控盘，第50秒出K附近的同步行为只是对策线索，不是身份证明",
    ],
  };
}

export function summarizeMarketForDecision(market = {}, coverage = null, { recentRowsPerTimeframe = 120 } = {}) {
  const now = analysisNow(market);
  market = excludeUnconfirmedAnalysisData(market, now);
  const timeframes = {};
  for (const [key, rawSnapshot] of timeframeEntries(market)) {
    const snapshot = rawSnapshot || {};
    const history = confirmedCandlesForAnalysis(
      snapshot.history,
      snapshot.timeframe || key,
      now,
    );
    timeframes[key] = {
      timeframe: snapshot.timeframe || key,
      label: snapshot.label || key,
      period: snapshot.period ?? null,
      trend: snapshot.trend || "unknown",
      anomaly: Boolean(snapshot.anomaly),
      flashK: snapshot.flashK || null,
    intrabarEvidence: snapshot.intrabarEvidence || null,
      indicators: snapshot.indicators || null,
      dataQuality: snapshot.dataQuality || "UNKNOWN",
      missingFields: Array.isArray(snapshot.missingFields) ? snapshot.missingFields : [],
      historyCount: history.length,
      completeHistoryCount: history.filter((candle) => !candle?.partial).length,
      firstTimestamp: history[0]?.timestamp || null,
      lastTimestamp: history.at(-1)?.timestamp || null,
      recentHistory: recentRows(history, recentRowsPerTimeframe, compactMarketCandle),
      analysisLayer: snapshot.analysisLayer || null,
    };
  }
  return sanitizeReadOnlyValue({
    symbol: market.symbol,
    symbolName: market.symbolName,
    instrumentId: market.instrumentId,
    instrument: market.instrument,
    timeframe: market.timeframe,
    latest: market.latest || market.quote,
    quote: market.quote || market.latest,
    changePct: market.changePct,
    indicators: market.indicators,
    trend: market.trend,
    anomaly: market.anomaly,
    flashK: market.flashK || null,
    intrabarEvidence: market.intrabarEvidence || null,
    freshnessSec: market.freshnessSec,
    dataQuality: market.dataQuality,
    missingFields: market.missingFields || [],
    marketClosed: Boolean(market.marketClosed),
    historyCount: market.historyCount || market.history?.length || 0,
    completeHistoryCount: market.completeHistoryCount || 0,
    timeframes,
    analysisLayers: market.analysisLayers || null,
    nextCandle: market.nextCandle || null,
    strategy: market.strategy || LIVE_BOARD_STRATEGY,
    bookCount: Array.isArray(market.books) ? market.books.length : 0,
    expectedBookCount: Number(market.expectedBookCount || market.boardCoverage?.expected || market.books?.length || 0),
    boardCoverage: market.boardCoverage || null,
    books: (Array.isArray(market.books) ? market.books : []).map((book) => ({
      symbol: book.symbol,
      symbolName: book.symbolName,
      instrumentId: book.instrumentId,
      latest: book.latest || book.quote,
      quote: book.quote || book.latest,
      orderBook: book.orderBook || book.pageView?.orderBook || null,
      pageView: book.pageView || null,
      changePct: book.changePct,
      trend: book.trend,
      flashK: book.flashK || null,
      intrabarEvidence: book.intrabarEvidence || null,
      dataQuality: book.dataQuality,
      missingFields: Array.isArray(book.missingFields) ? book.missingFields : [],
      historyCount: book.historyCount || book.history?.length || 0,
      completeHistoryCount: book.completeHistoryCount || 0,
      timeframes: Object.fromEntries(Object.entries(book.timeframes || {}).map(([key, snapshot]) => [key, {
        timeframe: snapshot.timeframe || key,
        label: snapshot.label || key,
        trend: snapshot.trend || "unknown",
        historyCount: snapshot.historyCount ?? snapshot.history?.length ?? 0,
        completeHistoryCount: snapshot.completeHistoryCount ?? 0,
        recentHistory: recentRows(snapshot.history, recentRowsPerTimeframe, compactMarketCandle),
      }])),
    })),
    liveTicks: Array.isArray(market.ticks) ? market.ticks.slice(-120) : [],
    page: market.page ? {
      url: market.page.url || "",
      title: market.page.title || "",
      visibleText: String(market.page.visibleText || "").slice(0, 16000),
      tables: Array.isArray(market.page.tables) ? market.page.tables.slice(0, 120) : [],
      chartSamples: Array.isArray(market.page.chartSamples) ? market.page.chartSamples.slice(-240) : [],
      instrument: market.page.instrument || null,
      view: market.page.view || market.pageView || null,
    } : null,
    account: market.account || null,
    positions: Array.isArray(market.account?.positions) ? market.account.positions : [],
    pageView: market.pageView || market.page?.view || null,
    orderBook: market.orderBook || null,
    source: market.source,
    sourceKind: market.sourceKind,
    dataAt: market.dataAt,
    observedAt: market.observedAt,
    coverage,
    operatorContext: operatorContext(market),
  });
}

export function compactSegmentReview(review = {}) {
  return {
    segmentId: String(review.segmentId || ""),
    kind: String(review.kind || ""),
    timeframe: String(review.timeframe || ""),
    rowCount: Number(review.rowCount || 0),
    contentHash: String(review.contentHash || ""),
    summary: String(review.summary || "").slice(0, 1800),
    trend: String(review.trend || "unknown").slice(0, 80),
    bullishEvidence: Array.isArray(review.bullishEvidence) ? review.bullishEvidence.slice(0, 12) : [],
    bearishEvidence: Array.isArray(review.bearishEvidence) ? review.bearishEvidence.slice(0, 12) : [],
    riskFlags: Array.isArray(review.riskFlags) ? review.riskFlags.slice(0, 20) : [],
    keyLevels: Array.isArray(review.keyLevels) ? review.keyLevels.slice(0, 12) : [],
    confidence: Number(review.confidence || 0),
  };
}
