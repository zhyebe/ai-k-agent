import assert from "node:assert/strict";
import test from "node:test";
import { executeDecision } from "../server/execution.mjs";
import { state } from "../server/store.mjs";

test("paper execution is idempotent and live execution is blocked", () => {
  const task = {
    id: `test-task-${Date.now()}`,
    symbol: "BTC/USDT",
    mode: "PAPER",
    stopLocked: false,
    metrics: { exposurePct: 0 },
  };
  const decision = {
    action: "BUY",
    targetPositionPct: 12,
    maxOrderValuePct: 4,
    createdAt: new Date().toISOString(),
  };
  const connector = { adapterId: "northstar-web" };
  const first = executeDecision(task, decision, connector);
  const second = executeDecision(task, decision, connector);
  assert.equal(first.ok, true);
  assert.equal(first.order.status, "SIMULATED");
  assert.equal(second.duplicate, true);
  assert.equal(task.metrics.exposurePct, 12);
  const live = executeDecision({ ...task, id: `${task.id}-live`, mode: "LIVE" }, decision, connector);
  assert.equal(live.code, "LIVE_EXECUTION_DISABLED");
  const riskyPosition = executeDecision({ ...task, id: `${task.id}-risky-position` }, { ...decision, targetPositionPct: 31 }, connector);
  assert.equal(riskyPosition.code, "RISK_LIMIT_EXCEEDED");
  const riskyOrder = executeDecision({ ...task, id: `${task.id}-risky-order` }, { ...decision, maxOrderValuePct: 9 }, connector);
  assert.equal(riskyOrder.code, "RISK_LIMIT_EXCEEDED");
  const matches = state.orders.filter((order) => order.taskId === task.id);
  assert.equal(matches.length, 1);
});
