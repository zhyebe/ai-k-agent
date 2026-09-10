import assert from "node:assert/strict";
import test from "node:test";
import { analysisLayerWindows, buildLayeredAnalysisMarket, buildMarketAnalysisSegments, describeAnalysisLayers, estimateMarketContextBytes, shouldUseSegmentedAnalysis, startOfShanghaiHour, summarizeMarketForDecision } from "../server/analysis-context.mjs";

function history(size, start = 1700000000000, step = 60000) {
  return Array.from({ length: size }, (_, index) => ({
    timestamp: start + index * step,
    previousClose: 100 + index / 100,
    open: 100 + index / 100,
    high: 101 + index / 100,
    low: 99 + index / 100,
    close: 100.5 + index / 100,
    volume: 1000 + index,
    amount: 100500 + index,
    inventory: 20 + index,
    partial: false,
  }));
}

function candle(timestamp, close = 100) {
  return {
    timestamp,
    previousClose: close,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    amount: 1000,
    inventory: 5,
    partial: false,
  };
}

test("全量行情分段覆盖每个周期且行范围不重不漏", () => {
  const first = history(245);
  const second = history(131, 1800000000000);
  const market = {
    fingerprint: "coverage-test",
    symbol: "DGKZ",
    symbolName: "测试品种",
    timeframe: "15m",
    history: second,
    ticks: Array.from({ length: 27 }, (_, index) => ({ timestamp: 1800000000000 + index * 1000, price: 100 + index / 10, volume: index + 1 })),
    timeframes: {
      "1m": { timeframe: "1m", history: first, historyCount: first.length, completeHistoryCount: first.length, indicators: {}, missingFields: [], dataQuality: "VERIFIED" },
      "15m": { timeframe: "15m", history: second, historyCount: second.length, completeHistoryCount: second.length, indicators: {}, missingFields: [], dataQuality: "VERIFIED" },
    },
    page: { visibleText: "页面字段" },
    raw: { source: "readonly", detail: "x".repeat(50000) },
  };
  const plan = buildMarketAnalysisSegments(market, { maxRows: 50, maxBytes: 20000 });
  const klineSegments = plan.segments.filter((segment) => segment.kind === "kline");
  assert.equal(plan.coverage.totalKlineRows, first.length + second.length);
  assert.equal(klineSegments.reduce((sum, segment) => sum + segment.rowCount, 0), first.length + second.length);
  for (const [timeframe, expected] of [["1m", first], ["15m", second]]) {
    const segments = klineSegments.filter((segment) => segment.timeframe === timeframe).sort((left, right) => left.rowStart - right.rowStart);
    let offset = 0;
    for (const segment of segments) {
      assert.equal(segment.rowStart, offset);
      assert.equal(segment.rowEnd, offset + segment.rowCount);
      offset = segment.rowEnd;
    }
    assert.equal(offset, expected.length);
  }
  assert.ok(plan.segments.some((segment) => segment.kind === "page"));
  assert.ok(plan.segments.filter((segment) => segment.kind === "raw_readonly").length > 1);
  assert.equal(plan.coverage.complete, true);
  const summary = summarizeMarketForDecision(market, plan.coverage);
  assert.equal(summary.timeframes["1m"].recentHistory.length, 120);
  assert.ok(estimateMarketContextBytes(market) > 0);
});

test("超过直接上下文阈值时启用分段分析", () => {
  const previous = process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES;
  process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES = "20000";
  try {
    assert.equal(shouldUseSegmentedAnalysis({ history: history(300), timeframes: { "15m": { history: history(300) } } }), true);
  } finally {
    if (previous === undefined) delete process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES;
    else process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES = previous;
  }
});

