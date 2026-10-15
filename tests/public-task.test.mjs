import assert from "node:assert/strict";
import test from "node:test";
import { publicTask } from "../server/store.mjs";

test("LIVE entry mode remains manual or automatic in public tasks", () => {
  for (const enabled of [false, true]) {
    assert.equal(publicTask({ mode: "LIVE", autoDecisionEnabled: enabled }).autoDecisionEnabled, enabled);
  }
});

test("publicTask keeps ticks and latest objects so desktop workspace can render", () => {
  const task = publicTask({
    id: "task_1",
    ownerUserId: "user_1",
    name: "demo",
    status: "MONITORING",
    mode: "LIVE",
    symbol: "DGJJ",
    timeframe: "1m",
    target: { type: "website", name: "浩瀚" },
    metrics: { equity: 1000 },
    decision: { action: "HOLD" },
    market: { source: "haohan", symbol: "DGJJ", latest: { price: 12.3 } },
  });
  assert.equal(task.ownerUserId, undefined);
  assert.deepEqual(task.market.ticks, []);
  assert.deepEqual(task.market.history, []);
  assert.equal(task.market.latest.price, 12.3);
  assert.equal(task.market?.ticks.length, 0);
  assert.deepEqual(task.decision.riskFlags, []);
  assert.deepEqual(task.decision.evidenceIds, []);
  assert.equal(task.metrics.dayPnlPct, 0);
});

test("public task keeps the saved open window separate from the daily close field", () => {
  const opensAt = new Date(Date.parse("2026-10-20T18:30:00+08:00")).toISOString();
  const closesAt = new Date(Date.parse("2026-10-21T16:00:00+08:00")).toISOString();
  const task = publicTask({
    sessionClose: { leadMinutes: 8, timezone: "Asia/Shanghai" },
    tradingSession: { opensAt: "2026-10-20T18:30", closesAt: "2026-10-21T16:00" },
  });
  assert.deepEqual(task.sessionClose, { leadMinutes: 8, timezone: "Asia/Shanghai" });
  assert.deepEqual(task.tradingSession, { opensAt, closesAt });
});
