import assert from "node:assert/strict";
import test from "node:test";
import { confirmObservedCandles, markObservedMarketCandles } from "../server/candle-confirmation.mjs";
import { buildLayeredAnalysisMarket, buildMarketAnalysisSegments, summarizeMarketForDecision } from "../server/analysis-context.mjs";
import { marketDataFingerprint } from "../server/market.mjs";
import { entryTimingBlock } from "../server/entry-policy.mjs";

const minute = Date.parse("2026-10-19T02:01:00Z");
const candle = (close = 100) => ({ timestamp: minute, open: 100, high: Math.max(100, close) + 1, low: Math.min(100, close) - 1, close, volume: 10, partial: false });
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

test("flashing, disappearance, price edits and observation gaps restart confirmation", () => {
  for (const scenario of ["price", "disappeared", "gap"]) {
    observe(scenario, 50);
    observe(scenario, 52);
    if (scenario === "disappeared") observe(scenario, 54, []);
    else if (scenario === "price") observe(scenario, 54, [candle(105)]);
    assert.equal(observe(scenario, 58)[0].confirmation.status, "PROVISIONAL");
    assert.equal(observe(scenario, 120)[0].confirmation.status, "PROVISIONAL", "wall-clock age never confirms a tracked candidate");
  }
});

test("growing volume preserves continuous fixed-price confirmation and permits entry", () => {
  let history;
  for (const second of [50, 52, 54, 56, 58]) {
    history = observe("price-stable-volume-growing", second, [{ ...candle(), volume: 10 + second }]);
    assert.equal(history[0].confirmation.status, second >= 56 ? "CONFIRMED" : "PROVISIONAL");
  }
  assert.equal(history[0].volume, 68);
  assert.equal(entryTimingBlock({ timeframe: "1m", history }, { requireConfirmed: true }), null);
});

test("cached observations and different sessions/instruments cannot supply stability evidence", () => {
  for (let n = 0; n < 5; n++) assert.equal(observe("cached", 50)[0].confirmation.status, "PROVISIONAL");
  for (const second of [50, 52, 54, 56]) observe("scope-a", second);
  assert.equal(observe("scope-b", 56)[0].confirmation.status, "PROVISIONAL");
  assert.equal(observe("scope-a", 56, [candle()], "B")[0].confirmation.status, "PROVISIONAL");
  const cached = confirmObservedCandles([candle()], { scope: "cached", instrument: "A", timeframe: "1m",
    observedAt: new Date(minute + 56000).toISOString(), observe: false });
  assert.equal(cached[0].confirmation.status, "PROVISIONAL", "a fresh quote timestamp cannot refresh cached chart evidence");
  assert.equal(cached[0].confirmation.observed, true, "the original unchanged observation is retained");
});

test("cached or unobserved wick data cannot release a deferred entry", () => {
  const rows = [{ ...candle(105), high: 105, low: 100 }];
  observe("cached-wick-recovery", 40, rows);
  const cached = confirmObservedCandles([candle(105)], { scope: "cached-wick-recovery", instrument: "A", timeframe: "1m",
    observedAt: new Date(minute + 42000).toISOString(), observe: false });
  assert.equal(cached[0].confirmation.observed, false);
  assert.equal(entryTimingBlock({ timeframe: "1m", history: cached }, { requireConfirmed: true }), "ENTRY_AWAITING_CONFIRMED_PRICE");
  const current = observe("cached-wick-recovery", 42, [candle(105)]);
  assert.equal(current[0].confirmation.observed, true);
  assert.equal(current[0].confirmation.status, "PROVISIONAL");
  assert.equal(entryTimingBlock({ timeframe: "1m", history: current }, { requireConfirmed: true }), null);
  const unseen = confirmObservedCandles([candle(105)], { scope: "never-observed-wick", instrument: "A", timeframe: "1m",
    observedAt: new Date(minute + 42000).toISOString(), observe: false });
  assert.equal(unseen[0].confirmation.observed, false);
  assert.equal(entryTimingBlock({ timeframe: "1m", history: unseen }, { requireConfirmed: true }), "ENTRY_AWAITING_CONFIRMED_PRICE");
});

test("a large genuine move can confirm; size alone does not classify flash K", () => {
  let result;
  for (const second of [50, 52, 54, 56]) result = observe("large-real", second, [candle(120)]);
  assert.equal(result[0].confirmation.status, "CONFIRMED");
});