test("分析行情按上海时区近密远疏分层，不含秒级逐笔", () => {
  const now = Date.parse("2026-09-10T03:32:00.000Z");
  const windows = analysisLayerWindows(now);
  assert.equal(windows.timezone, "Asia/Shanghai");
  assert.equal(windows.layers[0].timeframe, "1m");
  assert.equal(windows.layers[0].start, now - 60 * 60 * 1000);
  assert.equal(windows.layers[1].timeframe, "1h");
  assert.equal(windows.layers[1].start, Date.parse("2026-09-08T16:00:00.000Z"));
  assert.equal(windows.layers[2].timeframe, "1d");
  assert.equal(windows.layers[2].start, Date.parse("2026-07-31T16:00:00.000Z"));
  assert.equal(windows.layers[3].timeframe, "1mo");
  assert.equal(windows.layers[3].end, windows.layers[2].start);

  const minuteRecent = candle(now - 10 * 60 * 1000, 110);
  const minuteOlder = candle(now - 2 * 60 * 60 * 1000, 108);
  const hourInWindow = candle(Date.parse("2026-09-09T05:00:00.000Z"), 107);
  const dayInWindow = candle(Date.parse("2026-08-15T16:00:00.000Z"), 105);
  const monthOlder = candle(Date.parse("2026-06-30T16:00:00.000Z"), 90);
  const layered = buildLayeredAnalysisMarket({
    dataAt: new Date(now).toISOString(),
    ticks: [
      { timestamp: now - 20_000, price: 111, volume: 1 },
      { timestamp: now - 10_000, price: 112, volume: 2 },
      { timestamp: now - 90 * 60 * 1000, price: 100, volume: 9 },
    ],
    timeframes: {
      "1m": { timeframe: "1m", history: [minuteOlder, minuteRecent] },
      "5m": { timeframe: "5m", history: [candle(now - 5 * 60 * 1000, 109)] },
      "15m": { timeframe: "15m", history: [candle(now - 15 * 60 * 1000, 109)] },
      "1h": { timeframe: "1h", history: [hourInWindow] },
      "1d": { timeframe: "1d", history: [dayInWindow] },
      "1mo": { timeframe: "1mo", history: [monthOlder] },
    },
    raw: { quote: { price: 112 }, timeline: { data: [[now, 112]] } },
  }, now);

  assert.equal(layered.ticks.length, 0);
  assert.equal(layered.timeline.tickCount, 0);
  assert.deepEqual(layered.availableTimeframes, ["1m", "1h", "1d", "1mo"]);
  assert.equal(layered.timeframes["5m"], undefined);
  assert.equal(layered.timeframes["15m"], undefined);
  assert.equal(layered.raw.timeline, undefined);
  assert.equal(layered.raw.quote.price, 112);
  assert.deepEqual(layered.timeframes["1m"].history.map((item) => item.timestamp), [minuteRecent.timestamp]);
  assert.deepEqual(layered.timeframes["1h"].history.map((item) => item.timestamp), [hourInWindow.timestamp]);
  assert.deepEqual(layered.timeframes["1d"].history.map((item) => item.timestamp), [dayInWindow.timestamp]);
  assert.deepEqual(layered.timeframes["1mo"].history.map((item) => item.timestamp), [monthOlder.timestamp]);
  assert.match(describeAnalysisLayers(layered), /近1小时·分钟 1 根/);
  assert.equal(summarizeMarketForDecision(layered).liveTicks.length, 0);

  const aggregatedHour = buildLayeredAnalysisMarket({
    timeframes: { "1m": { timeframe: "1m", history: [minuteOlder] } },
  }, now);
  assert.equal(aggregatedHour.timeframes["1h"].history.length, 1);
  assert.equal(aggregatedHour.timeframes["1h"].history[0].timestamp, startOfShanghaiHour(minuteOlder.timestamp));
  assert.equal(aggregatedHour.timeframes["1m"].history.length, 0);

  const fromTicks = buildLayeredAnalysisMarket({
    ticks: [
      { timestamp: now - 20_000, price: 111, volume: 1 },
      { timestamp: now - 10_000, price: 112, volume: 2 },
      { timestamp: now - 70_000, price: 109, volume: 3 },
    ],
  }, now);
  assert.equal(fromTicks.ticks.length, 0);
  assert.equal(fromTicks.timeframes["1m"].history.length, 2);
  assert.ok(fromTicks.timeframes["1m"].history.every((item) => item.timestamp % 60000 === 0));
  assert.ok(!fromTicks.timeframes["1m"].history.some((item) => item.timestamp === now - 20_000));
});
