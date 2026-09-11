import assert from "node:assert/strict";
import test from "node:test";
import {
  boardCoverageForTargets,
  enrichReadOnlyMarket,
  fetchHaohanMarket,
  fetchHaohanKlineHistory,
  fetchHaohanBoardMarkets,
  haohanPeriodForTimeframe,
  marketDataFingerprint,
  normalizeHaohanKlineRow,
  normalizeHaohanTimelineTick,
  normalizeHaohanTimeframe,
  observeMarket,
  pickPrimaryBoard,
  resolveBoardInstruments,
  resolveObservedHaohanSymbol,
} from "../server/market.mjs";
import { extractHaohanPageInstrument, normalizeHqChartCandle, parseHaohanPageSnapshot, uniquePageInstruments } from "../server/haohan.mjs";

test("浩瀚 K 线按真实列位解析 OHLC、成交量和库存", () => {
  const candle = normalizeHaohanKlineRow([1700000000000, 100, 101, 105, 99, 103, 200, 20600, 50]);
  assert.deepEqual(candle, {
    timestamp: 1700000000000,
    previousClose: 100,
    open: 101,
    high: 105,
    low: 99,
    close: 103,
    volume: 200,
    amount: 20600,
    inventory: 50,
    partial: false,
  });
});

test("浩瀚分时行单独解析为逐笔数据", () => {
  const tick = normalizeHaohanTimelineTick([1700000000000, 103, 100, 25, 102, "1"]);
  assert.deepEqual(tick, { timestamp: 1700000000000, price: 103, volume: 25, referencePrice: 100, averagePrice: 102, flag: "1" });
});

test("K 线历史请求使用目标周期并返回真实数据", async () => {
  const requested = [];
  const result = await fetchHaohanKlineHistory({
    contractId: "537",
    timeframe: "15m",
    count: 500,
    baseUrl: "https://readonly.example.test",
    fetchImpl: async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        json: async () => ({ code: 0, data: [[1700000000000, 100, 101, 105, 99, 103, 200, 20600, 50]] }),
      };
    },
  });
  assert.equal(haohanPeriodForTimeframe("15m"), 2);
  assert.equal(result.ok, true);
  assert.equal(result.history[0].close, 103);
  assert.match(requested[0], /klinePage/);
  assert.match(requested[0], /contractId=537/);
  assert.match(requested[0], /period=2/);
});

test("完整只读历史和分时数据计算可验证指标", () => {
  const history = Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index;
    return { timestamp: 1700000000000 + index * 900000, open: close - 1, high: close + 1, low: close - 2, close, volume: 100 + index };
  });
  const market = enrichReadOnlyMarket({
    symbol: "DGKZ",
    symbolName: "丹桂康砖（二期）",
    timeframe: "15m",
    history,
    ticks: [{ timestamp: history.at(-1).timestamp, price: 140, volume: 20 }],
    quote: { price: 140, open: 100, high: 140, low: 99, volume: 400, quoteChangePct: 1.2 },
    observedAt: new Date().toISOString(),
    dataAt: new Date().toISOString(),
    source: "haohan-readonly-kline",
  });
  assert.equal(market.dataQuality, "VERIFIED");
  assert.equal(market.historyCount, 40);
  assert.equal(market.trend, "up");
  assert.ok(market.indicators.ema20 > 0);
  assert.ok(market.indicators.rsi14 > 0);
  assert.equal(market.missingFields.length, 0);
});

test("浩瀚周期编码覆盖分钟、小时、日、周和月", () => {
  const expected = { "1m": 0, "3m": 10, "5m": 1, "10m": 11, "15m": 2, "30m": 3, "1h": 4, "2h": 12, "4h": 9, "1d": 5, "1w": 6, "1mo": 7 };
  for (const [timeframe, period] of Object.entries(expected)) {
    assert.equal(normalizeHaohanTimeframe(timeframe), timeframe);
    assert.equal(haohanPeriodForTimeframe(timeframe), period);
  }
  assert.equal(normalizeHaohanTimeframe("60m"), "1h");
});

