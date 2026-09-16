import assert from "node:assert/strict";
import test from "node:test";
import { publicTask } from "../server/store.mjs";

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
