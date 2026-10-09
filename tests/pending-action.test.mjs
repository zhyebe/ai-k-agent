import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { suggestOrderPreview } from "../server/execution.mjs";
import { buildPendingAction, cancelPendingAction, claimManual, confirmPendingAction, setAutoDecision, setTaskMode, startTask, stopController, stopTask, takeoverPendingAction } from "../server/engine.mjs";
import { isForbiddenTradeControl, isPositionListExitControlText, isTradeWriteResponse, normalizeBrowserPlan, positionListExitLabels, suggestionFormLabels, tradePaneLabel, tradeSubmissionOutcome, tradeSubmitLabels } from "../server/tools.mjs";
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
    decision: { action: "BUY", confidence: 0.8, profitProbability: 0.55, bullishProfitProbability: 0.55, bearishProfitProbability: 0.45, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
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
  assert.deepEqual(positionListExitLabels({ exitType: "TAKE_PROFIT" }), ["转让"]);
  assert.deepEqual(positionListExitLabels({ exitType: "STOP_LOSS" }), ["转让"]);
  assert.deepEqual(positionListExitLabels({}), ["转让"]);
  assert.equal(isPositionListExitControlText("转让", "转让"), true);
  assert.equal(isPositionListExitControlText("止盈 | 止损", "止盈"), false);
  assert.equal(isPositionListExitControlText("止盈价", "止盈"), false);
  const plan = normalizeBrowserPlan({
    actions: [
      { type: "click", label: "买入订立" },
      { type: "click", label: "卖出订立" },
      { type: "click", label: "买入订立" },
      { type: "click", label: "关闭窗口" },
      { type: "fill", label: "买量", value: "2" },
    ],
  }, { buttons: [{ label: "买入订立" }, { label: "卖出订立" }], fields: [{ label: "买量" }], rowActions: [{ label: "转让" }] }, { action: "BUY" });
  assert.deepEqual(plan.actions, [{ type: "fill", label: "买量", value: "2" }, { type: "click", label: "买入订立" }]);
  const exitPlan = normalizeBrowserPlan({ actions: [{ type: "click", label: "转让" }] }, { rowActions: [{ label: "转让" }] }, { action: "SELL", exitType: "TAKE_PROFIT" });
  assert.deepEqual(exitPlan.actions, []);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/qtfront_tq/intraday-trade/trade/make", "POST"), true);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/qtfront_tq/intraday-trade/trade/marketTake", "POST"), true);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/qtfront_tq/intraday-trade/trade/cancel", "POST"), false);
  assert.equal(isTradeWriteResponse("https://demo.exchange.local/intraday-trade/trade/make", "POST"), false);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/qtfront_tq/intraday-trade/trade/make", "GET"), false);
  assert.equal(isTradeWriteResponse("https://smyw.haohandahan.cn/client/#/transcc", "GET"), false);
});