test("a candle without both wicks cannot become fixed just because it stays unchanged", () => {
  const rows = [{ ...candle(105), high: 105, low: 100 }];
  for (const second of [50, 52, 54, 56, 58, 60, 62]) {
    const history = observe("wickless-stable", second, rows);
    assert.equal(history[0].confirmation.status, "PROVISIONAL");
    assert.equal(entryTimingBlock({ timeframe: "1m", history }), "ENTRY_AWAITING_CONFIRMED_PRICE");
  }
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

test("unconfirmed intrabar prices survive analysis while confirmed-history indicators stay clean", () => {
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
  assert.equal(layered.nextCandle.livePrice, 999);
  assert.deepEqual(layered.indicators, {});
  assert.equal(layered.raw, undefined);
  assert.equal(layered.books[0].history.length, 1);
  assert.equal(layered.orderBook.bids[0].price, 101, "executable quotes survive display filtering");
  assert.equal(summarizeMarketForDecision(market).intrabarEvidence.confirmed, false);
  assert.equal(summarizeMarketForDecision(market).quote.price, 999);
  assert.ok(JSON.stringify(buildMarketAnalysisSegments(market)).includes("999"), "transient evidence must reach segmented analysis too");
});


test("a transient price matching live quotes and ticks remains actionable intrabar evidence", () => {
  const observedAt = new Date(minute + 56000).toISOString();
  const market = { symbol: "PUSH", timeframe: "1m", observedAt,
    history: [{ ...candle(105), timestamp: minute - 180000 }],
    quote: { price: 105 }, latest: { price: 105 }, ticks: [{ timestamp: minute + 55000, price: 105, volume: 10 }],
    flashK: { suspected: true, timestamp: minute - 180000, price: 105, reason: "TRANSIENT_REVERTED", excludeFromAnalysis: false },
    orderBook: { bids: [{ price: 105, volume: 10 }], asks: [{ price: 106, volume: 10 }] },
  };
  const result = summarizeMarketForDecision(market);
  assert.equal(result.quote.price, 105);
  assert.equal(result.liveTicks[0].price, 105);
  assert.equal(result.historyCount, 1, "a transient flag cannot erase an otherwise confirmed historical bar");
  assert.equal(result.intrabarEvidence.transientEvent.price, 105);
  assert.equal(result.intrabarEvidence.confirmed, false);
  assert.equal(result.orderBook.bids[0].price, 105);
});

for (const price of [90, 110]) test(`wickless ${price < 100 ? 'down' : 'up'} candle waits until a fresh wick appears`, () => {
  const scope = `flash-${price}`;
  const observeMarket = (second, close, withWick = false) => markObservedMarketCandles({ symbol: 'FLASH', timeframe: '1m',
    observedAt: new Date(minute + second * 1000).toISOString(),
    history: [{ ...candle(close), ...(!withWick ? { high: Math.max(100, close), low: Math.min(100, close) } : {}) }] }, scope);
  observeMarket(40, 100);
  const market = observeMarket(42, price);
  assert.equal(market.history[0].confirmation.status, 'PROVISIONAL');
  assert.equal(market.flashK.suspected, true);
  assert.equal(market.flashK.price, price);
  assert.equal(entryTimingBlock(market), "ENTRY_AWAITING_CONFIRMED_PRICE");
  const result = summarizeMarketForDecision(market);
  assert.equal(result.historyCount, 0);
  assert.equal(result.intrabarEvidence.transientEvent.price, price);
  assert.equal(result.flashK.excludeFromAnalysis, false);
  const otherSession = markObservedMarketCandles({ ...market, history: [candle(price)] }, `${scope}-other`);
  assert.equal(otherSession.flashK.suspected, false, 'sessions must not borrow another session flash evidence');
  const withoutChart = markObservedMarketCandles({ symbol: 'FLASH', timeframe: '1m', observedAt: new Date(minute + 44000).toISOString() }, scope);
  assert.equal(withoutChart.flashK.price, price, 'temporary chart absence retains the observed flash event');
  const expiredWithoutChart = markObservedMarketCandles({ symbol: 'FLASH', timeframe: '1m',
    observedAt: new Date(minute + 74000).toISOString() }, scope);
  assert.equal(expiredWithoutChart.flashK.suspected, true);
  assert.equal(entryTimingBlock(expiredWithoutChart), "ENTRY_AWAITING_CONFIRMED_PRICE", "event expiry cannot supply confirmation");
  const normal = observeMarket(76, price, true);
  assert.equal(normal.history[0].confirmation.status, 'PROVISIONAL', 'history confirmation remains separate from execution timing');
  assert.equal(normal.flashK.confirmed, true);
  assert.equal(entryTimingBlock(normal, { requireConfirmed: true }), null, 'a fresh visible wick releases the saved entry without another timer');
});
