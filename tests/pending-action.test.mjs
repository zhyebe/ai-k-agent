import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { suggestOrderPreview } from "../server/execution.mjs";
import { buildPendingAction, cancelPendingAction, confirmPendingAction, setAutoDecision, setTaskMode, stopController, takeoverPendingAction } from "../server/engine.mjs";
import { isForbiddenTradeControl, isPositionListExitControlText, isTradeWriteResponse, positionListExitLabels, suggestionFormLabels, tradePaneLabel, tradeSubmitLabels } from "../server/tools.mjs";
import { state } from "../server/store.mjs";

afterEach(() => {
  for (const task of state.tasks) stopController(task.id);
});

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
    monitoringEnabled: false,
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
  assert.equal(isForbiddenTradeControl("卖出订立"), true);
  assert.equal(isForbiddenTradeControl("买入转让"), true);
  assert.equal(isForbiddenTradeControl("卖出 转让"), true);
  assert.equal(isForbiddenTradeControl("登录"), false);
  assert.deepEqual(suggestionFormLabels("BUY"), { price: "买价", quantity: "买量", extras: ["订立价", "订立量", "价格", "数量"] });
  assert.deepEqual(suggestionFormLabels("SELL"), { price: "卖价", quantity: "卖量", extras: ["订立价", "订立量", "价格", "数量"] });
  assert.equal(tradePaneLabel({}), "订立");
  assert.equal(tradePaneLabel({ exitType: "TAKE_PROFIT" }), "转让");
  assert.deepEqual(tradeSubmitLabels({ action: "BUY" }), ["买入订立", "买订立"]);
  assert.deepEqual(tradeSubmitLabels({ action: "SELL" }), ["卖出订立", "卖订立"]);
  assert.deepEqual(tradeSubmitLabels({ action: "SELL", exitType: "TAKE_PROFIT" }), ["卖出转让", "卖转让"]);
  assert.deepEqual(tradeSubmitLabels({ action: "BUY", exitType: "STOP_LOSS" }), ["买入转让", "买转让"]);
  assert.deepEqual(positionListExitLabels({ exitType: "TAKE_PROFIT" }), ["止盈", "转让"]);
  assert.deepEqual(positionListExitLabels({ exitType: "STOP_LOSS" }), ["止损", "转让"]);
  assert.deepEqual(positionListExitLabels({}), ["转让"]);
  assert.equal(isPositionListExitControlText("转让", "转让"), true);
  assert.equal(isPositionListExitControlText("止盈 | 止损", "止盈"), true);
  assert.equal(isPositionListExitControlText("止盈价", "止盈"), false);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/qtfront_tq/intraday-trade", "POST"), true);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/client/#/transcc", "GET"), false);
});

