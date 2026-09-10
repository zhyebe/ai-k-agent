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
  const now = finiteNumber(nowMs)
    || finiteNumber(new Date(market.dataAt || "").getTime())
    || finiteNumber(new Date(market.observedAt || "").getTime())
    || Date.now();
  const windows = analysisLayerWindows(now);
  const timeframes = {};
  const layers = windows.layers.map((layer) => {
    const history = layerCandles(market, layer);
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
  const raw = market.raw && typeof market.raw === "object" && !Array.isArray(market.raw)
    ? Object.fromEntries(Object.entries(market.raw).filter(([key]) => key !== "timeline"))
    : market.raw;
  return {
    ...market,
    timeframe: primary,
    history,
    historyCount: history.length,
    completeHistoryCount: timeframes[primary]?.completeHistoryCount || 0,
    ticks: [],
    timeline: { kind: "layered", ticks: [], tickCount: 0 },
    timeframes,
    availableTimeframes: ["1m", "1h", "1d", "1mo"],
    analysisLayers: { timezone: windows.timezone, now, layers },
    raw,
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

export function estimateMarketContextBytes(market = {}) {
  return byteLength(sanitizeReadOnlyValue(market));
}

export function shouldUseSegmentedAnalysis(market = {}) {
  if (process.env.ANALYSIS_FORCE_SEGMENTED === "1") return true;
  return estimateMarketContextBytes(market) > setting("ANALYSIS_DIRECT_CONTEXT_MAX_BYTES", DEFAULT_DIRECT_CONTEXT_BYTES, 20000, 1000000);
}

export function buildMarketAnalysisSegments(market = {}, options = {}) {
  const fingerprint = String(market.fingerprint || "");
  const maxRows = Math.round(Math.min(MAX_SEGMENT_ROWS, Math.max(20, Number(options.maxRows || setting("ANALYSIS_SEGMENT_ROWS", DEFAULT_SEGMENT_ROWS, 20, MAX_SEGMENT_ROWS)))));
  const maxBytes = Math.round(Math.min(MAX_SEGMENT_BYTES, Math.max(20000, Number(options.maxBytes || setting("ANALYSIS_SEGMENT_BYTES", DEFAULT_SEGMENT_BYTES, 20000, MAX_SEGMENT_BYTES)))));
  const rowBudget = Math.max(12000, maxBytes - 1800);
  const segments = [];
  let nextIndex = 0;
  const coverageByTimeframe = [];

  for (const [timeframeKey, rawSnapshot] of timeframeEntries(market)) {
    const timeframe = String(rawSnapshot.timeframe || timeframeKey);
    const snapshot = sanitizeReadOnlyValue(rawSnapshot);
    const history = Array.isArray(rawSnapshot.history) ? rawSnapshot.history : [];
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
    const timeframeTicks = Array.isArray(rawSnapshot.ticks) ? rawSnapshot.ticks : [];
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
    account: market.account,
    pageView: market.pageView || market.page?.view || null,
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

export function summarizeMarketForDecision(market = {}, coverage = null, { recentRowsPerTimeframe = 120 } = {}) {
  const timeframes = {};
  for (const [key, rawSnapshot] of timeframeEntries(market)) {
    const snapshot = rawSnapshot || {};
    timeframes[key] = {
      timeframe: snapshot.timeframe || key,
      label: snapshot.label || key,
      period: snapshot.period ?? null,
      trend: snapshot.trend || "unknown",
      anomaly: Boolean(snapshot.anomaly),
      indicators: snapshot.indicators || null,
      dataQuality: snapshot.dataQuality || "UNKNOWN",
      missingFields: Array.isArray(snapshot.missingFields) ? snapshot.missingFields : [],
      historyCount: snapshot.historyCount ?? snapshot.history?.length ?? 0,
      completeHistoryCount: snapshot.completeHistoryCount ?? 0,
      firstTimestamp: snapshot.history?.[0]?.timestamp || null,
      lastTimestamp: snapshot.history?.at(-1)?.timestamp || null,
      recentHistory: recentRows(snapshot.history, recentRowsPerTimeframe, compactMarketCandle),
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
    freshnessSec: market.freshnessSec,
    dataQuality: market.dataQuality,
    missingFields: market.missingFields || [],
    marketClosed: Boolean(market.marketClosed),
    historyCount: market.historyCount || market.history?.length || 0,
    completeHistoryCount: market.completeHistoryCount || 0,
    timeframes,
    analysisLayers: market.analysisLayers || null,
    liveTicks: [],
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
    pageView: market.pageView || market.page?.view || null,
    source: market.source,
    sourceKind: market.sourceKind,
    dataAt: market.dataAt,
    observedAt: market.observedAt,
    coverage,
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
