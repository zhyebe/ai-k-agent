import assert from "node:assert/strict";
import test from "node:test";
import { exitFlashState, exitFlashAllows, observeExitFlashes } from "../server/exit-flash.mjs";
import { markObservedMarketCandles } from "../server/candle-confirmation.mjs";

const base = Date.parse("2026-10-25T02:00:00Z");
const position = { positionOrderId: "P", symbol: "DGKZ" };
const candle = (second, confirmed = true) => ({ timestamp: base,
  confirmation: { status: confirmed ? "CONFIRMED" : "PROVISIONAL", lastObservedAt: base + second * 1000 } });
const market = (second, extra = {}) => ({ symbol: "DGKZ", observedAt: new Date(base + second * 1000).toISOString(),
  account: { positionsVerified: true, positions: [position] }, ...extra });
const event = { observedAt: base + 2000, timestamp: base, suspected: true };

test("flash exit requires both thirty seconds and the event/later confirmed candle", () => {
  let state = exitFlashState(market(2, { flashK: event }), position, null, base + 2000);
  assert.equal(state.pending, true);
  state = exitFlashState(market(15, { history: [candle(15)] }), position, state, base + 15000);
  assert.equal(state.pending, true, "confirmation alone does not bypass the thirty seconds");
  state = exitFlashState(market(32), position, state, base + 32000);
  assert.equal(state.pending, false);
  const unconfirmed = exitFlashState(market(40, { flashK: { ...event, suspected: false } }), position, null, base + 40000);
  assert.equal(unconfirmed.pending, true, "expiry of the detector flag is not candle confirmation");
  assert.equal(exitFlashState(market(45, { history: [{ ...candle(45), timestamp: base - 60000 }] }), position, unconfirmed, base + 45000).pending, true);
  assert.equal(exitFlashState(market(45, { history: [candle(45)] }), position, unconfirmed, base + 45000).pending, false);
});

test("same flash cannot roll the deadline forward and future/stale evidence cannot clear it", () => {
  const task = {};
  observeExitFlashes(task, market(2, { flashK: event }), base + 2000);
  for (const second of [10, 20, 35]) observeExitFlashes(task, market(second, { flashK: event }), base + second * 1000);
  assert.equal(task.exitFlashObservations.P.waitUntil, base + 32000);
  observeExitFlashes(task, market(40, { history: [candle(41)] }), base + 40000);
  assert.equal(task.exitFlashObservations.P.pending, true);
  observeExitFlashes(task, market(40, { history: [candle(40)] }), base + 50000);
  assert.equal(task.exitFlashObservations.P.pending, true);
  observeExitFlashes(task, market(50, { history: [candle(50)] }), base + 50000);
  assert.equal(task.exitFlashObservations.P.pending, false);
  observeExitFlashes(task, market(60, { history: [{ ...candle(60, false), timestamp: base + 60000 }] }), base + 60000);
  assert.equal(task.exitFlashObservations.P.pending, false, "the next live candle cannot relock a settled event");
  observeExitFlashes(task, market(62, { flashK: { ...event, observedAt: base + 62000, timestamp: base + 60000 } }), base + 62000);
  assert.equal(task.exitFlashObservations.P.pending, true, "a new flash starts a new wait");
});

test("ordinary profit, recovery, stop and four-point ceiling share the wait; rescue and scheduled close retain precedence", () => {
  const m = market(2, { flashK: event });
  for (const guard of [{ exitType: "TAKE_PROFIT" }, { lossRecovery: true }, { exitType: "STOP_LOSS" }, { positionPoints: { programCeiling: true } }]) {
    assert.equal(exitFlashAllows(guard, position, m, base + 2000), false);
  }
  for (const guard of [{ rescueRecovery: true }, { exitType: "SCHEDULED_CLOSE" }]) {
    assert.equal(exitFlashAllows(guard, position, m, base + 2000), true);
  }
});

test("real candle detector releases a settled flash even with a new provisional candle", () => {
  const task = {};
  let last;
  for (let second = 40; second <= 78; second += 2) {
    const close = second === 40 ? 100 : 105;
    const history = [{ timestamp: base, open: 100, high: close, low: 100, close, volume: 10, partial: false }];
    if (second >= 60) history.push({ ...history[0], timestamp: base + 60000, open: 105, low: 105 });
    last = markObservedMarketCandles(market(second, { timeframe: "1m", history }), "exit-flash-integration");
    observeExitFlashes(task, last, base + second * 1000);
    if (second >= 42 && second < 72) assert.equal(task.exitFlashObservations.P.pending, true);
  }
  assert.equal(last.history.at(-1).confirmation.status, "PROVISIONAL");
  assert.equal(task.exitFlashObservations.P.pending, false);
});