test("网页反馈优先于接口响应，点击本身不能证明成交", () => {
  assert.deepEqual(tradeSubmissionOutcome({ responseSeen: false, clicked: { label: "止盈" } }), {
    ok: false, code: "TRADE_SUBMISSION_UNVERIFIED", message: "已点击交易控件，但页面未显示明确结果；需核实订单和持仓", filled: true, submitted: false, uncertain: true, responseOk: null,
  });
  assert.equal(tradeSubmissionOutcome({ responseSeen: true, responseOk: true }).uncertain, true);
  assert.equal(tradeSubmissionOutcome({ responseSeen: true, responseOk: false }).code, "TRADE_SUBMISSION_UNVERIFIED");
  assert.equal(tradeSubmissionOutcome({ responseSeen: true, responseOk: true, pageHint: "可用资金不足" }).code, "TRADE_REJECTED");
  assert.equal(tradeSubmissionOutcome({ responseSeen: false, pageHint: "可用资金不足" }).code, "TRADE_REJECTED");
  assert.equal(tradeSubmissionOutcome({ responseSeen: false, pageHint: "提交成功" }).submitted, true);
  assert.equal(tradeSubmissionOutcome({ responseSeen: true, responseOk: true, pageHint: "提交成功" }).ok, true);
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

test("manual takeover only applies when automatic execution is disabled", () => {
  const task = insertTask(`task_takeover_${Date.now()}`);
  task.pendingAction = buildPendingAction(task, task.decision);
  const next = takeoverPendingAction(task.id);
  assert.equal(next.pendingAction.status, "TAKEN_OVER");
  assert.equal(next.status, "MANUAL_CONTROL");
  assert.equal(next.stopLocked, true);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

for (const mode of ["PAPER", "LIVE"]) {
  test(`${mode} automatic execution ignores legacy manual takeover requests`, () => {
    const task = insertTask(`task_auto_legacy_${mode}_${Date.now()}`, { mode, autoDecisionEnabled: mode === "PAPER", monitoringEnabled: true });
    task.pendingAction = buildPendingAction(task, task.decision);
    for (const takeover of [claimManual, takeoverPendingAction]) {
      const next = takeover(task.id);
      assert.equal(next.status, "MONITORING");
      assert.equal(next.stopLocked, false);
      assert.equal(next.monitoringEnabled, true);
      assert.equal(next.pendingAction.status, "WAITING");
    }
    stopTask(task.id);
    assert.equal(task.stopLocked, true);
    assert.equal(task.monitoringEnabled, false);
  });
}

test("restarting LIVE clears old takeover suggestions but preserves pending fill reconciliation", () => {
  const connectorId = `connector_restart_${Date.now()}`;
  state.connectors.unshift({ connectorId, reviewStatus: "APPROVED", adapterId: "haohan-readonly", capabilities: ["read_visible_market"] });
  try {
    for (const status of ["TAKEN_OVER", "AWAITING_FILL"]) {
      const task = insertTask(`task_restart_${status}_${Date.now()}`, { mode: "LIVE", status: "MANUAL_CONTROL", stopLocked: true, riskProfile: "Balanced" });
      task.target.connectorId = connectorId;
      task.pendingAction = { ...buildPendingAction(task, task.decision), status, message: "old action" };
      startTask(task.id);
      stopController(task.id);
      assert.equal(task.autoDecisionEnabled, false);
      assert.equal(task.stopLocked, false);
      assert.equal(task.monitoringEnabled, true);
      assert.equal(task.pendingAction?.status || null, status === "TAKEN_OVER" ? null : "AWAITING_FILL");
    }
  } finally {
    state.connectors = state.connectors.filter((item) => item.connectorId !== connectorId);
  }
});

test("live suggestion with automation enabled is eligible for auto-submit", () => {
  const task = insertTask(`task_live_wait_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.status, "WAITING");
  assert.equal(task.pendingAction.deadlineAt, null);
  assert.match(task.pendingAction.message, /全自动接管/);
});

test("live auto mode submits the AI action without a confirmation dialog", async () => {
  const task = insertTask(`task_live_auto_submit_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submitted = 0;
  const confirmed = await confirmPendingAction(task.id, {
    source: "auto_timeout",
    runtime: {
      submitSuggestionForm: async () => {
        submitted += 1;
        return { ok: true, submitted: true, code: "TRADE_SUBMITTED", message: "已自动提交交易请求" };
      },
    },
  });
  assert.equal(submitted, 1);
  assert.equal(confirmed.pendingAction.status, "AWAITING_FILL");
  assert.equal(confirmed.pendingAction.source, "auto_timeout");
  assert.equal(state.orders.find((order) => order.taskId === task.id)?.status, "submitted");
});

test("auto click without a verified write request keeps monitoring for reconciliation", async () => {
  const task = insertTask(`task_live_unverified_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submissions = 0;
  const result = await confirmPendingAction(task.id, {
    source: "auto_timeout",
    runtime: {
      submitSuggestionForm: async () => {
        submissions += 1;
        return { ok: false, submitted: false, uncertain: true, code: "TRADE_SUBMISSION_UNVERIFIED" };
      },
    },
  });
  assert.equal(submissions, 1);
  assert.equal(result.pendingAction.status, "AWAITING_FILL");
  assert.equal(result.status, "MONITORING");
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("trade rejection is recorded and the next K remains eligible", async () => {
  const task = insertTask(`task_live_rejected_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  const result = await confirmPendingAction(task.id, {
    source: "auto_timeout",
    runtime: {
      submitSuggestionForm: async () => ({ ok: false, submitted: true, code: "TRADE_REJECTED", message: "可用资金不足" }),
    },
  });
  assert.equal(result.pendingAction.status, "REJECTED");
  assert.equal(result.status, "MONITORING");
  assert.equal(state.orders.find((order) => order.taskId === task.id)?.status, "rejected");
  assert.match(result.pendingAction.message, /可用资金不足/);
});

test("LIVE manual entry acknowledgement never clicks the website submit button", async () => {
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
  assert.equal(submitted, 0);
  assert.equal(confirmed.pendingAction.status, "AWAITING_FILL");
  assert.equal(confirmed.pendingAction.formSubmitBlocked, true);
  assert.match(confirmed.pendingAction.message, /用户在目标页提交/);
  const orders = state.orders.filter((order) => order.taskId === task.id);
  assert.equal(orders.length, 0);
});

test("live auto mode executes the decision without a second AI planning request", async () => {
  const task = insertTask(`task_ai_browser_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submittedInput;
  let planningCalls = 0;
  await confirmPendingAction(task.id, {
    source: "auto_timeout",
    runtime: {
      readTradeControls: async () => { planningCalls += 1; return { ok: true }; },
      requestBrowserActions: async () => { planningCalls += 1; return { actions: [] }; },
      submitSuggestionForm: async (input) => {
        submittedInput = input;
        return { ok: true, submitted: true, code: "AI_BROWSER_CLICKED", message: "AI 已点买入订立" };
      },
    },
  });
  assert.equal(submittedInput.action, "BUY");
  assert.equal(submittedInput.browserPlan, undefined);
  assert.equal(planningCalls, 0);
});

test("live sell suggestion submits SELL action only after confirmation", async () => {
  const task = insertTask(`task_live_sell_${Date.now()}`, {
    mode: "LIVE",
    autoDecisionEnabled: true,
    decision: { action: "SELL", targetSymbol: "DGJJ", confidence: 0.7, profitProbability: 0.55, bullishProfitProbability: 0.45, bearishProfitProbability: 0.55, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.action, "SELL");
  assert.equal(task.pendingAction.signalTier, "EXPLORATORY");
  let submittedInput;
  const confirmed = await confirmPendingAction(task.id, {
    source: "auto_timeout",
    runtime: {
      submitSuggestionForm: async (input) => {
        submittedInput = input;
        return { ok: true, submitted: true, code: "TRADE_SUBMITTED", message: "已提交卖出请求" };
      },
    },
  });
  assert.equal(submittedInput.action, "SELL");
  assert.equal(submittedInput.exitType || null, null);
  assert.equal(confirmed.pendingAction.status, "AWAITING_FILL");
  assert.match(confirmed.pendingAction.message, /后台核实成交/);
  const order = state.orders.find((item) => item.taskId === task.id);
  assert.equal(order.action, "SELL");
  assert.equal(order.status, "submitted");
});

test("live exit submits 转让 with position ids", async () => {
  const task = insertTask(`task_live_exit_${Date.now()}`, {
    mode: "LIVE",
    autoDecisionEnabled: true,
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
    source: "auto_timeout",
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
  assert.equal(confirmed.pendingAction.status, "AWAITING_FILL");
  assert.match(confirmed.pendingAction.message, /后台核实成交/);
});

test("partial row exits reconcile only submitted rows and available quantities", async () => {
  const task = insertTask(`partial_exit_${Date.now()}`, {
    mode: "LIVE", autoDecisionEnabled: false,
    decision: { action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1", "P-2"] },
    market: { latest: { price: 20 }, account: { positions: [{ positionOrderId: "P-1", quantity: 2 }, { positionOrderId: "P-2", quantity: 1 }] } },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  await confirmPendingAction(task.id, { source: "auto_timeout", runtime: {
    submitSuggestionForm: async () => ({ ok: true, submitted: true, completedPositionIds: ["P-1"], submittedQuantity: 1 }),
  } });
  assert.deepEqual(task.pendingAction.targetPositionIds, ["P-1"]);
  assert.equal(task.pendingAction.baselinePositionQty, 2);
  assert.equal(task.pendingAction.suggestedQty, 1);
});

test("pending action preserves AI entry and exit levels", () => {
  const task = insertTask(`task_ai_levels_${Date.now()}`, {
    decision: {
      action: "BUY",
      orderType: "LIMIT",
      entryPrice: 1810,
      targetPrice: 1810,
      takeProfitPrice: 1840,
      stopLossPrice: 1788,
      profitProbability: 0.62,
      bullishProfitProbability: 0.62,
      bearishProfitProbability: 0.38,
      targetPositionPct: 10,
      maxOrderValuePct: 4,
      reasonCodes: [],
      evidenceIds: [],
      invalidation: "",
      riskFlags: [],
      createdAt: new Date().toISOString(),
      ttlSec: 300,
    },
  });
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.entryPrice, 1810);
  assert.equal(task.pendingAction.takeProfitPrice, 1840);
  assert.equal(task.pendingAction.stopLossPrice, 1788);
  assert.equal(task.pendingAction.targetPrice, 1810);
  assert.equal(task.pendingAction.bullishProfitProbability, 0.62);
  assert.equal(task.pendingAction.bearishProfitProbability, 0.38);
});

test("multi-board pending action uses and submits the selected board price and identity", async () => {
  const task = insertTask(`task_target_board_${Date.now()}`, {
    mode: "LIVE",
    autoDecisionEnabled: true,
    decision: { action: "BUY", targetSymbol: "DGKZ", targetSymbolName: "丹桂康砖（二期）", targetInstrumentId: "537", bullishProfitProbability: 0.6, bearishProfitProbability: 0.3, confidence: 0.8, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: [], createdAt: new Date().toISOString(), ttlSec: 300 },
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
    source: "auto_timeout",
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

test("LIVE manual entry does not submit even through a legacy auto-timeout request", async () => {
  const task = insertTask(`task_live_auto_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: false });
  task.pendingAction = buildPendingAction(task, task.decision);
  await confirmPendingAction(task.id, { source: "auto_timeout" });
  assert.equal(task.pendingAction.status, "AWAITING_FILL");
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
});

test("LIVE entry switch can be turned off; task-mode changes preserve it", () => {
  const task = insertTask(`task_entry_mode_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  setAutoDecision(task.id, { enabled: false });
  assert.equal(task.autoDecisionEnabled, false);
  setTaskMode(task.id, "PAPER");
  setTaskMode(task.id, "LIVE");
  assert.equal(task.autoDecisionEnabled, false);
});

test("existing paper tasks can switch to confirm-gated live", () => {
  const task = insertTask(`task_mode_${Date.now()}`, { mode: "PAPER", autoDecisionEnabled: true });
  const next = setTaskMode(task.id, "LIVE");
  assert.equal(next.mode, "LIVE");
  assert.equal(next.autoDecisionEnabled, true);
});

test("switching into live cancels stale paper suggestions", () => {
  const task = insertTask(`task_mode_pending_${Date.now()}`, { mode: "PAPER" });
  task.pendingAction = buildPendingAction(task, task.decision);
  setTaskMode(task.id, "LIVE");
  assert.equal(task.pendingAction.status, "CANCELLED");
});

for (const action of ["BUY", "SELL"]) {
  for (const probability of [undefined, 0.44, 0.45]) {
    test(`live submit checks persisted ${action} probability ${probability} against 45%`, async () => {
      const task = insertTask(`task_probability_guard_${action}_${probability}_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
      task.decision = {
        ...task.decision,
        action,
        profitProbability: 0.9,
        bullishProfitProbability: action === "BUY" ? probability : 0.9,
        bearishProfitProbability: action === "SELL" ? probability : 0.9,
      };
      task.pendingAction = buildPendingAction(task, task.decision);
      task.decision = { ...task.decision, bullishProfitProbability: 0.95, bearishProfitProbability: 0.95 };
      let submitted = 0;
      const submit = () => confirmPendingAction(task.id, { source: "auto_timeout", runtime: {
        submitSuggestionForm: async () => { submitted += 1; return { ok: true, submitted: true }; },
      } });
      try {
        if (probability >= 0.45) {
          await submit();
          assert.equal(submitted, 1);
          assert.equal(task.pendingAction.status, "AWAITING_FILL");
        } else {
          await assert.rejects(submit, /BELOW_ENTRY_THRESHOLD/);
          assert.equal(submitted, 0);
          assert.equal(task.pendingAction.status, "WAITING");
          assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
        }
      } finally {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
      }
    });
  }
}

test("live submit rejects a persisted entry above one unit", async () => {
  const task = insertTask(`task_quantity_guard_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = { ...buildPendingAction(task, task.decision), suggestedQty: 2 };
  await assert.rejects(() => confirmPendingAction(task.id, { source: "auto_timeout" }), /LIVE_ENTRY_QUANTITY_LIMIT/);
  assert.equal(state.orders.filter((order) => order.taskId === task.id).length, 0);
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
  const task = insertTask(`task_cancel_submitting_${Date.now()}`, { mode: "LIVE", autoDecisionEnabled: true });
  task.pendingAction = buildPendingAction(task, task.decision);
  let submissionSignal;
  const confirmation = confirmPendingAction(task.id, {
    source: "auto_timeout",
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
