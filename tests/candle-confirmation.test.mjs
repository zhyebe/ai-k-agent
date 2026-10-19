import assert from "node:assert/strict";
import test from "node:test";
import { confirmObservedCandles } from "../server/candle-confirmation.mjs";
import { buildLayeredAnalysisMarket, buildMarketAnalysisSegments, summarizeMarketForDecision } from "../server/analysis-context.mjs";
import { marketDataFingerprint } from "../server/market.mjs";

const minute = Date.parse("2026-10-19T02:01:00Z");
const candle = (close = 100) => ({ timestamp: minute, open: 100, high: Math.max(100, close), low: Math.min(100, close), close, volume: 10, partial: false });
function observe(scope, second, rows = [candle()], instrument = "A") {
  return confirmObservedCandles(rows, { scope, instrument, timeframe: "1m", observedAt: new Date(minute + second * 1000).toISOString() });
}

test("a display K needs continuous unchanged observations over five seconds after :50", () => {
  for (const second of [45, 48, 50, 52, 54, 55]) {
    assert.equal(observe("fixed", second)[0].confirmation.status, "PROVISIONAL");
  }
  const confirmed = observe("fixed", 56);
  assert.equal(confirmed[0].confirmation.status, "CONFIRMED");
  const market = buildLayeredAnalysisMarket({ timeframe: "1m", history: confirmed }, minute + 56000);
  assert.equal(market.history.length, 1);
});

test("flashing, disappearance, OHLCV edits and observation gaps restart confirmation", () => {
  for (const scenario of ["price", "disappeared", "gap", "volume"]) {
    observe(scenario, 50);
    observe(scenario, 52);
    if (scenario === "disappeared") observe(scenario, 54, []);
    else if (scenario === "price") observe(scenario, 54, [candle(105)]);
    else if (scenario === "volume") observe(scenario, 54, [{ ...candle(), volume: 11 }]);
    assert.equal(observe(scenario, 58)[0].confirmation.status, "PROVISIONAL");
    assert.equal(observe(scenario, 120)[0].confirmation.status, "PROVISIONAL", "wall-clock age never confirms a tracked candidate");
  }
});

test("cached observations and different sessions/instruments cannot supply stability evidence", () => {
  for (let n = 0; n < 5; n++) assert.equal(observe("cached", 50)[0].confirmation.status, "PROVISIONAL");
  for (const second of [50, 52, 54, 56]) observe("scope-a", second);
  assert.equal(observe("scope-b", 56)[0].confirmation.status, "PROVISIONAL");
  assert.equal(observe("scope-a", 56, [candle()], "B")[0].confirmation.status, "PROVISIONAL");
  const cached = confirmObservedCandles([candle()], { scope: "cached", instrument: "A", timeframe: "1m",
    observedAt: new Date(minute + 56000).toISOString(), observe: false });
  assert.equal(cached[0].confirmation.status, "PROVISIONAL", "a fresh quote timestamp cannot refresh cached chart evidence");
});

test("a large genuine move can confirm; size alone does not classify flash K", () => {
  let result;
  for (const second of [50, 52, 54, 56]) result = observe("large-real", second, [candle(120)]);
  assert.equal(result[0].confirmation.status, "CONFIRMED");
});

test("a newly seen last K remains provisional across the minute boundary", () => {
  for (const second of [61, 63, 65, 67]) {
    const rows = observe("minute-boundary", second, [{ ...candle(), timestamp: minute - 60000 }, candle()]);
    assert.equal(rows[0].confirmation, undefined, "older completed history remains available");
    assert.equal(rows[1].confirmation.status, second === 67 ? "CONFIRMED" : "PROVISIONAL");
  }
});

test("observation timestamps do not retrigger AI; actual confirmation does", () => {
  const first = observe("fingerprint", 50);
  const second = observe("fingerprint", 52);
  const fingerprint = history => marketDataFingerprint({ symbol: "A", history, timeframes: { "1m": { history } } });
  assert.equal(fingerprint(first), fingerprint(second));
  observe("fingerprint", 54);
  assert.notEqual(fingerprint(second), fingerprint(observe("fingerprint", 56)));
});

test("unconfirmed and flashed K never leak via indicators, raw/page copies or secondary books", () => {
  const transient = observe("contamination", 56, [candle(999)])[0];
  const book = { symbol: "A", timeframe: "1m", history: [{ ...candle(), timestamp: minute - 180000 }, transient],
    indicators: { ema20: 999 }, trend: "up", quote: { price: 999, high: 999 },
    timeframes: { "1m": { timeframe: "1m", history: [transient], indicators: { ema20: 999 } } },
    raw: { price: 999 }, page: { chartSamples: ["999"], visibleText: "price 999" },
    orderBook: { bids: [{ price: 101, volume: 10 }], asks: [{ price: 102, volume: 10 }] },
    observedAt: new Date(minute + 56000).toISOString() };
  const market = { ...book, books: [{ ...book, symbol: "B" }] };
  const layered = buildLayeredAnalysisMarket(market);
  assert.equal(layered.history.length, 1);
  assert.equal(layered.nextCandle.lastClosedTime, minute - 180000);
  assert.equal(layered.nextCandle.livePrice, null);
  assert.deepEqual(layered.indicators, {});
  assert.equal(layered.raw, undefined);
  assert.equal(layered.books[0].history.length, 1);
  assert.equal(layered.orderBook.bids[0].price, 101, "executable quotes survive display filtering");
  assert.equal(JSON.stringify(summarizeMarketForDecision(market)).includes("999"), false);
  assert.equal(JSON.stringify(buildMarketAnalysisSegments(market)).includes("999"), false);
});