test("页面缺少 OHLC 时保留缺失字段，不用收盘价补造", () => {
  const result = parseHaohanPageSnapshot({
    url: "https://smyw.haohandahan.cn/client/#/transcc",
    title: "浩瀚数贸交易终端",
    visibleText: "最新价：100",
    tables: [{ rows: [["时间", "开盘", "最高", "最低", "收盘", "成交量"], ["2026-09-09 10:00", "--", "--", "--", "100", "0"]] }],
    chartSamples: [],
    capturedAt: Date.parse("2026-09-09T10:00:00+08:00"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.history[0].open, null);
  assert.equal(result.history[0].high, null);
  assert.equal(result.history[0].low, null);
  assert.equal(result.history[0].partial, true);
  assert.ok(result.missingFields.includes("HISTORY_PARTIAL_OHLC"));
});

test("页面当前品种从可见文本提取，并拒绝与任务品种拼接", () => {
  const snapshot = {
    url: "https://smyw.haohandahan.cn/client/#/transcc",
    title: "1168 丹桂康砖（二期） 浩瀚数贸",
    visibleText: "DGKZ | 丹桂康砖（二期）\n最新价 1168 涨跌幅 0.78%\n商品 DGKZ 丹桂康砖（二期） 订立 转让",
  };
  assert.deepEqual(extractHaohanPageInstrument(snapshot), { symbol: "DGKZ", symbolName: "丹桂康砖（二期）" });
  const mismatch = parseHaohanPageSnapshot(snapshot, { symbol: "DGJJ" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "PAGE_INSTRUMENT_MISMATCH");
  const match = parseHaohanPageSnapshot(snapshot, { symbol: "DGKZ" });
  assert.equal(match.symbol, "DGKZ");
  assert.equal(match.symbolName, "丹桂康砖（二期）");
  assert.equal(mismatch.account.availableFunds, null);
});

test("页面资金、盘口和换行品种会结构化解析并保留给分析", () => {
  const snapshot = {
    url: "https://smyw.haohandahan.cn/client/#/transcc",
    title: "1140 丹桂康砖（二期） 浩瀚数贸",
    visibleText: `DGKZ
|
F10
最新价
1140
涨跌幅
-1.64%
昨收价
1159
外盘
348.82万
登录账号
182****6105
可用资金
5143.09元
风险率
9999.99%
实时货值变化
0元
货值变化
0元
最大下单量：
404
持仓明细
暂无数据
销售②
1142
5622
采购①
1140
4974`,
  };
  assert.deepEqual(extractHaohanPageInstrument(snapshot), { symbol: "DGKZ", symbolName: "丹桂康砖（二期）" });
  const parsed = parseHaohanPageSnapshot(snapshot, { symbol: "DGKZ" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.account.availableFunds, 5143.09);
  assert.equal(parsed.account.equity, 5143.09);
  assert.equal(parsed.account.dayPnl, 0);
  assert.equal(parsed.account.positionEmpty, true);
  assert.equal(parsed.pageView.quote.prevClose, 1159);
  assert.equal(parsed.pageView.quote.outerVolume, 3488200);
  assert.equal(parsed.pageView.orderBook.asks[0].price, 1142);
  assert.equal(parsed.pageView.orderBook.bids[0].price, 1140);
  const mismatch = parseHaohanPageSnapshot(snapshot, { symbol: "DGJJ" });
  assert.equal(mismatch.code, "PAGE_INSTRUMENT_MISMATCH");
  assert.equal(mismatch.account.availableFunds, 5143.09);
  assert.equal(mismatch.pageView.orderBook.bids.length, 1);
  assert.equal(resolveObservedHaohanSymbol({ symbol: "DGKZ" }, "DGJJ"), "DGKZ");
  assert.equal(resolveObservedHaohanSymbol({ symbol: "" }, "DGJJ"), "DGJJ");
});

test("浩瀚只读采集并行保留全部分析周期历史", async () => {
  const previousWebSocket = globalThis.WebSocket;
  const previousTimeframes = process.env.HAOHAN_ANALYSIS_TIMEFRAMES;
  const periods = new Set();
  const baseTimestamp = Date.parse("2026-09-09T01:00:00Z");
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
    }

    emit(type, value) {
      for (const listener of this.listeners.get(type) || []) listener(value);
    }

    send(message) {
      const payload = JSON.parse(message);
      if (payload.fid === "marketdetail-req") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ fid: "marketdetail-resp", code: 0, marketDetails: [{ symbol: "DGJJ", symbolId: "536", name: "丹桂金尖（二期）", close: 125, open: 124, high: 126, low: 123, amount: 12 }] }) }));
      if (payload.fid === "pricedetail-req") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ fid: "pricedetail-resp", currentDataArray: [{ price: 125, volume: 3, occurTime: baseTimestamp + 24 * 60 * 60 * 1000 }] }) }));
      if (payload.fid === "currencytimeline-req") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ fid: "CurrencyTimeLineResponse", data: [[baseTimestamp + 24 * 60 * 60 * 1000, 125, 124, 3, 124.5, "1"]] }) }));
    }

    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  process.env.HAOHAN_ANALYSIS_TIMEFRAMES = "1m,3m,5m,10m,15m,30m,1h,2h,4h,1d,1w,1mo";
  try {
    const result = await fetchHaohanMarket({ symbol: "DGJJ", timeframe: "15m", timeoutMs: 1000, httpBaseUrl: "https://readonly.example.test", fetchImpl: async (url) => {
      const parsed = new URL(url);
      periods.add(Number(parsed.searchParams.get("period")));
      const rows = Array.from({ length: 25 }, (_, index) => {
        const close = 100 + index;
        return [baseTimestamp + index * 900000, close - 2, close - 1, close + 1, close - 2, close, 10 + index, 1000 + index, 20 + index];
      });
      return { ok: true, json: async () => ({ code: 0, data: rows }) };
    } });
    assert.equal(result.ok, true);
    assert.equal(Object.keys(result.timeframes).length, 12);
    assert.equal(result.timeframes["1m"].historyCount, 25);
    assert.equal(result.timeframes["1d"].historyCount, 25);
    assert.equal(result.timeframes["1mo"].historyCount, 25);
    assert.equal(result.availableTimeframes.length, 12);
    assert.equal(periods.size, 12);
    assert.equal(result.ticks.length, 1);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
    if (previousTimeframes === undefined) delete process.env.HAOHAN_ANALYSIS_TIMEFRAMES;
    else process.env.HAOHAN_ANALYSIS_TIMEFRAMES = previousTimeframes;
  }
});

