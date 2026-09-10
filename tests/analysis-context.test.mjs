import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketAnalysisSegments, estimateMarketContextBytes, shouldUseSegmentedAnalysis, summarizeMarketForDecision } from "../server/analysis-context.mjs";

function history(size, start = 1700000000000) {
  return Array.from({ length: size }, (_, index) => ({
    timestamp: start + index * 60000,
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
