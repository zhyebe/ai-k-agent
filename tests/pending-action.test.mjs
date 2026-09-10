import assert from "node:assert/strict";
import test from "node:test";
import { suggestOrderPreview } from "../server/execution.mjs";
import { buildPendingAction, confirmPendingAction, setAutoDecision, takeoverPendingAction } from "../server/engine.mjs";
import { isForbiddenTradeControl, suggestionFormLabels } from "../server/tools.mjs";
import { state } from "../server/store.mjs";

function insertTask(id, extras = {}) {
  const task = {
    id,
    name: "pending-action-test",
    status: "MONITORING",
    mode: "PAPER",
    symbol: "DGJJ",
    timeframe: "15m",
    automationAuthorized: false,
    autoDecisionEnabled: false,
    autoDecisionCountdownSec: 8,
    pendingAction: null,
    stopLocked: false,
    monitoringEnabled: true,
    target: { type: "website", name: "浩瀚数贸", url: "https://smyw.haohandahan.cn/client/#/transcc", connectorId: "connector_haohan_readonly", browserSessionId: `task:${id}` },
    workflow: [],
    rules: [],
    decision: { action: "BUY", confidence: 0.8, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
    metrics: { equity: 18000, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
    market: { latest: { price: 1800 }, account: { availableFunds: 18000 } },
    ...extras,
  };
  state.tasks.unshift(task);
  return task;
}

test("suggestion preview keeps buy quantity honest and never implies a live order", () => {
  const preview = suggestOrderPreview({
    metrics: { equity: 18000 },
    market: { latest: { price: 1800 }, account: { availableFunds: 18000 } },
  }, { action: "BUY", targetPositionPct: 10, maxOrderValuePct: 8 });
  assert.equal(preview.action, "BUY");
  assert.equal(preview.suggestedPrice, 1800);
  assert.equal(preview.suggestedQty, 1);
  assert.equal(preview.formSubmitBlocked, true);
});

test("forbidden trade controls stay blocked for submit labels", () => {
  assert.equal(isForbiddenTradeControl("买入订立"), true);
  assert.equal(isForbiddenTradeControl("卖出 转让"), true);
  assert.equal(isForbiddenTradeControl("登录"), false);
  assert.deepEqual(suggestionFormLabels("BUY"), { price: "买价", quantity: "买量" });
  assert.deepEqual(suggestionFormLabels("SELL"), { price: "卖价", quantity: "卖量" });
});

test("pending buy waits for confirm, confirm does not create an order", () => {
  const task = insertTask(`task_pending_${Date.now()}`);
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(task.pendingAction.deadlineAt, null);
  const confirmed = confirmPendingAction(task.id, { source: "manual_confirm" });
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.equal(confirmed.pendingAction.source, "manual_confirm");
  assert.equal(confirmed.pendingAction.formSubmitBlocked, true);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("auto decision countdown confirms suggestion without submitting a trade", async () => {
  const task = insertTask(`task_auto_${Date.now()}`);
  setAutoDecision(task.id, { enabled: true, countdownSec: 5 });
  task.pendingAction = buildPendingAction(task, task.decision, { now: Date.now() - 6000 });
  assert.equal(task.pendingAction.status, "WAITING");
  assert.ok(task.pendingAction.deadlineAt);
  const confirmed = confirmPendingAction(task.id, { source: "auto_timeout" });
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.equal(confirmed.pendingAction.source, "auto_timeout");
  assert.match(confirmed.pendingAction.message, /未提交交易单/);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("takeover cancels pending auto confirm and locks trading", () => {
  const task = insertTask(`task_takeover_${Date.now()}`);
  task.autoDecisionEnabled = true;
  task.pendingAction = buildPendingAction(task, task.decision);
  const next = takeoverPendingAction(task.id);
  assert.equal(next.pendingAction.status, "TAKEN_OVER");
  assert.equal(next.status, "MANUAL_CONTROL");
  assert.equal(next.stopLocked, true);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});