test("行情指纹稳定且只在数据变化时变化", () => {
  const base = { symbol: "DGJJ", instrumentId: "536", quote: { price: 100 }, history: [{ timestamp: 1700000000000, close: 100 }], timeframes: { "15m": { timeframe: "15m", period: 2, history: [{ timestamp: 1700000000000, close: 100 }], ticks: [], missingFields: [] } } };
  assert.equal(marketDataFingerprint(base), marketDataFingerprint({ ...base, observedAt: "different" }));
  assert.equal(marketDataFingerprint({ ...base, page: { url: "https://smyw.haohandahan.cn/client/#/transcc", visibleText: "更新时间 2026-09-09 10:01:00 最新价 100" } }), marketDataFingerprint({ ...base, page: { url: "https://smyw.haohandahan.cn/client/#/transcc", visibleText: "更新时间 2026-09-09 10:02:00 最新价 100" } }));
  assert.notEqual(marketDataFingerprint({ ...base, page: { url: "https://smyw.haohandahan.cn/client/#/transcc", visibleText: "更新时间 10:01:00 最新价 100" } }), marketDataFingerprint({ ...base, page: { url: "https://smyw.haohandahan.cn/client/#/transcc", visibleText: "更新时间 10:02:00 最新价 101" } }));
  assert.notEqual(marketDataFingerprint(base), marketDataFingerprint({ ...base, quote: { price: 101 } }));
  assert.notEqual(marketDataFingerprint(base), marketDataFingerprint({ ...base, account: { availableFunds: 99 } }));
});

