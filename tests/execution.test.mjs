import assert from "node:assert/strict";
import test from "node:test";
import { executeDecision, shouldSubmitLiveOrder, suggestOrderPreview } from "../server/execution.mjs";
import { state } from "../server/store.mjs";

test("configured entry quantity is exact for manual/auto and never caps exits", () => {
  for (const autoDecisionEnabled of [false, true]) {
    const task = { mode: "LIVE", autoDecisionEnabled, entryQuantity: 3, market: { latest: { price: 100 }, account: { positions: [{ positionOrderId: "P-1", quantity: 7 }] } }, metrics: { equity: 10000 } };
    assert.equal(suggestOrderPreview(task, { action: "BUY", targetPositionPct: 10 }).suggestedQty, 3);
    assert.equal(suggestOrderPreview({ ...task, entryQuantity: undefined }, { action: "SELL" }).suggestedQty, 1);
    assert.equal(suggestOrderPreview(task, { action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"] }).suggestedQty, 7);
  }
});

test("buy and sell stay suggestions until the LIVE engine submits them", () => {
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
  const matches = state.orders.filter((order) => order.taskId === task.id);
  assert.equal(matches.length, 0);
  const preview = suggestOrderPreview({ ...task, market: { latest: { price: 100 }, account: { availableFunds: 5000 } }, metrics: { equity: 5000 } }, decision);
  assert.equal(preview.suggestedQty, 2);
  assert.equal(preview.formSubmitBlocked, true);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE" }, "manual_confirm"), false);
  assert.equal(shouldSubmitLiveOrder({ mode: "PAPER" }, "manual_confirm"), false);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE", autoDecisionEnabled: true, target: { url: "https://smyw.haohandahan.cn/client/#/transcc" } }, "auto_timeout"), true);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE", autoDecisionEnabled: false }, "auto_timeout"), false);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE", autoDecisionEnabled: false, pendingAction: { exitType: "TAKE_PROFIT" } }, "auto_timeout"), true);
  assert.equal(shouldSubmitLiveOrder({ mode: "LIVE", autoDecisionEnabled: false, pendingAction: { exitType: "STOP_LOSS" } }, "auto_timeout"), true);
});

test("离场预览使用持仓数量并保留止盈类型", () => {
  const preview = suggestOrderPreview({
    symbol: "DGKZ",
    mode: "LIVE",
    autoDecisionEnabled: true,
    metrics: { equity: 5000 },
    market: {
      latest: { price: 1165 },
      account: { positions: [{ symbol: "DGKZ", positionOrderId: "P-123", quantity: 3 }] },
    },
  }, {
    action: "SELL",
    orderType: "LIMIT",
    exitType: "TAKE_PROFIT",
    targetSymbol: "DGKZ",
    targetPositionIds: ["P-123"],
    profitProbability: 0.8,
  }, { enforceQuantityLimit: true });
  assert.equal(preview.suggestedQty, 3);
  assert.equal(preview.quantityLimitApplied, false);
  assert.equal(preview.exitType, "TAKE_PROFIT");
});

test("离场预览在未精确匹配单号时仍使用持仓数量", () => {
  const preview = suggestOrderPreview({
    symbol: "DGKZ",
    mode: "LIVE",
    metrics: { equity: 5000 },
    market: {
      latest: { price: 1165 },
      account: { positions: [{ symbol: "DGKZ", quantity: 4 }] },
    },
  }, {
    action: "SELL",
    exitType: "TAKE_PROFIT",
    targetSymbol: "DGKZ",
    profitProbability: 0.8,
  });
  assert.equal(preview.suggestedQty, 4);
  assert.equal(preview.exitType, "TAKE_PROFIT");
});

test("离场目标单号不匹配时不能退回首笔持仓", () => {
  const preview = suggestOrderPreview({
    metrics: { equity: 5000 },
    market: { latest: { price: 100 }, account: { positions: [{ symbol: "DGKZ", positionOrderId: "P-1", quantity: 4 }] } },
  }, {
    action: "SELL", exitType: "TAKE_PROFIT", targetSymbol: "DGKZ", targetPositionIds: ["P-2"],
  });
  assert.equal(preview.suggestedQty, null);
});

test("多笔同盘口离场使用全部目标持仓数量", () => {
  const preview = suggestOrderPreview({
    mode: "LIVE",
    market: {
      latest: { price: 1165 },
      account: { positions: [
        { symbol: "DGKZ", positionOrderId: "P-1", quantity: 2 },
        { symbol: "DGKZ", positionOrderId: "P-2", quantity: 3 },
      ] },
    },
  }, {
    action: "SELL",
    exitType: "TAKE_PROFIT",
    targetSymbol: "DGKZ",
    targetPositionIds: ["P-1", "P-2"],
  });
  assert.equal(preview.suggestedQty, 5);
});
