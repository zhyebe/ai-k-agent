import assert from "node:assert/strict";
import test from "node:test";
import { executeDecision, shouldSubmitLiveOrder, suggestOrderPreview } from "../server/execution.mjs";
import { state } from "../server/store.mjs";

test("buy and sell stay suggestions even when automation is explicitly authorized", () => {
  const task = {
    id: `test-task-${Date.now()}`,
    symbol: "DGJJ",
    mode: "PAPER",
    stopLocked: false,
    automationAuthorized: false,
    metrics: { exposurePct: 0 },
  };
  const decision = {
    action: "BUY",
    targetPositionPct: 12,
    maxOrderValuePct: 4,
    createdAt: new Date().toISOString(),
  };
  const connector = { adapterId: "haohan-readonly" };
  const first = executeDecision(task, decision, connector);
  assert.equal(first.ok, true);
  assert.equal(first.code, "SUGGESTION_PENDING");
  assert.equal(first.route, "SUGGESTION_PENDING");
  assert.equal(first.orderCreated, false);
  const hold = executeDecision(task, { ...decision, action: "HOLD" }, connector);
  assert.equal(hold.ok, true);
  assert.equal(hold.reason, "HOLD");
  const authorized = executeDecision({ ...task, id: `${task.id}-authorized`, automationAuthorized: true }, decision, connector);
  assert.equal(authorized.code, "SUGGESTION_PENDING");
  const live = executeDecision({ ...task, id: `${task.id}-live`, mode: "LIVE", automationAuthorized: true }, decision, connector);
  assert.equal(live.code, "SUGGESTION_PENDING");
  assert.equal(live.orderCreated, false);
  const matches = state.orders.filter((order) => order.taskId.startsWith(task.id));
  assert.equal(matches.length, 0);
  const preview = suggestOrderPreview({ ...task, market: { latest: { price: 100 }, account: { availableFunds: 5000 } }, metrics: { equity: 5000 } }, decision);
  assert.equal(preview.suggestedQty, 2);
  assert.equal(preview.formSubmitBlocked, true);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE" }, "manual_confirm"), true);
  assert.equal(shouldSubmitLiveOrder({ mode: "PAPER" }, "manual_confirm"), false);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE" }, "auto_timeout"), false);
});