test("northstar connector cannot read a verified market snapshot", async () => {
  const result = await observeMarket(
    { id: "task_market_check", symbol: "BTC/USDT", timeframe: "15m", target: { url: "https://demo.exchange.local" } },
    {
      adapterId: "northstar-web",
      reviewStatus: "APPROVED",
      capabilities: ["navigate", "login", "read_history", "observe_orders", "paper_trade"],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "READONLY_MARKET_ADAPTER_UNAVAILABLE");
});

test("unreviewed adapters stay blocked", async () => {
  const result = await observeMarket(
    { id: "task_market_review", symbol: "BTC/USDT", timeframe: "15m", target: { url: "https://example.com" } },
    { adapterId: "generic-web", reviewStatus: "REVIEW_REQUIRED", capabilities: ["navigate"] },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "MARKET_ADAPTER_REVIEW_REQUIRED");
});

test("HQChart 行按上海时区日期时间解析为完整 OHLC", () => {
  const candle = normalizeHqChartCandle({ Date: 20260910, Time: 1500, Open: 1820, High: 1835, Low: 1810, Close: 1830, Vol: 12, YClose: 1815 });
  assert.equal(candle.close, 1830);
  assert.equal(candle.open, 1820);
  assert.equal(candle.high, 1835);
  assert.equal(candle.low, 1810);
  assert.equal(candle.partial, false);
  assert.equal(candle.timestamp, Date.parse("2026-09-10T15:00:00+08:00"));
});

test("页面 HQChart K 线优先于 tooltip 采样并保留整段历史", () => {
  const klines = Array.from({ length: 40 }, (_, index) => ({
    Date: 20260910,
    Time: 900 + index,
    Open: 1800 + index,
    High: 1810 + index,
    Low: 1790 + index,
    Close: 1805 + index,
    Vol: 10 + index,
  }));
  const parsed = parseHaohanPageSnapshot({
    url: "https://smyw.haohandahan.cn/client/#/transcc",
    visibleText: "最新价：1844",
    klines,
    chartSamples: ["开盘 1 最高 1 最低 1 收盘 1 数量 1"],
    capturedAt: Date.parse("2026-09-10T15:00:00+08:00"),
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.historyCount, 40);
  assert.equal(parsed.history[0].close, 1805);
  assert.equal(parsed.history.at(-1).close, 1844);
  assert.ok(!parsed.missingFields.includes("HISTORY_INSUFFICIENT"));
});

test("页面下拉的多个盘口会匹配只读合约并全部纳入监测", () => {
  const boards = resolveBoardInstruments({
    pageInstruments: uniquePageInstruments([
      { symbolName: "丹桂金尖（二期）" },
      { symbolName: "丹桂康砖（二期）" },
    ]),
    marketDetails: [
      { symbol: "DGJJ", symbolId: "536", name: "丹桂金尖（二期）", close: 1830 },
      { symbol: "DGKZ", symbolId: "537", name: "丹桂康砖（二期）", close: 1168 },
    ],
  });
  assert.equal(boards.length, 2);
  assert.equal(boards[0].symbol, "DGJJ");
  assert.equal(boards[0].instrumentId, "536");
  assert.equal(boards[1].symbol, "DGKZ");
  assert.equal(pickPrimaryBoard(boards.map((board) => ({ symbol: board.symbol, symbolName: board.symbolName })), { pageSymbol: "DGKZ" }).symbol, "DGKZ");
});

test("盘口覆盖检查会明确报告未采集的盘口", () => {
  const targets = [
    { symbol: "DGJJ", symbolName: "丹桂金尖（二期）", instrumentId: "536" },
    { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537" },
  ];
  const incomplete = boardCoverageForTargets(targets, [targets[0]]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.expected, 2);
  assert.equal(incomplete.collected, 1);
  assert.equal(incomplete.missing[0].symbol, "DGKZ");
  assert.equal(boardCoverageForTargets(targets, targets).complete, true);
});

test("只读采集会并行拉取全部盘口历史 K 线", async () => {
  const previousWebSocket = globalThis.WebSocket;
  const previousTimeframes = process.env.HAOHAN_ANALYSIS_TIMEFRAMES;
  const contractIds = new Set();
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
    }

    emit(type, value) {
      for (const listener of this.listeners.get(type) || []) listener(value);
    }

    send(message) {
      const payload = JSON.parse(message);
      if (payload.fid === "marketdetail-req") {
        queueMicrotask(() => this.emit("message", {
          data: JSON.stringify({
            fid: "marketdetail-resp",
            code: 0,
            marketDetails: [
              { symbol: "DGJJ", symbolId: "536", name: "丹桂金尖（二期）", close: 1830, open: 1820, high: 1840, low: 1810, amount: 12 },
              { symbol: "DGKZ", symbolId: "537", name: "丹桂康砖（二期）", close: 1168, open: 1160, high: 1172, low: 1155, amount: 8 },
            ],
          }),
        }));
      }
    }

    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  process.env.HAOHAN_ANALYSIS_TIMEFRAMES = "1m,15m,1d";
  try {
    const result = await fetchHaohanBoardMarkets({
      instruments: [{ symbolName: "丹桂金尖（二期）" }, { symbolName: "丹桂康砖（二期）" }],
      timeframe: "15m",
      timeoutMs: 1000,
      httpBaseUrl: "https://readonly.example.test",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        contractIds.add(String(parsed.searchParams.get("contractId") || parsed.searchParams.get("symbol") || ""));
        const rows = Array.from({ length: 25 }, (_, index) => {
          const close = 100 + index;
          return [1700000000000 + index * 900000, close - 2, close - 1, close + 1, close - 2, close, 10 + index, 1000 + index, 20 + index];
        });
        return { ok: true, json: async () => ({ code: 0, data: rows }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.books.length, 2);
    assert.equal(result.books[0].historyCount, 25);
    assert.equal(result.books[1].historyCount, 25);
    assert.equal(contractIds.has("536"), true);
    assert.equal(contractIds.has("537"), true);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
    if (previousTimeframes === undefined) delete process.env.HAOHAN_ANALYSIS_TIMEFRAMES;
    else process.env.HAOHAN_ANALYSIS_TIMEFRAMES = previousTimeframes;
  }
});