test("pending buy waits for confirm, paper confirm does not create an order", async () => {
  const task = insertTask(`task_pending_${Date.now()}`);
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(task.pendingAction.deadlineAt, null);
  const confirmed = await confirmPendingAction(task.id, { source: "manual_confirm" });
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.equal(confirmed.pendingAction.source, "manual_confirm");
  assert.equal(confirmed.pendingAction.formSubmitBlocked, true);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("auto takeover confirms suggestion without a countdown prompt", async () => {
  const task = insertTask(`task_auto_${Date.now()}`);
  setAutoDecision(task.id, { enabled: true, countdownSec: 5 });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(task.pendingAction.deadlineAt, null);
  const confirmed = await confirmPendingAction(task.id, { source: "auto_timeout" });
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

test("live suggestion with automation enabled is eligible for auto-submit", () => {
  const task = insertTask(`task_live_wait_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(task.pendingAction.deadlineAt, null);
  assert.match(task.pendingAction.message, /全自动接管/);
});

test("live confirm submits only after the user confirms", async () => {
  const task = insertTask(`task_live_confirm_${Date.now()}`, { mode: "LIVE" });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submitted = 0;
  const confirmed = await confirmPendingAction(task.id, {
    source: "manual_confirm",
    runtime: {
      submitSuggestionForm: async () => {
        submitted += 1;
        return { ok: true, submitted: true, code: "TRADE_SUBMITTED", message: "已提交交易请求" };
      },
    },
  });
  assert.equal(submitted, 1);
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.equal(confirmed.pendingAction.formSubmitBlocked, false);
  assert.match(confirmed.pendingAction.message, /已确认并提交/);
  const orders = state.orders.filter((order) => order.taskId === task.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "submitted");
  assert.equal(orders[0].action, "BUY");
});

test("live sell suggestion submits SELL action only after confirmation", async () => {
  const task = insertTask(`task_live_sell_${Date.now()}`, {
    mode: "LIVE",
    decision: { action: "SELL", targetSymbol: "DGJJ", confidence: 0.7, profitProbability: 0.55, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.action, "SELL");
  assert.equal(task.pendingAction.signalTier, "EXPLORATORY");
  let submittedInput;
  const confirmed = await confirmPendingAction(task.id, {
    source: "manual_confirm",
    runtime: {
      submitSuggestionForm: async (input) => {
        submittedInput = input;
        return { ok: true, submitted: true, code: "TRADE_SUBMITTED", message: "已提交卖出请求" };
      },
    },
  });
  assert.equal(submittedInput.action, "SELL");
  assert.equal(submittedInput.exitType || null, null);
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.match(confirmed.pendingAction.message, /提交买空（跌）订单/);
  const order = state.orders.find((item) => item.taskId === task.id);
  assert.equal(order.action, "SELL");
  assert.equal(order.status, "submitted");
});

test("live exit submits 转让 with position ids", async () => {
  const task = insertTask(`task_live_exit_${Date.now()}`, {
    mode: "LIVE",
    decision: {
      action: "SELL",
      exitType: "TAKE_PROFIT",
      targetPositionIds: ["P-9"],
      targetSymbol: "DGKZ",
      targetSymbolName: "丹桂康砖（二期）",
      confidence: 0.7,
      profitProbability: 0.6,
      targetPositionPct: 10,
      maxOrderValuePct: 4,
      reasonCodes: [],
      evidenceIds: [],
      invalidation: "",
      riskFlags: [],
      createdAt: new Date().toISOString(),
      ttlSec: 300,
    },
    market: {
      latest: { price: 1200 },
      account: { availableFunds: 18000, positions: [{ quantity: 2, positionOrderId: "P-9", side: "买", symbol: "DGKZ" }] },
    },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.exitType, "TAKE_PROFIT");
  assert.equal(task.pendingAction.suggestedQty, 2);
  let submittedInput;
  const confirmed = await confirmPendingAction(task.id, {
    source: "manual_confirm",
    runtime: {
      submitSuggestionForm: async (input) => {
        submittedInput = input;
        return { ok: true, submitted: true, code: "POSITION_LIST_EXIT_CLICKED", message: "已点击持仓列表止盈" };
      },
    },
  });
  assert.equal(submittedInput.action, "SELL");
  assert.equal(submittedInput.exitType, "TAKE_PROFIT");
  assert.deepEqual(submittedInput.targetPositionIds, ["P-9"]);
  assert.equal(confirmed.pendingAction.status, "CONFIRMED");
  assert.match(confirmed.pendingAction.message, /已确认并提交止盈卖出订单/);
});

test("multi-board pending action uses and submits the selected board price and identity", async () => {
  const task = insertTask(`task_target_board_${Date.now()}`, {
    mode: "LIVE",
    decision: { action: "BUY", targetSymbol: "DGKZ", targetSymbolName: "丹桂康砖（二期）", targetInstrumentId: "537", confidence: 0.8, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
    market: {
      symbol: "DGJJ",
      latest: { price: 1800 },
      account: { availableFunds: 18000 },
      books: [
        { symbol: "DGJJ", symbolName: "丹桂金尖（二期）", instrumentId: "536", latest: { price: 1800 } },
        { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", latest: { price: 1200 } },
      ],
    },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.targetSymbol, "DGKZ");
  assert.equal(task.pendingAction.suggestedPrice, 1200);
  let submittedInput;
  await confirmPendingAction(task.id, {
    source: "manual_confirm",
    runtime: {
      submitSuggestionForm: async (input) => {
        submittedInput = input;
        return { ok: true, submitted: true, code: "TRADE_SUBMITTED", message: "已提交交易请求" };
      },
    },
  });
  assert.equal(submittedInput.symbol, "DGKZ");
  assert.equal(submittedInput.symbolName, "丹桂康砖（二期）");
  const order = state.orders.find((item) => item.taskId === task.id);
  assert.equal(order.symbol, "DGKZ");
  assert.equal(order.instrumentId, "537");
});

test("live auto timeout cannot skip the confirm dialog when switch is off", async () => {
  const task = insertTask(`task_live_auto_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: false });
  task.pendingAction = buildPendingAction(task, task.decision);
  await assert.rejects(() => confirmPendingAction(task.id, { source: "auto_timeout" }), /AUTO_DECISION_DISABLED/);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("existing paper tasks can switch to confirm-gated live", () => {
  const task = insertTask(`task_mode_${Date.now()}`, { mode: "PAPER", autoDecisionEnabled: true });
  const next = setTaskMode(task.id, "LIVE");
  assert.equal(next.mode, "LIVE");
  assert.equal(next.autoDecisionEnabled, true);
});

test("cancel pending keeps monitoring and does not create an order", () => {
  const task = insertTask(`task_cancel_${Date.now()}`, { mode: "LIVE" });
  task.pendingAction = buildPendingAction(task, task.decision);
  const next = cancelPendingAction(task.id);
  assert.equal(next.pendingAction.status, "CANCELLED");
  assert.equal(next.stopLocked, false);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("cancel while submitting aborts the browser call and keeps the action cancelled", async () => {
  const task = insertTask(`task_cancel_submitting_${Date.now()}`, { mode: "LIVE" });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submissionSignal;
  const confirmation = confirmPendingAction(task.id, {
    runtime: {
      submitSuggestionForm: async (_input, { signal }) => {
        submissionSignal = signal;
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { ok: false, submitted: false };
      },
    },
  });
  for (let attempt = 0; !submissionSignal && attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(submissionSignal);
  const cancelled = cancelPendingAction(task.id);
  assert.equal(cancelled.pendingAction.status, "CANCELLED");
  await assert.rejects(confirmation, /TRADE_SUBMIT_CANCELLED/);
  assert.equal(task.pendingAction.status, "CANCELLED");
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});
