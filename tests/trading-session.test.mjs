import assert from "node:assert/strict";
import test from "node:test";
import { assertTradingSessionOpen, defaultTradingSession, effectiveTradingSession, parseTradingSession, TRADING_SESSION_CLOSED_MESSAGE } from "../server/trading-session.mjs";
import { parseSessionClose } from "../server/exit-policy.mjs";

const at = (value) => Date.parse(value);

test("default session runs from 18:30 until 16:00 the next afternoon", () => {
  const during = defaultTradingSession(at("2026-10-15T19:00:00+08:00"));
  assert.equal(during.opensAt, new Date(at("2026-10-15T18:30:00+08:00")).toISOString());
  assert.equal(during.closesAt, new Date(at("2026-10-16T16:00:00+08:00")).toISOString());
  assert.deepEqual(defaultTradingSession(at("2026-10-15T16:18:00+08:00")), during);
  assert.throws(() => assertTradingSessionOpen(null, at("2026-10-15T16:18:00+08:00")), new Error(TRADING_SESSION_CLOSED_MESSAGE));
  assert.doesNotThrow(() => assertTradingSessionOpen(null, at("2026-10-15T18:30:00+08:00")));
  assert.doesNotThrow(() => assertTradingSessionOpen(null, at("2026-10-16T15:59:00+08:00")));
  assert.throws(() => assertTradingSessionOpen(null, at("2026-10-16T16:00:00+08:00")), new Error(TRADING_SESSION_CLOSED_MESSAGE));
});

test("saved date range replaces the default immediately and keeps minute precision", () => {
  const saved = parseTradingSession({ opensAt: "2026-10-20T09:05", closesAt: "2026-10-21T15:40:45+08:00" });
  assert.equal(saved.opensAt, new Date(at("2026-10-20T09:05:00+08:00")).toISOString());
  assert.equal(saved.closesAt, new Date(at("2026-10-21T15:40:00+08:00")).toISOString());
  assert.deepEqual(effectiveTradingSession(saved, at("2026-10-15T19:00:00+08:00")), saved);
  assert.throws(() => assertTradingSessionOpen(saved, at("2026-10-15T19:00:00+08:00")), new Error(TRADING_SESSION_CLOSED_MESSAGE));
  assert.doesNotThrow(() => assertTradingSessionOpen(saved, at("2026-10-20T09:05:00+08:00")));
  assert.equal(parseTradingSession({ opensAt: "2026-10-20T16:00", closesAt: "2026-10-20T16:00" }), null);
  assert.equal(parseTradingSession({ opensAt: "2026-10-21T16:00", closesAt: "2026-10-20T18:30" }), null);
});

test("session close field stays a daily clock and lead time", () => {
  assert.deepEqual(parseSessionClose({ time: "16:00", leadMinutes: 5, timezone: "Asia/Shanghai" }), { time: "16:00", leadMinutes: 5, timezone: "Asia/Shanghai" });
});
