import assert from "node:assert/strict";
import "./fixtures/open-market-clock.mjs";
import test from "node:test";
import { applyEntryBoundary, attachPositionExit, bindDecisionToMarket, buildDecisionContext, buildPendingAction, confirmPendingAction, enforceDecisionLimits, enforceProfitProbability, entryConditionReached, meetsOrderBoundary, monitoringPollIntervalMs, profitSignalTier, runAnalysis, runMonitoringCycle, setTaskMarketSelection, setTaskProvider, startController, startTask, stopController, stopTask } from "../server/engine.mjs";
import { createProvider, requestDecision } from "../server/provider.mjs";
import { analysisLayerWindows } from "../server/analysis-context.mjs";
import { state } from "../server/store.mjs";

test("实盘只限制单笔数量，不把 AI BUY 意图改成 HOLD", () => {
  const decision = enforceDecisionLimits({
    action: "BUY",
    confidence: 0.86,
    targetPositionPct: 42,
    maxOrderValuePct: 12,
    reasonCodes: ["EMA_SLOPE_POSITIVE"],
    evidenceIds: ["market:test"],
    riskFlags: [],
  });
  assert.equal(decision.action, "BUY");
  assert.equal(decision.targetPositionPct, 42);
  assert.equal(decision.maxOrderValuePct, 12);
  assert.equal(decision.riskFlags.includes("RISK_LIMIT_EXCEEDED"), false);
});

test("获利概率分档：大于等于 40% 允许方向性提示", () => {
  assert.equal(profitSignalTier(0.399), "HOLD");
  assert.equal(profitSignalTier(0.4), "EXPLORATORY");
  assert.equal(profitSignalTier(0.4001), "EXPLORATORY");
  assert.equal(profitSignalTier(0.44), "EXPLORATORY");
  assert.equal(profitSignalTier(0.6), "EXPLORATORY");
  assert.equal(profitSignalTier(0.6001), "CAUTIOUS");
  assert.equal(profitSignalTier(0.7001), "STANDARD");
  assert.equal(profitSignalTier(0.8001), "STRONG");
  assert.equal(profitSignalTier(0.9001), "VERY_STRONG");
});

test("模型动作和概率原样保留，主机不使用固定概率门槛阻断 AI 方向", () => {
  const kept = enforceProfitProbability({
    action: "BUY",
    profitProbability: "45%",
    bullishProfitProbability: 45,
    bearishProfitProbability: "0.22",
    riskFlags: [],
  });
  assert.equal(kept.action, "BUY");
  assert.equal(kept.profitProbability, 0.45);
  assert.equal(kept.bullishProfitProbability, 0.45);
  assert.equal(kept.bearishProfitProbability, 0.22);
  assert.equal(kept.signalTier, "AI_RECOGNITION");
  assert.equal(meetsOrderBoundary(kept), true);

  const longPlan = applyEntryBoundary(enforceProfitProbability({
    action: "BUY",
    profitProbability: 0.48,
    bullishProfitProbability: 0.48,
    bearishProfitProbability: 0.51,
    riskFlags: [],
  }));
  const shortPlan = applyEntryBoundary(enforceProfitProbability({
    action: "SELL",
    profitProbability: 0.51,
    bullishProfitProbability: 0.48,
    bearishProfitProbability: 0.51,
    riskFlags: [],
  }));
  assert.equal(meetsOrderBoundary(longPlan), true);
  assert.equal(meetsOrderBoundary(shortPlan), true);

  const below = enforceProfitProbability({
    action: "SELL",
    profitProbability: 0.39,
    bullishProfitProbability: 0.2,
    bearishProfitProbability: 0.39,
    riskFlags: [],
  });
  assert.equal(below.action, "SELL");
  assert.equal(meetsOrderBoundary(below), true);
  assert.equal(below.riskFlags.includes("LOW_PROFIT_PROBABILITY"), false);

  const hold = applyEntryBoundary(enforceProfitProbability({
    action: "HOLD",
    profitProbability: 0.8,
    bullishProfitProbability: 0.8,
    bearishProfitProbability: 0.3,
  }));
  assert.equal(hold.action, "HOLD");
  assert.equal(meetsOrderBoundary(hold), false);

  const shortHold = applyEntryBoundary(enforceProfitProbability({
    action: "HOLD",
    profitProbability: 0.52,
    bullishProfitProbability: 0.43,
    bearishProfitProbability: 0.52,
  }));
  assert.equal(shortHold.action, "HOLD");
  assert.equal(meetsOrderBoundary(shortHold), false);

  const conflictingAction = applyEntryBoundary(enforceProfitProbability({
    action: "BUY",
    profitProbability: 0.39,
    bullishProfitProbability: 0.39,
    bearishProfitProbability: 0.53,
    riskFlags: ["LOW_PROFIT_PROBABILITY"],
  }));
  assert.equal(conflictingAction.action, "BUY");
  assert.equal(conflictingAction.profitProbability, 0.39);
  assert.equal(meetsOrderBoundary(conflictingAction), true);
  assert.equal(conflictingAction.riskFlags.includes("LOW_PROFIT_PROBABILITY"), false);

  const missingSelectedSide = enforceProfitProbability({
    action: "BUY",
    profitProbability: 0.9,
    riskFlags: [],
  });
  assert.equal(meetsOrderBoundary(missingSelectedSide), false);
  assert.ok(missingSelectedSide.riskFlags.includes("INCOMPLETE_DIRECTIONAL_PROBABILITIES"));

  const belowBothSides = applyEntryBoundary(enforceProfitProbability({
    action: "SELL",
    profitProbability: 0.39,
    bullishProfitProbability: 0.38,
    bearishProfitProbability: 0.39,
  }));
  assert.equal(belowBothSides.action, "SELL");
  assert.equal(meetsOrderBoundary(belowBothSides), true);

  const noSides = applyEntryBoundary(enforceProfitProbability({
    action: "HOLD",
    profitProbability: 0.8,
  }));
  assert.equal(noSides.action, "HOLD");
  assert.equal(meetsOrderBoundary(noSides), false);

  const whileHolding = applyEntryBoundary(enforceProfitProbability({
    action: "HOLD",
    profitProbability: 0.52,
    bullishProfitProbability: 0.43,
    bearishProfitProbability: 0.52,
  }), { account: { positions: [{ quantity: 2 }] } });
  assert.equal(whileHolding.action, "HOLD");

  const closeLong = attachPositionExit({ action: "SELL", exitType: "TAKE_PROFIT", profitProbability: 0.6 }, {
    account: { positions: [{ quantity: 2, positionOrderId: "P-9", symbol: "DGKZ", symbolName: "丹桂康砖（二期）", side: "买" }] },
  });
  assert.equal(closeLong.action, "SELL");
  assert.equal(closeLong.exitType, "TAKE_PROFIT");
  assert.deepEqual(closeLong.targetPositionIds, ["P-9"]);
  assert.equal(closeLong.targetSymbol, "DGKZ");
  assert.equal(meetsOrderBoundary(closeLong), true);

  const coverShort = attachPositionExit({ action: "SELL", profitProbability: 0.6 }, {
    account: { positions: [{ quantity: 1, positionOrderId: "P-8", side: "卖" }] },
  });
  assert.equal(coverShort.action, "SELL");
  assert.equal(coverShort.exitType || null, null);
  const wrongExitDirection = attachPositionExit({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-8"] }, {
    account: { positions: [{ quantity: 1, positionOrderId: "P-8", side: "卖" }] },
  });
  assert.equal(wrongExitDirection.action, "HOLD");
  assert.ok(wrongExitDirection.riskFlags.includes("EXIT_DIRECTION_MISMATCH"));
  const coverShortExplicit = attachPositionExit({ action: "BUY", exitType: "STOP_LOSS", targetPositionIds: ["P-8"] }, {
    account: { positions: [{ quantity: 1, positionOrderId: "P-8", side: "卖" }] },
  });
  assert.equal(coverShortExplicit.action, "BUY");
  assert.equal(coverShortExplicit.exitType, "STOP_LOSS");
  const missingPosition = attachPositionExit({ action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-missing"] }, {
    account: { positions: [{ quantity: 2, positionOrderId: "P-9", side: "买" }] },
  });
  assert.equal(missingPosition.action, "HOLD");
  assert.ok(missingPosition.riskFlags.includes("EXIT_TARGET_NOT_FOUND"));

  const stay = attachPositionExit({ action: "HOLD", profitProbability: 0.52, bullishProfitProbability: 0.43, bearishProfitProbability: 0.52 }, {
    account: { positions: [{ quantity: 2, positionOrderId: "P-9", side: "买" }] },
  });
  assert.equal(stay.action, "HOLD");
  assert.equal(stay.exitType || null, null);

  const exit = enforceProfitProbability({
    action: "SELL",
    exitType: "TAKE_PROFIT",
    profitProbability: 0.2,
    bearishProfitProbability: 0.2,
  });
  assert.equal(exit.action, "SELL");
  assert.equal(meetsOrderBoundary(exit), true);
});

test("入场检查只要求方向概率完整，不比较多空差值或固定百分比", () => {
  for (const action of ["BUY", "SELL"]) {
    for (const probability of [0, 0.03, 0.21, 0.39, 0.399999, 0.4, 0.400001, 0.41, 0.44, 0.45]) {
      for (const otherProbability of [probability, Math.max(0, probability - 0.02), 0.9]) {
        const decision = applyEntryBoundary(enforceProfitProbability({
          action,
          profitProbability: probability,
          bullishProfitProbability: action === "BUY" ? probability : otherProbability,
          bearishProfitProbability: action === "SELL" ? probability : otherProbability,
          riskFlags: [],
        }));
        assert.equal(decision.action, action);
        assert.equal(decision.profitProbability, probability);
        assert.equal(meetsOrderBoundary(decision), true);
        assert.equal(decision.signalTier, "AI_RECOGNITION");
        assert.equal(decision.riskFlags.includes("LOW_PROFIT_PROBABILITY"), false);
      }
    }
  }
  for (const missing of [undefined, null, "", "invalid", -0.01]) {
    const incomplete = enforceProfitProbability({ action: "BUY", bullishProfitProbability: 0.03, bearishProfitProbability: missing });
    assert.equal(meetsOrderBoundary(incomplete), false);
  }
});

test("已核实持仓可以立即离场，不要求它仍在入场监测盘口中", () => {
  const market = { symbol: "NEW", books: [{ symbol: "NEW" }], account: { positions: [{ symbol: "OLD", symbolName: "旧持仓", positionOrderId: "P-old", side: "买", quantity: 1 }] } };
  const exit = attachPositionExit({ action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-old"] }, market);
  assert.equal(bindDecisionToMarket(exit, market).action, "SELL");
  assert.equal(bindDecisionToMarket(exit, market).exitType, "TAKE_PROFIT");
  const missing = attachPositionExit({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-missing"], targetSymbol: "OLD" }, market);
  assert.equal(missing.action, "HOLD");
  assert.ok(missing.riskFlags.includes("EXIT_TARGET_NOT_FOUND"));
});

for (const autoDecisionEnabled of [false, true]) {
  for (const action of ["BUY", "SELL"]) {
    for (const probability of [0.39, 0.4, 0.44]) {
      test(`${probability * 100}% ${action}由 AI 决定，遵守${autoDecisionEnabled ? "自动" : "手动"}提交策略`, async () => {
        const taskId = `threshold_${probability}_${action}_${autoDecisionEnabled}_${Date.now()}`;
        const task = insertNorthstarTask(taskId);
        Object.assign(task, { mode: "LIVE", autoDecisionEnabled, status: "MONITORING", monitoringEnabled: true });
        const market = testMarketSnapshot("threshold-entry", 100);
        market.account.positions = [];
        let submitted = 0;
        let filled = 0;
        const runtime = {
          openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
          browserLoginStatus: async () => ({ ok: true, authenticated: true }),
          observeMarket: async () => market,
          fillSuggestionForm: async () => { filled += 1; return { ok: true, filled: true, submitted: false }; },
          submitSuggestionForm: async () => { submitted += 1; return { ok: true, filled: true, submitted: true }; },
          requestDecision: async (_provider, context) => ({
            action, bullishProfitProbability: action === "BUY" ? probability : 0.42,
            bearishProfitProbability: action === "SELL" ? probability : 0.42,
            targetPositionPct: 10, maxOrderValuePct: 4, evidenceIds: [context.evidenceIds[0]], riskFlags: [],
          }),
        };
        try {
          await runMonitoringCycle(taskId, { runtime });
          assert.equal(task.decision.action, action);
          assert.equal(task.pendingAction.action, action);
          assert.equal(task.pendingAction.suggestedQty, 1);
          assert.equal(task.pendingAction.formFilled, true);
          assert.equal(submitted, autoDecisionEnabled ? 1 : 0);
          assert.equal(task.pendingAction.status, autoDecisionEnabled ? "AWAITING_FILL" : "WAITING");
        } finally {
          stopController(taskId);
          state.tasks = state.tasks.filter((item) => item.id !== taskId);
        }
      });
    }
  }
}

for (const autoDecisionEnabled of [false, true]) {
  for (const side of ["买", "卖"]) {
    for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
      test(`${autoDecisionEnabled ? "自动" : "手动"}入场模式的${side}持仓${exitType}在本轮立即提交`, async () => {
        const taskId = `conservative_${autoDecisionEnabled}_${side}_${exitType}_${Date.now()}`;
        const task = insertNorthstarTask(taskId);
        Object.assign(task, { mode: "LIVE", autoDecisionEnabled, status: "MONITORING", monitoringEnabled: true });
        task.rules = [{ id: "review", mode: "REVIEW", status: "pending" }, { id: "block", mode: "BLOCK", status: "pending" }];
        const market = testMarketSnapshot("conservative-exit", 100);
        market.account.positions = [{ symbol: "BTC/USDT", side, quantity: 2, positionOrderId: "P-close", orderPrice: 101 }];
        task.pendingAction = { action: "BUY", status: "CONFIRMED", entryKWindow: new Date(Math.floor(Date.now() / 60_000) * 60_000 + 50_000).getTime() };
        const action = side === "买" ? "SELL" : "BUY";
        const submissions = [];
        const runtime = {
          openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
          browserLoginStatus: async () => ({ ok: true, authenticated: true }),
          observeMarket: async () => market,
          fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false }),
          submitSuggestionForm: async (input) => { submissions.push(input); return { ok: true, submitted: true }; },
          requestDecision: async (_provider, context) => ({ action, exitType, targetPositionIds: ["P-close"], bullishProfitProbability: 0.2, bearishProfitProbability: 0.2, evidenceIds: [context.evidenceIds[0]], riskFlags: [] }),
        };
        try {
          await runMonitoringCycle(taskId, { runtime });
          assert.equal(submissions.length, 1);
          assert.equal(submissions[0].action, action);
          assert.equal(submissions[0].exitType, exitType);
          assert.deepEqual(submissions[0].targetPositionIds, ["P-close"]);
          assert.equal(submissions[0].quantity, 2);
          assert.equal(task.pendingAction.status, "AWAITING_FILL");
          assert.equal(task.decision.riskFlags.includes("HUMAN_REVIEW_REQUIRED"), false);
          assert.equal(task.decision.riskFlags.includes("RED_LINE_TRIGGERED"), false);
          assert.equal(task.pendingAction.decisionRunId, task.decision.runId);
        } finally {
          stopController(taskId);
          state.tasks = state.tasks.filter((item) => item.id !== taskId);
        }
      });
    }
  }
}

for (const autoDecisionEnabled of [false, true]) {
  for (const price of [98, 102]) {
    test(`${autoDecisionEnabled ? "自动" : "手动"}模式越过旧离场价${price}仍先分析，AI持仓判断不被价格替代`, async () => {
      const taskId = `hold_outlook_${autoDecisionEnabled}_${price}_${Date.now()}`;
      const task = insertNorthstarTask(taskId);
      Object.assign(task, { mode: "LIVE", autoDecisionEnabled, status: "MONITORING", monitoringEnabled: true });
      const market = testMarketSnapshot(`hold-outlook-${price}`, price);
      market.account.positions = [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-hold", orderPrice: 100, takeProfitPrice: 101, stopLossPrice: 99 }];
      let analyzed = 0;
      let submitted = 0;
      const runtime = {
        openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
        browserLoginStatus: async () => ({ ok: true, authenticated: true }),
        observeMarket: async () => market,
        fillSuggestionForm: async () => { throw new Error("AI_HOLD_MUST_NOT_FILL"); },
        submitSuggestionForm: async () => { submitted += 1; return { ok: true, submitted: true }; },
        requestDecision: async (_provider, context) => {
          analyzed += 1;
          assert.equal(context.account.positions[0].positionOrderId, "P-hold");
          assert.equal(context.strategy.loop.exit.profitGoal, "MAXIMIZE_EXPECTED_NET_PROFIT");
          assert.equal(context.strategy.loop.exit.lossGoal, "MINIMIZE_PREDICTED_LOSS");
          return { action: "HOLD", bullishProfitProbability: 0.3, bearishProfitProbability: 0.2, evidenceIds: [context.evidenceIds[0]], analysisSummary: "继续持仓的预期净结果更好", riskFlags: [] };
        },
      };
      try {
        await runMonitoringCycle(taskId, { runtime });
        await runMonitoringCycle(taskId, { runtime });
        assert.equal(analyzed, 2);
        assert.equal(submitted, 0);
        assert.equal(task.decision.action, "HOLD");
        assert.equal(task.decision.exitType || null, null);
        assert.equal(task.pendingAction, undefined);
      } finally {
        stopController(taskId);
        state.tasks = state.tasks.filter((item) => item.id !== taskId);
      }
    });
  }
}

test("实盘入场自动与手动默认数量为 1，观察模式不填实盘数量", () => {
  const base = { id: "quantity-limit", mode: "LIVE", autoDecisionCountdownSec: 30, autoDecisionEnabled: true, symbol: "A", metrics: { equity: 1000 }, market: { books: [{ symbol: "A", latest: { price: 1 } }] } };
  const decision = { action: "BUY", targetSymbol: "A", profitProbability: 0.8, targetPositionPct: 30, maxOrderValuePct: 8 };
  const automated = buildPendingAction(base, decision);
  assert.equal(automated.suggestedQty, 1);
  assert.equal(automated.quantityLimitApplied, true);
  const manual = buildPendingAction({ ...base, autoDecisionEnabled: false }, decision);
  assert.equal(manual.suggestedQty, 1);
  assert.equal(manual.quantityLimitApplied, true);
  const paper = buildPendingAction({ ...base, mode: "PAPER" }, decision);
  assert.equal(paper.suggestedQty, 80);
  const minimum = buildPendingAction({ ...base, metrics: { equity: 0 } }, decision);
  assert.equal(minimum.suggestedQty, 1);
  assert.equal(minimum.quantityLimitApplied, false);
});

test("最终决策上下文包含当前页面、账户、时间戳和全部盘口", () => {
  const books = [
    { symbol: "DGKZ", symbolName: "第一个盘口", timeframes: { "1m": { history: [] } } },
    { symbol: "DGJJ", symbolName: "第二个盘口", timeframes: { "1m": { history: [] } } },
  ];
  const market = {
    symbol: "DGKZ",
    symbolName: "第一个盘口",
    source: "browser-dom",
    sourceKind: "LIVE_PAGE",
    dataAt: "2026-09-11T01:58:00.000Z",
    observedAt: "2026-09-11T01:58:01.000Z",
    latest: { price: 123.45 },
    account: { availableFunds: 8888, equity: 9999 },
    pageView: { route: "/transcc", visibleInstrument: "DGKZ" },
    page: { visibleText: "当前实盘页面", view: { route: "/transcc" } },
    books,
    bookCount: books.length,
    timeframes: {},
    availableTimeframes: [],
    analysisLayers: { timezone: "Asia/Shanghai", layers: [] },
  };
  const task = {
    id: "context-task",
    market,
    metrics: { exposurePct: 5 },
    rules: [],
    decision: { action: "HOLD" },
  };
  const context = buildDecisionContext(task, market, [], "manual", market);
  assert.equal(context.market.books.length, 2);
  assert.equal(context.market.bookCount, 2);
  assert.deepEqual(context.market.pageView, market.pageView);
  assert.equal(context.market.source, "browser-dom");
  assert.equal(context.market.dataAt, market.dataAt);
  assert.equal(context.market.observedAt, market.observedAt);
  assert.equal(context.account.availableFunds, 8888);
  assert.equal(context.account.equity, 9999);
  assert.equal(context.market.nextCandle.kind, "NEXT_CANDLE");
  assert.equal(context.market.nextCandle.periodMs, 60000);
  assert.equal(context.market.nextCandle.printSecond, 50);
  assert.equal(context.strategy.kline.printSecond, 50);
  assert.equal(context.strategy.analysis.waitForResult, true);
  assert.equal(context.strategy.analysis.onComplete, "CONTINUE_NEXT_ROUND");
  assert.deepEqual(context.strategy.loop.aiCompletes, ["ANALYZE", "RESULT", "ENTRY_DIRECTION", "EXIT_TIMING", "BROWSER_PLAN"]);
  assert.deepEqual(context.approvedSkills, []);
});

test("持仓上下文提供持仓时长、浮动收益、峰值波动和回撤给AI", () => {
  const orderTime = new Date(Date.now() - 120000).toISOString();
  const market = {
    symbol: "DGKZ",
    symbolName: "第一个盘口",
    source: "browser-dom",
    latest: { price: 123 },
    account: {
      positions: [{ positionOrderId: "P-1", symbol: "DGKZ", symbolName: "第一个盘口", side: "买", orderPrice: 120, quantity: 1, orderTime }],
    },
    books: [{ symbol: "DGKZ", latest: { price: 123 } }],
    history: [],
    timeframes: {},
    analysisLayers: { timezone: "Asia/Shanghai", layers: [] },
  };
  const task = { id: "position-context-task", market, metrics: {}, rules: [], decision: { action: "HOLD" }, positionTracking: {} };
  const context = buildDecisionContext(task, market, [], "monitor", market);
  const position = context.market.positions[0];
  assert.equal(position.positionId, "P-1");
  assert.equal(position.side, "LONG");
  assert.equal(position.entryPrice, 120);
  assert.equal(position.currentPrice, 123);
  assert.ok(position.holdingDurationSec >= 120);
  assert.ok(position.unrealizedPnlPct > 2.4);
  assert.ok(position.maxFavorableExcursionPct > 2.4);
  assert.equal(position.maxAdverseExcursionPct, 0);
  assert.equal(context.account.positionContext[0].positionId, "P-1");
  assert.ok(task.positionTracking["P-1"]);
  task.exitPlans = [{ positionId: "P-1", heldSide: "LONG", quantity: 1, takeProfitPrice: 135, stopLossPrice: 110, status: "ARMED", expiresAt: new Date(Date.now() + 60000).toISOString(), rationale: "大趋势向上，容忍正常回撤" }];

  const pullbackMarket = { ...market, latest: { price: 121 }, books: [{ symbol: "DGKZ", latest: { price: 121 } }] };
  const pullbackContext = buildDecisionContext(task, pullbackMarket, [], "monitor", pullbackMarket);
  assert.deepEqual(pullbackContext.previousAnalysis.exitPlans, task.exitPlans);
  assert.notEqual(pullbackContext.previousAnalysis.exitPlans, task.exitPlans);
  assert.notEqual(pullbackContext.previousAnalysis.exitPlans[0], task.exitPlans[0]);
  task.exitPlans[0].status = "TRIGGERED";
  assert.equal(pullbackContext.previousAnalysis.exitPlans[0].status, "ARMED");
  assert.equal(pullbackContext.market.positions[0].currentPrice, 121);
  assert.ok(pullbackContext.market.positions[0].pullbackFromBestPct > 1.5);
  assert.ok(pullbackContext.market.positions[0].maxFavorableExcursionPct > 2.4);
});

test("空仓回撤和峰值浮盈浮亏按真实方向提供给AI", () => {
  const task = { market: {}, metrics: {}, rules: [], decision: { action: "HOLD" } };
  const snapshot = (price) => ({ symbol: "A", latest: { price }, account: { positions: [{ positionOrderId: "P-short", symbol: "A", side: "卖", orderPrice: 100, quantity: 1 }] }, books: [{ symbol: "A", latest: { price } }], analysisLayers: { layers: [] } });
  const contextAt = (price) => {
    task.market = snapshot(price);
    return buildDecisionContext(task, task.market, [], "monitor", task.market).account.positionContext[0];
  };
  assert.equal(contextAt(95).maxFavorableExcursionPct, 5);
  const rebound = contextAt(97);
  assert.equal(rebound.maxFavorableExcursionPct, 5);
  assert.equal(rebound.maxAdverseExcursionPct, 0);
  assert.equal(rebound.pullbackFromBestPct, 2);
  const loss = contextAt(103);
  assert.equal(loss.maxFavorableExcursionPct, 5);
  assert.equal(loss.maxAdverseExcursionPct, -3);
  assert.equal(loss.unrealizedPnlPct, -3);
});

test("中文持仓使用本盘报价，缺失本盘报价不混用其他盘价格", () => {
  const market = { symbol: "A", symbolName: "甲商品", latest: { price: 200 }, account: { positions: [
    { positionOrderId: "P-B", symbolName: "乙商品", side: "买", orderPrice: 100, quantity: 1 },
    { positionOrderId: "P-C", symbolName: "丙商品", side: "卖", orderPrice: 100, quantity: 1 },
    { positionOrderId: "P-B-short", symbolName: "乙商品", side: "卖", orderPrice: 100, quantity: 1 },
  ] }, books: [{ symbol: "B", symbolName: "乙商品", latest: { price: 101 }, orderBook: { bids: [{ price: 99, volume: 2 }], asks: [{ price: 102, volume: 3 }] } }], analysisLayers: { layers: [] } };
  const task = { market, metrics: {}, rules: [], decision: { action: "HOLD" } };
  const context = buildDecisionContext(task, market, [], "monitor", market);
  assert.equal(context.account.positionContext[0].currentPrice, 101);
  assert.equal(context.account.positionContext[0].exitQuotePrice, 99);
  assert.equal(context.account.positionContext[0].exitQuotePnlPct, -1);
  assert.equal(context.account.positionContext[1].currentPrice, null);
  assert.equal(context.account.positionContext[1].unrealizedPnlPct, null);
  assert.equal(context.account.positionContext[1].exitQuotePrice, null);
  assert.equal(context.account.positionContext[2].exitQuotePrice, 102);
  assert.equal(context.account.positionContext[2].exitQuotePnlPct, -2);
  market.books[0].orderBook.bids[0].price = 103;
  const crossed = buildDecisionContext(task, market, [], "monitor", market);
  assert.equal(crossed.account.positionContext[0].exitQuotePrice, null);
  assert.equal(crossed.account.positionContext[2].exitQuotePrice, null);
});

test("多盘口方向性决策必须绑定一个受监控盘口", () => {
  const market = {
    books: [
      { symbol: "DGJJ", symbolName: "丹桂金尖（二期）", instrumentId: "536", latest: { price: 1800 } },
      { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", latest: { price: 1168 } },
    ],
  };
  const targeted = bindDecisionToMarket({ action: "BUY", targetSymbol: "DGKZ", riskFlags: [] }, market);
  assert.equal(targeted.action, "BUY");
  assert.equal(targeted.targetSymbolName, "丹桂康砖（二期）");
  assert.equal(targeted.targetInstrumentId, "537");

  const probabilityTargeted = bindDecisionToMarket({
    action: "SELL",
    bullishProfitProbability: 0.41,
    bearishProfitProbability: 0.53,
    riskFlags: [],
    boardAssessments: [
      { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", action: "SELL", bullishProfitProbability: 0.41, bearishProfitProbability: 0.53 },
    ],
  }, market);
  assert.equal(probabilityTargeted.action, "SELL");
  assert.equal(probabilityTargeted.targetInstrumentId, "537");
  assert.equal(probabilityTargeted.boardAssessments[0].action, "SELL");

  const inferred = bindDecisionToMarket({
    action: "HOLD",
    confidence: 0.9,
    boardAssessments: [
      { symbol: "DGJJ", symbolName: "丹桂金尖（二期）", instrumentId: "536", action: "HOLD", confidence: 0.55, profitProbability: 0.55 },
      { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", action: "BUY", confidence: 0.86, profitProbability: 0.91 },
    ],
  }, market);
  assert.equal(inferred.action, "HOLD");
  assert.equal(inferred.targetInstrumentId, undefined);

  const ambiguous = bindDecisionToMarket({ action: "SELL", riskFlags: [] }, market);
  assert.equal(ambiguous.action, "HOLD");
  assert.ok(ambiguous.riskFlags.includes("TARGET_BOARD_REQUIRED"));

  const unknown = bindDecisionToMarket({ action: "BUY", targetSymbol: "UNKNOWN", riskFlags: [] }, market);
  assert.equal(unknown.action, "HOLD");
  assert.ok(unknown.riskFlags.includes("TARGET_BOARD_NOT_MONITORED"));

  const merged = bindDecisionToMarket({
    action: "HOLD",
    boardAssessments: [
      { symbol: "DGJJ", symbolName: "丹桂金尖（二期）", instrumentId: "536", action: "HOLD", confidence: 0.4, summary: "金尖" },
      { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", action: "HOLD", confidence: 0.4, summary: "康砖一" },
      { symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", action: "HOLD", confidence: 0.5, summary: "康砖二" },
    ],
  }, market);
  assert.equal(merged.boardAssessments.length, 2);
  assert.equal(merged.boardAssessments[1].summary, "康砖二");
});

test("方向必须由 AI 顶层 action 决定，盘口评估不会替 AI 选方向", () => {
  const market = {
    symbol: "DGKZ",
    symbolName: "丹桂康砖（二期）",
    instrumentId: "537",
    books: [{ symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", latest: { price: 1200 } }],
  };
  const inferred = bindDecisionToMarket({
    action: "HOLD",
    profitProbability: 0.55,
    confidence: 0.55,
    boardAssessments: [{ symbol: "DGKZ", symbolName: "丹桂康砖（二期）", instrumentId: "537", action: "BUY", profitProbability: 0.55, confidence: 0.55 }],
  }, market);
  assert.equal(inferred.action, "HOLD");
  assert.equal(inferred.profitProbability, 0.55);
  assert.equal(inferred.targetInstrumentId, undefined);
});

test("只有获利概率没有方向时继续保持观望", () => {
  const decision = bindDecisionToMarket({ action: "HOLD", profitProbability: 0.55, confidence: 0.55 }, {
    symbol: "DGKZ",
    books: [{ symbol: "DGKZ", instrumentId: "537" }],
  });
  assert.equal(decision.action, "HOLD");
});

test("持续监控完成一轮后立即继续，只有入场阈值变化才触发分析", () => {
  assert.equal(monitoringPollIntervalMs({ timeframe: "1m" }), 0);
  assert.equal(monitoringPollIntervalMs({ timeframe: "15m" }), 0);
  const task = { decision: { createdAt: new Date().toISOString(), ttlSec: 300 } };
  const base = { symbol: "A", latest: { price: 100 }, indicators: { ema20: 99, rsi14: 50, volumeRatio: 1 }, trend: "up", orderBook: { imbalance: 0.1 } };
  assert.equal(entryConditionReached(base, { ...base, latest: { price: 100.1 } }, task), false);
  assert.equal(entryConditionReached(base, { ...base, latest: { price: 100.6 } }, task), true);
});

function insertNorthstarTask(id) {
  const task = {
    id,
    name: "northstar-readonly-check",
    status: "READY",
    mode: "PAPER",
    symbol: "BTC/USDT",
    timeframe: "15m",
    automationAuthorized: false,
    stopLocked: false,
    target: {
      type: "website",
      name: "Northstar Exchange",
      url: "https://demo.exchange.local",
      connectorId: "connector_demo_northstar",
      credentialRef: "",
      credentialStatus: "未配置",
      connectionStatus: "disconnected",
    },
    workflow: [
      { key: "connect", label: "连接目标", status: "pending", detail: "等待连接" },
      { key: "login", label: "登录验证", status: "pending", detail: "等待凭据" },
      { key: "collect", label: "数据采集", status: "pending", detail: "等待只读行情" },
      { key: "analyze", label: "趋势分析", status: "pending", detail: "等待触发" },
      { key: "rules", label: "规则裁决", status: "pending", detail: "等待当前轮次" },
      { key: "action", label: "执行动作", status: "pending", detail: "默认只给出建议" },
    ],
    rules: [
      { id: `${id}-r1`, order: 1, name: "数据新鲜度 < 5 秒", mode: "AUTO", status: "standby", detail: "等待实时数据" },
      { id: `${id}-r2`, order: 2, name: "单品种仓位 ≤ 30%", mode: "AUTO", status: "standby", detail: "等待账户对账" },
      { id: `${id}-r3`, order: 3, name: "突破后需人工复核", mode: "REVIEW", status: "standby", detail: "未触发" },
      { id: `${id}-r4`, order: 4, name: "异常波动立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
    ],
    decision: {
      action: "HOLD",
      confidence: 0,
      targetPositionPct: 0,
      maxOrderValuePct: 0,
      reasonCodes: [],
      evidenceIds: [],
      invalidation: "",
      riskFlags: ["NOT_ANALYZED"],
      createdAt: new Date().toISOString(),
      ttlSec: 300,
    },
    metrics: { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
  };
  state.tasks.unshift(task);
  return task;
}

test("切换监测盘口可用盘名，不必先有代码", () => {
  const taskId = `task_board_name_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.ownerUserId = "user_1";
  task.symbol = "DGKZ";
  task.target.selectedSymbol = "DGKZ";
  task.target.selectedSymbolName = "丹桂康砖（二期）";
  const next = setTaskMarketSelection(taskId, { symbolName: "丹桂金尖（二期）" }, "user_1");
  assert.equal(next.symbol, "丹桂金尖（二期）");
  assert.equal(next.target.selectedSymbol, "丹桂金尖（二期）");
  assert.equal(next.target.selectedSymbolName, "丹桂金尖（二期）");
  assert.match(next.nextTrigger, /已切换监测盘口并重新启动监控/);
});

test("切换盘口时旧监控轮次收尾不会停掉新盘监控", async () => {
  const taskId = `task_switch_restart_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.ownerUserId = "user_1";
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstStarted = false;
  let restarted = 0;
  startController(taskId, {
    runCycle: async () => {
      firstStarted = true;
      await gate;
      return { task };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(firstStarted, true);
  stopController(taskId);
  startController(taskId, {
    runCycle: async () => {
      restarted += 1;
      task.nextPollAt = new Date(Date.now() + 50).toISOString();
      return { task };
    },
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    assert.ok(restarted >= 1, `expected new board monitoring to keep running, got ${restarted}`);
  } finally {
    stopController(taskId);
  }
});

async function withDisallowedDemoDomain(run) {
  const previous = process.env.BROWSER_ALLOWED_DOMAINS;
  delete process.env.BROWSER_ALLOWED_DOMAINS;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_ALLOWED_DOMAINS;
    else process.env.BROWSER_ALLOWED_DOMAINS = previous;
  }
}

test("northstar analysis blocks honestly and never returns a leftover BUY", async () => {
  const taskId = `task_engine_${Date.now()}`;
  insertNorthstarTask(taskId);
  const result = await withDisallowedDemoDomain(() => runAnalysis(taskId, "provider_deepseek", { trigger: "manual" }));
  assert.equal(result.skipped, undefined);
  assert.equal(result.task.decision.action, "HOLD");
  assert.equal(result.task.status, "BLOCKED");
  assert.equal(result.route, "CONNECT_FAILED");
  assert.ok(result.task.decision.riskFlags.includes("DOMAIN_NOT_ALLOWED"));
  assert.notEqual(result.task.decision.action, "BUY");
  assert.equal(state.orders.filter((order) => order.taskId === taskId).length, 0);
  assert.ok((result.run?.lineCount || 0) >= 3);
});

test("manual analyze waits for an in-progress cycle instead of returning ANALYZING", async () => {
  const taskId = `task_engine_wait_${Date.now()}`;
  insertNorthstarTask(taskId);
  const [first, second] = await withDisallowedDemoDomain(() => Promise.all([
    runAnalysis(taskId, "provider_deepseek", { trigger: "manual" }),
    runAnalysis(taskId, "provider_deepseek", { trigger: "manual" }),
  ]));
  assert.equal(first.skipped, undefined);
  assert.equal(second.skipped, undefined);
  assert.equal(first.task.decision.action, "HOLD");
  assert.equal(second.task.decision.action, "HOLD");
  assert.notEqual(first.task.status, "ANALYZING");
  assert.notEqual(second.task.status, "ANALYZING");
  assert.equal(state.orders.filter((order) => order.taskId === taskId).length, 0);
});

test("持续监控在单轮连接失败后继续轮询，停止后不再创建轮次", async () => {
  const taskId = `task_monitor_retry_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const previousInterval = process.env.MONITOR_POLL_INTERVAL_MS;
  const previousDomains = process.env.BROWSER_ALLOWED_DOMAINS;
  process.env.MONITOR_POLL_INTERVAL_MS = "1000";
  process.env.BROWSER_ALLOWED_DOMAINS = "localhost";
  try {
    const before = state.agentRuns.filter((run) => run.taskId === taskId).length;
    startController(taskId);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const during = state.agentRuns.filter((run) => run.taskId === taskId).length;
    assert.ok(during >= before + 2);
    assert.equal(task.monitoringEnabled, true);
    assert.ok(task.nextPollAt);
    stopController(taskId);
    task.monitoringEnabled = false;
    task.stopLocked = true;
    const stoppedAt = state.agentRuns.filter((run) => run.taskId === taskId).length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(state.agentRuns.filter((run) => run.taskId === taskId).length, stoppedAt);
  } finally {
    stopController(taskId);
    if (previousInterval === undefined) delete process.env.MONITOR_POLL_INTERVAL_MS;
    else process.env.MONITOR_POLL_INTERVAL_MS = previousInterval;
    if (previousDomains === undefined) delete process.env.BROWSER_ALLOWED_DOMAINS;
    else process.env.BROWSER_ALLOWED_DOMAINS = previousDomains;
  }
});

function testMarketSnapshot(fingerprint, price) {
  const now = Date.now();
  const history = Array.from({ length: 25 }, (_, index) => {
    const close = price - 12 + index;
    return { timestamp: now - (24 - index) * 60000, open: close - 1, high: close + 1, low: close - 2, close, volume: 100 + index, partial: false };
  });
  return {
    ok: true,
    source: "test-readonly-market",
    sourceKind: "readonly-interface",
    symbol: "BTC/USDT",
    symbolName: "测试品种",
    instrumentId: "test-contract",
    timeframe: "1m",
    history,
    historyCount: history.length,
    completeHistoryCount: history.length,
    ticks: [{ timestamp: now, price, volume: 3 }],
    timeframes: { "1m": { timeframe: "1m", period: 0, history, historyCount: history.length, completeHistoryCount: history.length, ticks: [], missingFields: [], dataQuality: "VERIFIED", ok: true } },
    availableTimeframes: ["1m"],
    timeline: { kind: "timeline", ticks: [{ timestamp: now, price, volume: 3 }], tickCount: 1 },
    quote: { price, open: price - 1, high: price + 1, low: price - 2, volume: 200 },
    latest: { price, open: price - 1, high: price + 1, low: price - 2, volume: 200 },
    changePct: 1.2,
    indicators: { ema20: price - 2, ema50: price - 4, sma20: price - 3, rsi14: 58, atr14: 3, volumeRatio: 1.2, macd: { line: 1, signal: 0.8, histogram: 0.2 }, bollinger: { middle: price - 3, upper: price + 3, lower: price - 9 } },
    trend: "up",
    anomaly: false,
    freshnessSec: 0,
    dataQuality: "VERIFIED",
    missingFields: [],
    marketClosed: false,
    account: { availableFunds: 1000, riskRate: 0.1 },
    evidenceId: `market:${fingerprint}`,
    fingerprint,
    observedAt: new Date(now).toISOString(),
    dataAt: new Date(now).toISOString(),
    raw: { source: "test", timeline: { ticks: [{ timestamp: now, price }] } },
  };
}

test("双用户自动分析分别使用各自启用的共享模型", async () => {
  const first = insertNorthstarTask(`provider-user-a-${Date.now()}`);
  const second = insertNorthstarTask(`provider-user-b-${Date.now()}`);
  Object.assign(first, { ownerUserId: "provider-user-a", status: "MONITORING", monitoringEnabled: true });
  Object.assign(second, { ownerUserId: "provider-user-b", status: "MONITORING", monitoringEnabled: true });
  const providers = [
    { ...createProvider({ name: "STEPFUN", model: "step-5", baseUrl: "https://step.example.test", apiKey: "test-key-a" }), ownerUserId: first.ownerUserId },
    { ...createProvider({ name: "deepseek", model: "deepseek-chat", baseUrl: "https://deep.example.test", apiKey: "test-key-b" }), ownerUserId: second.ownerUserId },
  ];
  state.providers.push(...providers);
  const calls = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => testMarketSnapshot(`shared-model-${calls.length}`, 100),
    requestDecision: async (provider, context) => {
      calls.push(provider.id);
      return { action: "HOLD", bullishProfitProbability: 0.2, bearishProfitProbability: 0.3, evidenceIds: [context.evidenceIds[0]], riskFlags: [] };
    },
    submitSuggestionForm: async () => assert.fail("model selection test cannot submit an order"),
  };
  try {
    setTaskProvider(first.id, providers[0].id, first.ownerUserId);
    setTaskProvider(second.id, providers[1].id, second.ownerUserId);
    await runMonitoringCycle(first.id, { userId: first.ownerUserId, runtime });
    await runMonitoringCycle(second.id, { userId: second.ownerUserId, runtime });
    assert.deepEqual(calls, [providers[0].id, providers[1].id]);
    setTaskProvider(first.id, providers[1].id, first.ownerUserId);
    setTaskProvider(second.id, providers[0].id, second.ownerUserId);
    await runAnalysis(first.id, "", { userId: first.ownerUserId, runtime });
    await runAnalysis(second.id, "", { userId: second.ownerUserId, runtime });
    assert.deepEqual(calls, [providers[0].id, providers[1].id, providers[1].id, providers[0].id]);
    assert.equal(first.providerId, providers[1].id);
    assert.equal(second.providerId, providers[0].id);
  } finally {
    for (const task of [first, second]) stopController(task.id);
    state.tasks = state.tasks.filter((task) => ![first.id, second.id].includes(task.id));
    state.providers = state.providers.filter((provider) => !providers.some((item) => item.id === provider.id));
  }
});

for (const autoDecisionEnabled of [false, true]) {
  test(`委托撤销独立于${autoDecisionEnabled ? "自动" : "手动"}入场、HOLD和同K限制，未变行情继续分析`, async () => {
    const task = insertNorthstarTask(`pending_orders_${autoDecisionEnabled}_${Date.now()}`);
    Object.assign(task, { mode: "LIVE", autoDecisionEnabled, entryQuantity: 3, status: "MONITORING", monitoringEnabled: true, lastEntryKWindow: Date.now() });
    const market = testMarketSnapshot("pending-orders-unchanged", 103);
    market.account = { positions: [], positionsVerified: true, openOrdersVerified: true, openOrders: [
      { orderId: "O-1", symbol: "BTC/USDT", side: "买", orderKind: "订立", orderPrice: 100, quantity: 3, filledQuantity: 1, remainingQuantity: 2 },
      { orderId: "O-2", symbol: "BTC/USDT", side: "卖", orderPrice: 104, quantity: 1, remainingQuantity: 1 },
    ] };
    task.market = { ...market, account: { ...market.account, openOrders: [] } };
    task.pendingAction = { ...buildPendingAction(task, { action: "BUY", targetSymbol: "BTC/USDT", orderType: "LIMIT", targetPrice: 100, bullishProfitProbability: 0.6 }), status: "AWAITING_FILL", source: "auto_timeout" };
    const cancelled = [];
    let rounds = 0;
    const runtime = {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async (_provider, context) => {
        rounds += 1;
        assert.equal(context.account.openOrders[0].remainingQuantity, 2);
        assert.equal(context.strategy.entryQuantity, 3);
        return { action: "HOLD", bullishProfitProbability: 0.2, bearishProfitProbability: 0.3, cancelOrderIds: ["O-1", "unknown"], orderAssessments: [{ orderId: "O-2", decision: "KEEP", reason: "still profitable" }], evidenceIds: [context.evidenceIds[0]], riskFlags: [] };
      },
      cancelOpenOrders: async (input) => { cancelled.push(input.orderIds); return { ok: true, results: input.orderIds.map((orderId) => ({ orderId, cancelled: true })) }; },
      submitSuggestionForm: async () => assert.fail("HOLD cannot create an entry"),
    };
    try {
      await runMonitoringCycle(task.id, { runtime });
      assert.equal(task.pendingAction?.status === "CONFIRMED", false);
      assert.deepEqual(cancelled, [["O-1"]]);
      assert.equal(state.orders.find((order) => order.taskId === task.id)?.status, "cancelled_remainder");
      await runMonitoringCycle(task.id, { runtime });
      assert.equal(rounds, 2);
      assert.equal(task.status, "MONITORING");
    } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
  });
}

for (const autoDecisionEnabled of [false, true]) {
  for (const action of ["BUY", "SELL"]) {
    test(`${autoDecisionEnabled ? "自动" : "手动"}模式 ${action} 入场先按 AI 撤销旧委托且保留部分成交持仓`, async () => {
      const task = insertNorthstarTask(`entry_after_cancel_${autoDecisionEnabled}_${action}_${Date.now()}`);
      Object.assign(task, { mode: "LIVE", autoDecisionEnabled, entryQuantity: 1, status: "MONITORING", monitoringEnabled: true });
      const market = testMarketSnapshot(`entry-after-cancel-${autoDecisionEnabled}-${action}`, 101);
      market.account = {
        ...market.account,
        positionsVerified: true,
        openOrdersVerified: true,
        positions: [{ positionOrderId: "P-partial", symbol: "BTC/USDT", side: action === "BUY" ? "买" : "卖", quantity: 1, orderPrice: 100 }],
        openOrders: [
          { orderId: "O-cancel", symbol: "BTC/USDT", side: action === "BUY" ? "买" : "卖", orderKind: "订立", quantity: 2, filledQuantity: 1, remainingQuantity: 1 },
          { orderId: "O-keep", symbol: "BTC/USDT", side: action === "BUY" ? "买" : "卖", orderKind: "订立", quantity: 1, filledQuantity: 0, remainingQuantity: 1 },
        ],
      };
      const events = [];
      try {
        await runMonitoringCycle(task.id, {
          runtime: {
            openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
            browserLoginStatus: async () => ({ ok: true, authenticated: true }),
            observeMarket: async () => market,
            requestDecision: async (_provider, context) => {
              assert.equal(context.account.positions.some((position) => position.positionOrderId === "P-partial"), true);
              assert.equal(context.account.openOrders.some((order) => order.orderId === "O-cancel"), true);
              return {
                action,
                targetSymbol: "BTC/USDT",
                orderAssessments: [
                  { orderId: "O-cancel", decision: "CANCEL", reason: "等待不如释放保证金" },
                  { orderId: "O-keep", decision: "KEEP", reason: "仍有成交优势" },
                ],
                bullishProfitProbability: action === "BUY" ? 0.6 : 0.3,
                bearishProfitProbability: action === "SELL" ? 0.6 : 0.3,
                profitProbability: 0.6,
                evidenceIds: [context.evidenceIds[0]],
                riskFlags: [],
              };
            },
            cancelOpenOrders: async ({ orderIds }) => {
              events.push(["cancel", ...orderIds]);
              assert.deepEqual(orderIds, ["O-cancel"]);
              return { ok: true, results: [{ orderId: "O-cancel", cancelled: true }] };
            },
            fillSuggestionForm: async (input) => {
              events.push(["fill", input.action]);
              assert.equal(input.action, action);
              return { ok: true, filled: true, submitted: false };
            },
            submitSuggestionForm: async (input) => {
              events.push(["submit", input.action]);
              assert.equal(input.action, action);
              return { ok: true, filled: true, submitted: true };
            },
          },
        });
        assert.deepEqual(events, autoDecisionEnabled ? [["cancel", "O-cancel"], ["submit", action]] : [["cancel", "O-cancel"], ["fill", action]]);
        assert.equal(task.market.account.positions.some((position) => position.positionOrderId === "P-partial"), true);
        assert.equal(task.pendingAction.action, action);
        assert.equal(task.pendingAction.status, autoDecisionEnabled ? "AWAITING_FILL" : "WAITING");
      } finally {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
      }
    });
  }
}

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  for (const autoDecisionEnabled of [false, true]) {
    test(`${apiFormat}格式失败后恢复入场、离场、撤单，保留${autoDecisionEnabled ? "自动" : "手动"}模式和历史订单`, async (t) => {
      const task = insertNorthstarTask(`provider_recovery_${apiFormat}_${autoDecisionEnabled}_${Date.now()}`);
      Object.assign(task, { mode: "LIVE", autoDecisionEnabled, status: "MONITORING", monitoringEnabled: true });
      task.rules = [{ id: "review", mode: "REVIEW", status: "pending" }, { id: "block", mode: "BLOCK", status: "pending" }];
      const market = testMarketSnapshot("recovery-0", 103);
      market.orderBook = { bids: [{ price: 103, volume: 10 }], asks: [{ price: 104, volume: 10 }] };
      market.account = { positionsVerified: true, openOrdersVerified: true, positions: [
        { positionOrderId: "P-legacy", symbol: task.symbol, side: "买", quantity: 1, orderPrice: 100 },
        { positionOrderId: "P-active", symbol: task.symbol, side: "买", quantity: 2, orderPrice: 100 },
      ], openOrders: [{ orderId: "O-cancel", symbol: task.symbol, side: "买", remainingQuantity: 1 }] };
      task.market = structuredClone(market);
      task.pendingAction = { ...buildPendingAction(task, { action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-legacy"], targetSymbol: task.symbol }), status: "AWAITING_FILL", decisionRunId: "old-run", createdAt: "2026-10-10T00:00:00Z" };
      const legacyId = task.pendingAction.id;
      const provider = { apiKey: "synthetic-key", baseUrl: "https://provider.example.test", model: apiFormat === "chat" ? "deepseek-v4-pro" : "test-model", apiFormat };
      let phase = 0;
      let requests = 0;
      const submitted = [];
      const filled = [];
      const cancelled = [];
      const exit_plans = market.account.positions.map(position => ({ position_id: position.positionOrderId, held_side: "LONG", quantity: position.quantity, valid_for_sec: 300, take_profit_price: 104, stop_loss_price: 100 }));
      const answers = [
        '{"action":"BUY",',
        JSON.stringify({ action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3, target_symbol: task.symbol, exit_plans, order_assessments: [{ order_id: "O-cancel", decision: "KEEP", reason: "entry thesis still valid" }] }),
        JSON.stringify({ action: "SELL", exit_type: "TAKE_PROFIT", target_position_ids: ["P-active"], target_symbol: task.symbol, bullish_profit_probability: 0.2, bearish_profit_probability: 0.2, exit_plans, order_assessments: [{ order_id: "O-cancel", decision: "KEEP", reason: "closing path does not require cancellation" }] }),
        JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.2, bearish_profit_probability: 0.2, cancel_order_ids: ["O-cancel"], exit_plans }),
      ];
      t.mock.method(globalThis, "fetch", async () => {
        requests++;
        const text = answers[phase];
        const payload = apiFormat === "chat" ? { choices: [{ message: { reasoning_content: "private", content: [{ type: "text", text }] }, finish_reason: "stop" }] }
          : apiFormat === "responses" ? { output: [{ type: "reasoning", content: [{ type: "text", text: "private" }] }, { type: "message", content: [{ type: "output_text", text }] }], status: "completed" }
            : apiFormat === "anthropic" ? { content: [{ type: "thinking", text: "private" }, { type: "text", text }], stop_reason: "end_turn" }
              : { candidates: [{ content: { parts: [{ thought: true, text: "private" }, { text }] }, finishReason: "STOP" }] };
        return new Response(JSON.stringify(payload));
      });
      const runtime = {
        openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
        observeMarket: async () => ({ ...market, fingerprint: `recovery-${phase}` }),
        requestDecision: async (_provider, context, options) => {
          assert.equal(context.executionPolicy.rulesBlockExecution, false);
          assert.equal(context.executionPolicy.entryMode, autoDecisionEnabled ? "automatic" : "manual_submit");
          assert.equal(context.account.positions.length, 2);
          return requestDecision(provider, context, options);
        },
        fillSuggestionForm: async (input) => { filled.push(input); return { ok: true, filled: true }; },
        submitSuggestionForm: async (input) => { submitted.push(input); return { ok: true, filled: true, submitted: true }; },
        cancelOpenOrders: async (input) => { cancelled.push(input.orderIds); return { ok: true, results: input.orderIds.map((orderId) => ({ orderId, cancelled: true })) }; },
      };
      try {
        const failure = await runMonitoringCycle(task.id, { runtime });
        assert.equal(failure.run.status, "error");
        assert.equal(failure.run.code, "INVALID_MODEL_JSON");
        assert.equal(failure.route, "ANALYSIS_FAILED");
        assert.equal(submitted.length, 0);
        assert.equal(task.pendingAction.id, legacyId);
        assert.equal(task.pendingAction.status, "AWAITING_FILL");
        assert.ok(task.nextPollAt);
        assert.equal(state.agentOutput.find((line) => line.runId === failure.run.id && line.kind === "decision").data.modelDiagnostics.jsonStatus, "INVALID_JSON");
        assert.equal(task.lastModelFailure.runId, failure.run.id);
        assert.equal(task.lastModelFailure.recovered, false);
        assert.equal(task.lastModelFailure.modelDiagnostics.jsonError, "TRUNCATED_JSON");
        phase = 1;
        await runMonitoringCycle(task.id, { runtime });
        assert.equal(task.lastModelFailure.runId, failure.run.id);
        assert.equal(task.pendingAction.status, autoDecisionEnabled ? "AWAITING_FILL" : "WAITING");
        assert.equal(task.pendingAction.decisionRunId, task.decision.runId);
        assert.equal(filled.length, autoDecisionEnabled ? 0 : 1);
        assert.equal(submitted.length, autoDecisionEnabled ? 1 : 0);
        assert.ok(task.unsettledActions.some((pending) => pending.id === legacyId));
        phase = 2;
        await runMonitoringCycle(task.id, { runtime });
        assert.equal(submitted.at(-1).exitType, "TAKE_PROFIT");
        assert.deepEqual(submitted.at(-1).targetPositionIds, ["P-active"]);
        assert.equal(submitted.at(-1).quantity, 2);
        phase = 3;
        await runMonitoringCycle(task.id, { runtime });
        assert.deepEqual(cancelled, [["O-cancel"]]);
        assert.equal(requests, 5);
        assert.equal(task.status, "MONITORING");
        assert.equal(task.decision.riskFlags.includes("HUMAN_REVIEW_REQUIRED"), false);
      } finally { stopController(task.id); state.tasks = state.tasks.filter((item) => item.id !== task.id); }
    });
  }
}

test("JSON格式纠正成功后只执行纠正决策一次，并记录恢复诊断", async (t) => {
  const task = insertNorthstarTask(`json_correction_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: true, status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("json-correction", 103);
  market.account = { positionsVerified: true, openOrdersVerified: true, positions: [], openOrders: [] };
  const provider = { apiKey: "synthetic-key", baseUrl: "https://provider.example.test", model: "same-model", apiFormat: "anthropic" };
  let requests = 0;
  const submitted = [];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ content: [{ type: "text", text: requests++ === 0
    ? '{"action":"SELL","cancel_order_ids":["untrusted-order"],'
    : JSON.stringify({ action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3, target_symbol: task.symbol }) }], stop_reason: "end_turn" })));
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    requestDecision: async (_provider, context, options) => requestDecision(provider, context, options),
    submitSuggestionForm: async (input) => { submitted.push(input); return { ok: true, filled: true, submitted: true }; },
    cancelOpenOrders: async () => assert.fail("partial invalid cancellation must never execute"),
  };
  try {
    const result = await runMonitoringCycle(task.id, { runtime });
    assert.equal(result.run.status, "completed");
    assert.equal(requests, 2);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].action, "BUY");
    assert.equal(task.lastModelFailure.recovered, true);
    assert.deepEqual(task.lastModelFailure.modelDiagnostics.attempts.map(item => item.jsonStatus), ["INVALID_JSON", "COMPLETE_JSON"]);
  } finally { stopController(task.id); state.tasks = state.tasks.filter(item => item.id !== task.id); }
});

test("AI KEEP does not invoke cancellation", async () => {
  const task = insertNorthstarTask(`keep_order_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("keep-order", 101);
  market.account.openOrders = [{ orderId: "O-keep", remainingQuantity: 1 }];
  try {
    await runMonitoringCycle(task.id, { runtime: {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async () => ({ action: "HOLD", orderAssessments: [{ orderId: "O-keep", decision: "KEEP" }], riskFlags: [] }),
      cancelOpenOrders: async () => assert.fail("KEEP must preserve the order"),
    } });
    assert.equal(task.status, "MONITORING");
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});

test("撤单失败仍执行本轮AI离场，配置下单量不影响实际离场量", async () => {
  const task = insertNorthstarTask(`cancel_and_exit_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", entryQuantity: 3, status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("cancel-and-exit", 99);
  market.account = { positionsVerified: true, positions: [{ symbol: "BTC/USDT", side: "买", quantity: 5, positionOrderId: "P-1" }], openOrdersVerified: true, openOrders: [{ orderId: "O-1", remainingQuantity: 1 }] };
  let submitted = 0;
  try {
    await runMonitoringCycle(task.id, { runtime: {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async () => ({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1"], cancelOrderIds: ["O-1"], bullishProfitProbability: 0.1, bearishProfitProbability: 0.1, riskFlags: [] }),
      cancelOpenOrders: async () => ({ ok: false, results: [{ orderId: "O-1", cancelled: false, code: "ORDER_CANCEL_REJECTED" }] }),
      submitSuggestionForm: async (input) => { submitted += 1; assert.equal(input.quantity, 5); return { ok: true, submitted: true }; },
    } });
    assert.equal(submitted, 1);
    assert.equal(task.status, "MONITORING");
    assert.equal(task.decision.orderCancellation.ok, false);
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});

test("AI立即离场先于无关撤单执行，慢撤单不拖延离场", async () => {
  const task = insertNorthstarTask(`exit_first_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("exit-first", 99);
  market.account = { positionsVerified: true, positions: [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-1" }], openOrdersVerified: true, openOrders: [{ orderId: "O-1", orderKind: "订立", remainingQuantity: 1 }] };
  const actions = [];
  try {
    await runMonitoringCycle(task.id, { runtime: {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async () => ({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1"], cancelOrderIds: ["O-1"], riskFlags: [] }),
      submitSuggestionForm: async () => { actions.push("exit"); return { ok: true, submitted: true }; },
      cancelOpenOrders: async () => { actions.push("cancel"); assert.deepEqual(actions, ["exit", "cancel"]); return { ok: true, results: [{ orderId: "O-1", cancelled: true }] }; },
    } });
    assert.deepEqual(actions, ["exit", "cancel"]);
    assert.equal(task.status, "MONITORING");
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});

for (const cancelled of [true, false]) {
test(`AI${cancelled ? "撤销" : "未能撤销"}旧离场委托后${cancelled ? "立即提交新离场" : "保留原委托，不重复离场"}`, async () => {
  const task = insertNorthstarTask(`replace_exit_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("replace-exit", 99);
  market.account = { positionsVerified: true, positions: [{ symbol: "BTC/USDT", side: "买", quantity: 2, frozenQuantity: 2, positionOrderId: "P-1" }], openOrdersVerified: true, openOrders: [{ orderId: "O-old", orderKind: "转让", remainingQuantity: 2, positionOrderId: "P-1" }] };
  task.market = market;
  task.pendingAction = { ...buildPendingAction(task, { action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"], targetSymbol: "BTC/USDT", orderType: "LIMIT", targetPrice: 110 }), status: "AWAITING_FILL", source: "auto_timeout", entrustedOrderIds: ["O-old"] };
  const actions = [];
  try {
    await runMonitoringCycle(task.id, { runtime: {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async () => ({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1"], cancelOrderIds: ["O-old"], riskFlags: [] }),
      cancelOpenOrders: async () => { actions.push("cancel"); return { ok: cancelled, results: [{ orderId: "O-old", cancelled }] }; },
      submitSuggestionForm: async (input) => { actions.push("exit"); assert.deepEqual(input.targetPositionIds, ["P-1"]); return { ok: true, submitted: true }; },
    } });
    assert.deepEqual(actions, cancelled ? ["cancel", "exit"] : ["cancel"]);
    assert.equal(task.pendingAction.exitType, cancelled ? "STOP_LOSS" : "TAKE_PROFIT");
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});
}

for (const autoDecisionEnabled of [false, true]) {
test(`撤单失败后${autoDecisionEnabled ? "自动" : "手动"}模式持续交给AI分析并自动重试`, async () => {
  const task = insertNorthstarTask(`retry_cancel_${autoDecisionEnabled}_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled, status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("retry-cancel", 100);
  market.account = { availableFunds: 100, frozenFunds: 3000, openOrdersVerified: true, openOrders: [{ orderId: "O-1", remainingQuantity: 1, frozenMargin: 3000 }] };
  let rounds = 0;
  let attempts = 0;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
    requestDecision: async (_provider, context) => {
      rounds += 1;
      assert.equal(context.account.frozenFunds, 3000);
      return { action: "HOLD", orderAssessments: [{ orderId: "O-1", decision: "CANCEL", reason: "释放保证金更有利" }], riskFlags: [] };
    },
    cancelOpenOrders: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("page temporarily busy");
      return { ok: true, results: [{ orderId: "O-1", cancelled: true }] };
    },
    submitSuggestionForm: async () => assert.fail("cancellation cannot submit an entry"),
  };
  try {
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.status, "MONITORING");
    assert.equal(task.decision.orderCancellation.ok, false);
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(rounds, 2);
    assert.equal(attempts, 2);
    assert.equal(task.decision.orderCancellation.ok, true);
    assert.equal(task.status, "MONITORING");
    assert.notEqual(task.pendingAction?.status, "WAITING");
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});
}

test("启动时已有转让委托，按AI关联的持仓先撤单再离场", async () => {
  const task = insertNorthstarTask(`startup_transfer_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("startup-transfer", 99);
  market.account = { positionsVerified: true, positions: [{ symbol: "BTC/USDT", side: "买", quantity: 1, frozenQuantity: 1, positionOrderId: "P-1" }], openOrdersVerified: true, openOrders: [{ orderId: "O-old", orderKind: "转让", remainingQuantity: 1 }] };
  const actions = [];
  try {
    await runMonitoringCycle(task.id, { runtime: {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market,
      requestDecision: async () => ({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1"], orderAssessments: [{ orderId: "O-old", decision: "CANCEL", targetPositionIds: ["P-1"] }], riskFlags: [] }),
      cancelOpenOrders: async () => { actions.push("cancel"); return { ok: true, results: [{ orderId: "O-old", cancelled: true }] }; },
      submitSuggestionForm: async () => { actions.push("exit"); return { ok: true, submitted: true }; },
    } });
    assert.deepEqual(actions, ["cancel", "exit"]);
  } finally { state.tasks = state.tasks.filter((item) => item.id !== task.id); }
});

test("待核实离场不阻挡立即入场，旧单继续独立核实且自动流程不重复填表", async () => {
  const task = insertNorthstarTask(`unsettled_entry_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: true, status: "MONITORING", monitoringEnabled: true });
  let observed = testMarketSnapshot("pending-old-exit", 100);
  observed.account.positions = [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-old" }];
  task.market = observed;
  task.pendingAction = { ...buildPendingAction(task, { action: "SELL", exitType: "STOP_LOSS", targetSymbol: "BTC/USDT", targetPositionIds: ["P-old"] }), status: "AWAITING_FILL", source: "auto_timeout" };
  const oldId = task.pendingAction.id;
  let filled = 0;
  const submissions = [];
  let action = "BUY";
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => observed,
    fillSuggestionForm: async () => { filled += 1; return { ok: true, filled: true }; },
    submitSuggestionForm: async (input) => { submissions.push(input); return { ok: true, filled: true, submitted: true }; },
    requestDecision: async (_provider, context) => ({ action, targetSymbol: "BTC/USDT", confidence: 0.7, bullishProfitProbability: 0.52, bearishProfitProbability: 0.44, evidenceIds: [context.evidenceIds[0]], riskFlags: [] }),
  };
  try {
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].action, "BUY");
    assert.equal(filled, 0);
    assert.equal(task.pendingAction.formFilled, true);
    assert.equal(task.unsettledActions[0].id, oldId);
    assert.equal(task.status, "MONITORING");
    assert.equal(task.decision.observedAt, observed.observedAt);
    assert.ok(task.decision.analysisDurationMs >= 0);
    // Same K stays idempotent even though an exit is tracked separately.
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(submissions.length, 1);
    observed = testMarketSnapshot("old-exit-closed", 101);
    observed.account.positions = [];
    action = "HOLD";
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.unsettledActions.length, 0);
    assert.equal(state.orders.find((order) => order.idempotencyKey.endsWith(oldId))?.status, "filled");
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
  } finally {
    stopController(task.id);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
  }
});

test("已提交的持仓不重复转让，其他持仓立即离场", async () => {
  const task = insertNorthstarTask(`unsettled_other_exit_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: false, status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("two-exits", 100);
  market.account.positions = ["P-1", "P-2"].map((positionOrderId) => ({ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId }));
  task.market = market;
  task.pendingAction = { ...buildPendingAction(task, { action: "SELL", exitType: "STOP_LOSS", targetSymbol: "BTC/USDT", targetPositionIds: ["P-1"] }), status: "AWAITING_FILL", source: "auto_timeout" };
  const submissions = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    submitSuggestionForm: async (input) => { submissions.push(input); return { ok: true, filled: true, submitted: true }; },
    requestDecision: async (_provider, context) => ({ action: "SELL", exitType: "STOP_LOSS", targetPositionIds: ["P-1", "P-2"], evidenceIds: [context.evidenceIds[0]], riskFlags: [] }),
  };
  try {
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].targetPositionIds, ["P-2"]);
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(submissions.length, 1);
    assert.equal(task.status, "MONITORING");
  } finally {
    stopController(task.id);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
  }
});

test("连续 K 可入场多笔，同一个新增持仓不会重复核实多笔成交", async () => {
  const task = insertNorthstarTask(`concurrent_entries_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: true, status: "MONITORING", monitoringEnabled: true });
  let observed = testMarketSnapshot("entry-one", 100);
  observed.account.positions = [];
  let action = "BUY";
  let submissions = 0;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => observed,
    submitSuggestionForm: async () => { submissions += 1; return { ok: true, filled: true, submitted: true }; },
    requestDecision: async (_provider, context) => ({ action, targetSymbol: "BTC/USDT", bullishProfitProbability: 0.52, bearishProfitProbability: 0.2, evidenceIds: [context.evidenceIds[0]], riskFlags: [] }),
  };
  try {
    await runMonitoringCycle(task.id, { runtime });
    task.pendingAction.entryKWindow -= 60_000;
    observed = testMarketSnapshot("entry-two", 100);
    observed.account.positions = [];
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(submissions, 2);
    action = "HOLD";
    observed = testMarketSnapshot("entry-one-filled", 100);
    observed.account.positions = [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-new" }];
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.unsettledActions.length, 0);
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
    assert.equal(state.orders.filter((order) => order.taskId === task.id && order.status === "filled").length, 1);
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
    observed.account.positions[0].quantity = 2;
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
    assert.equal(state.orders.filter((order) => order.taskId === task.id && order.status === "filled").length, 2);
  } finally {
    stopController(task.id);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
  }
});

test("未读到持仓不代表离场成交，下一次真实空仓才核实", async () => {
  const task = insertNorthstarTask(`unknown_holdings_${Date.now()}`);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: true, status: "MONITORING", monitoringEnabled: true });
  const market = testMarketSnapshot("unknown-holdings", 100);
  task.market = { ...market, account: { positions: [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-1" }] } };
  task.pendingAction = { ...buildPendingAction(task, { action: "SELL", exitType: "STOP_LOSS", targetSymbol: "BTC/USDT", targetPositionIds: ["P-1"] }), status: "AWAITING_FILL", source: "auto_timeout" };
  market.account = { positions: [], positionsVerified: false };
  const runtime = {
    openMarketBrowser: async () => ({ ok: true }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    requestDecision: async () => ({ action: "HOLD", bullishProfitProbability: 0.2, bearishProfitProbability: 0.2, riskFlags: [] }),
  };
  try {
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
    market.account.positionsVerified = true;
    await runMonitoringCycle(task.id, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
  } finally {
    stopController(task.id);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
  }
});

test("生产后端只调度客户端分析，不分片、不向客户端重发完整行情", async () => {
  const previous = process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
  const task = insertNorthstarTask(`client_analysis_${Date.now()}`);
  const market = testMarketSnapshot("client-snapshot", 100);
  task.exitPlans = [{ positionId: "existing", status: "ARMED", takeProfitPrice: 110, stopLossPrice: 94, rationale: "大趋势延续" }];
  let calls = 0;
  try {
    const result = await runAnalysis(task.id, "", { runtime: {
      openMarketBrowser: async () => ({ ok: true, mode: "desktop-embedded" }),
      browserLoginStatus: async () => ({ ok: true, authenticated: true }),
      observeMarket: async () => market,
      requestDecision: async () => { throw new Error("SERVER_ANALYSIS_FORBIDDEN"); },
      requestSegmentReview: async () => { throw new Error("SERVER_SEGMENT_FORBIDDEN"); },
      requestMarketAnalysis: async (_provider, context) => {
        calls++;
        assert.equal(context.market, undefined);
        assert.equal(context.marketRef.fingerprint, market.fingerprint);
        assert.deepEqual(context.previousAnalysis.exitPlans, task.exitPlans);
        assert.notEqual(context.previousAnalysis.exitPlans, task.exitPlans);
        assert.notEqual(context.previousAnalysis.exitPlans[0], task.exitPlans[0]);
        return { market, decision: { action: "HOLD", confidence: 0.5, profitProbability: 0.5, riskFlags: [], evidenceIds: [], decisionTtlSec: 300 }, coverage: { mode: "direct_client", complete: true, bookCount: 1, totalKlineRows: 25 } };
      },
    } });
    assert.equal(calls, 1);
    assert.equal(result.task.analysisCoverage.mode, "direct_client");
    assert.equal(result.task.lastAnalysisSucceeded, true);
  } finally {
    if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
    else process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = previous;
  }
});

test("成功监控轮次持续运行，未变行情不请求模型，任何变化都交给 AI 判断", async () => {
  const taskId = `task_monitor_success_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const snapshots = [testMarketSnapshot("fingerprint-a", 100), testMarketSnapshot("fingerprint-a", 100), testMarketSnapshot("fingerprint-b", 100.1)];
  const requests = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => snapshots.shift(),
    requestDecision: async (_provider, context) => {
      requests.push(context);
      return { action: "BUY", confidence: 0.8, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: ["EMA_SLOPE_POSITIVE"], evidenceIds: [context.evidenceIds[0]], invalidation: "测试失效条件", riskFlags: [], decisionTtlSec: 300 };
    },
  };
  const first = await runMonitoringCycle(taskId, { runtime });
  assert.equal(first.analysisTriggered, true);
  assert.equal(requests.length, 1);
  assert.equal(task.metrics.equity, 1000);
  assert.equal(requests[0].account.availableFunds, 1000);
  assert.equal(requests[0].account.equity, 1000);
  assert.ok(requests[0].market.ticks.length >= 1);
  assert.equal(requests[0].market.nextCandle.kind, "NEXT_CANDLE");
  assert.deepEqual(requests[0].market.availableTimeframes, ["1m"]);
  assert.equal(requests[0].market.timeframes["1h"], undefined);
  assert.ok(requests[0].market.timeframes["1m"].historyCount >= 20);
  assert.equal(requests[0].market.analysisLayers.timezone, "Asia/Shanghai");
  assert.equal(requests[0].market.raw?.timeline, undefined);
  assert.equal(task.monitoringRound, 1);
  assert.equal(task.lastAnalyzedFingerprint, "fingerprint-a");
  assert.equal(state.orders.filter((order) => order.taskId === taskId).length, 0);

  task.status = "PAUSED";
  task.rules[2].status = "pending";
  const unchanged = await runMonitoringCycle(taskId, { runtime });
  assert.equal(unchanged.skipped, true);
  assert.equal(unchanged.reason, "MARKET_UNCHANGED");
  assert.equal(requests.length, 1);
  assert.equal(task.status, "PAUSED");
  assert.equal(task.monitoringRound, 1);

  task.rules[2].status = "standby";
  const changed = await runMonitoringCycle(taskId, { runtime });
  assert.equal(changed.analysisTriggered, true);
  assert.equal(requests.length, 2);
  assert.equal(task.monitoringRound, 2);
  assert.equal(requests[1].conversation.recentRounds.length, 1);
  assert.equal(requests[1].conversation.recentRounds[0].round, 1);

  task.decision.createdAt = new Date(Date.now() - 301000).toISOString();
  snapshots.push(testMarketSnapshot("fingerprint-c", 101));
  const refreshed = await runMonitoringCycle(taskId, { runtime });
  assert.equal(refreshed.analysisTriggered, true);
  assert.equal(requests.length, 3);
});

test("持仓未平时即使行情指纹不变也继续交给模型判断离场", async () => {
  const taskId = `task_monitor_positions_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const snapshot = testMarketSnapshot("fingerprint-hold", 100);
  snapshot.account = { ...(snapshot.account || {}), positions: [{ symbol: "BTC/USDT", quantity: 2, positionOrderId: "P-1" }] };
  const requests = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => snapshot,
    requestDecision: async (_provider, context) => {
      requests.push(context);
      return { action: "HOLD", confidence: 0.5, profitProbability: 0.5, bullishProfitProbability: 0.4, bearishProfitProbability: 0.3, riskFlags: [], evidenceIds: [context.evidenceIds[0]], invalidation: "测试失效条件", decisionTtlSec: 300 };
    },
  };
  const first = await runMonitoringCycle(taskId, { runtime });
  assert.equal(first.analysisTriggered, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].market.availableTimeframes, ["1m", "1h", "1d", "1mo"]);
  assert.ok(requests[0].market.timeframes["1h"]);
  assert.ok(requests[0].market.timeframes["1d"]);
  assert.ok(requests[0].market.timeframes["1mo"]);
  assert.equal(requests[0].market.analysisLayers.layers.length, 4);
  const second = await runMonitoringCycle(taskId, { runtime });
  assert.equal(second.analysisTriggered, true);
  assert.equal(requests.length, 2);
});

test("持仓监控在客户端分析时改用分层 K 线窗口", async () => {
  const previous = process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
  const taskId = `task_hold_layered_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const market = testMarketSnapshot("hold-layered", 100);
  market.account = { ...(market.account || {}), positions: [{ symbol: "BTC/USDT", quantity: 2, positionOrderId: "P-2" }] };
  let window;
  try {
    const result = await runMonitoringCycle(taskId, { runtime: {
      openMarketBrowser: async () => ({ ok: true, mode: "desktop-embedded" }),
      browserLoginStatus: async () => ({ ok: true, authenticated: true }),
      observeMarket: async () => market,
      requestDecision: async () => { throw new Error("SERVER_ANALYSIS_FORBIDDEN"); },
      requestMarketAnalysis: async (_provider, context) => {
        window = context.monitoringWindow;
        return { market, decision: { action: "HOLD", confidence: 0.5, profitProbability: 0.5, riskFlags: [], evidenceIds: [], decisionTtlSec: 300 }, coverage: { mode: "direct_client", complete: true, bookCount: 1, totalKlineRows: 25 } };
      },
    } });
    assert.equal(result.analysisTriggered, true);
    assert.equal(window, "layered");
  } finally {
    if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_BROWSER;
    else process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = previous;
  }
});

test("成功轮次按 nextPollAt 递归调度，显式停止后不再运行", async () => {
  const taskId = `task_controller_success_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  let cycles = 0;
  startController(taskId, {
    runCycle: async () => {
      cycles += 1;
      task.status = "MONITORING";
      task.nextPollAt = new Date(Date.now() + 12).toISOString();
      return { task, market: { ok: true }, analysisTriggered: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.ok(cycles >= 3, `expected at least three cycles, got ${cycles}`);
  const stoppedAt = cycles;
  stopController(taskId);
  task.monitoringEnabled = false;
  task.stopLocked = true;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cycles, stoppedAt);
});

test("停止后立即重启时，旧异步轮次不会写回新生命周期", async () => {
  const taskId = `task_generation_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  const connector = {
    connectorId: `connector_generation_${Date.now()}`,
    type: "website",
    target: "https://smyw.haohandahan.cn/client/#/transcc",
    name: "浩瀚数贸",
    adapterId: "haohan-readonly",
    adapterVersion: "1.0.0",
    status: "DISCOVERED",
    reviewStatus: "APPROVED",
    capabilities: ["read_visible_market"],
  };
  state.connectors.unshift(connector);
  Object.assign(task.target, {
    url: "https://smyw.haohandahan.cn/client/#/transcc",
    connectorId: connector.connectorId,
    adapterId: "haohan-readonly",
    connectionStatus: "readonly_ready",
  });
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  task.riskProfile = "Balanced";
  let releaseDecision;
  let decisionStartedResolve;
  const decisionStarted = new Promise((resolve) => { decisionStartedResolve = resolve; });
  const decisionGate = new Promise((resolve) => { releaseDecision = resolve; });
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => testMarketSnapshot("generation-fingerprint", 100),
    requestDecision: async () => {
      decisionStartedResolve();
      return decisionGate;
    },
    executeDecision: async () => ({ ok: false, code: "TRADING_DISABLED", message: "测试模式未执行" }),
  };
  try {
    const oldRun = runAnalysis(taskId, "provider_deepseek", { trigger: "controller", runtime });
    await decisionStarted;
    const firstGeneration = task.monitorGeneration || 0;
    stopTask(taskId);
    const stoppedGeneration = task.monitorGeneration;
    startTask(taskId);
    stopController(taskId);
    assert.equal(task.monitorGeneration, stoppedGeneration + 1);
    assert.equal(task.status, "MONITORING");
    releaseDecision({ action: "BUY", confidence: 0.9, targetPositionPct: 10, maxOrderValuePct: 2, reasonCodes: ["TEST"], evidenceIds: ["market:generation-fingerprint"], invalidation: "测试", riskFlags: [], decisionTtlSec: 300 });
    const result = await oldRun;
    assert.equal(result.reason, "CYCLE_INVALIDATED");
    assert.ok(task.monitorGeneration > firstGeneration);
    assert.equal(task.decision.action, "HOLD");
    assert.equal(task.lastAnalyzedFingerprint, "");
    assert.equal(state.analyses.filter((analysis) => analysis.taskId === taskId).length, 0);
  } finally {
    stopController(taskId);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    state.connectors = state.connectors.filter((item) => item.connectorId !== connector.connectorId);
  }
});

test("大行情快照先完成全量片段 AI 复核，再生成最终方向建议", async () => {
  const taskId = `task_hierarchical_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.ownerUserId = "user_hierarchical";
  const providerId = `provider_hierarchical_${Date.now()}`;
  const provider = createProvider({ id: providerId, name: "Hierarchical Local", model: "demo", baseUrl: "http://127.0.0.1:1/v1", apiKey: "provider-secret" });
  provider.ownerUserId = task.ownerUserId;
  state.providers.push(provider);
  const previousThreshold = process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES;
  process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES = "20000";
  const now = Date.now();
  const windows = analysisLayerWindows(now);
  const layer = (timeframe) => windows.layers.find((item) => item.timeframe === timeframe);
  const candle = (timestamp, close) => ({ timestamp, previousClose: close, open: close - 1, high: close + 1, low: close - 2, close, volume: 100, amount: 1000, inventory: 10, partial: false });
  const fillLayer = (timeframe, step, count, baseClose) => {
    const window = layer(timeframe);
    const last = window.includeEnd ? window.end : window.end - 1;
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const timestamp = last - index * step;
      if (timestamp < window.start) break;
      rows.push(candle(timestamp, baseClose + index));
    }
    return rows.reverse();
  };
  const minuteHistory = fillLayer("1m", 60_000, 50, 200);
  const hourHistory = fillLayer("1h", 3_600_000, 30, 180);
  const dayHistory = fillLayer("1d", 86_400_000, 28, 160);
  const monthHistory = fillLayer("1mo", 30 * 86_400_000, 36, 120);
  const market = {
    ...testMarketSnapshot("hierarchical-fingerprint", 280),
    symbol: "BTC/USDT",
    dataAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    history: minuteHistory,
    historyCount: minuteHistory.length,
    completeHistoryCount: minuteHistory.length,
    ticks: Array.from({ length: 40 }, (_, index) => ({ timestamp: now - index * 1000, price: 280, volume: 1 })),
    timeframes: {
      "1m": { timeframe: "1m", history: minuteHistory, historyCount: minuteHistory.length, completeHistoryCount: minuteHistory.length, indicators: {}, trend: "up", anomaly: false, missingFields: [], dataQuality: "VERIFIED", ok: true },
      "1h": { timeframe: "1h", history: hourHistory, historyCount: hourHistory.length, completeHistoryCount: hourHistory.length, indicators: {}, trend: "up", anomaly: false, missingFields: [], dataQuality: "VERIFIED", ok: true },
      "1d": { timeframe: "1d", history: dayHistory, historyCount: dayHistory.length, completeHistoryCount: dayHistory.length, indicators: {}, trend: "up", anomaly: false, missingFields: [], dataQuality: "VERIFIED", ok: true },
      "1mo": { timeframe: "1mo", history: monthHistory, historyCount: monthHistory.length, completeHistoryCount: monthHistory.length, indicators: {}, trend: "up", anomaly: false, missingFields: [], dataQuality: "VERIFIED", ok: true },
      "15m": { timeframe: "15m", history: minuteHistory, historyCount: minuteHistory.length, completeHistoryCount: minuteHistory.length, indicators: {}, trend: "up", anomaly: false, missingFields: [], dataQuality: "VERIFIED", ok: true },
    },
    page: { url: "https://demo.exchange.local", visibleText: `readonly page ${"x".repeat(40000)}` },
    raw: { source: "readonly", timeline: { ticks: [1, 2, 3] } },
  };
  let segmentCalls = 0;
  let finalContext;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    requestSegmentReview: async (_provider, segment) => {
      segmentCalls += 1;
      return { ok: true, segmentId: segment.segmentId, contentHash: segment.contentHash, rowCount: segment.rowCount, kind: segment.kind, timeframe: segment.timeframe, summary: `已复核 ${segment.kind}`, trend: "up", bullishEvidence: [], bearishEvidence: [], riskFlags: [], keyLevels: [], confidence: 0.7 };
    },
    requestDecision: async (_provider, context) => {
      finalContext = context;
      return { action: "BUY", confidence: 0.82, profitProbability: 0.82, bullishProfitProbability: 0.82, bearishProfitProbability: 0.18, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: ["FULL_COVERAGE"], evidenceIds: [context.evidenceIds[0]], invalidation: "测试失效条件", riskFlags: [], decisionTtlSec: 300 };
    },
  };
  try {
    const result = await runAnalysis(taskId, providerId, { trigger: "manual", runtime });
    assert.equal(result.task.decision.action, "BUY");
    assert.equal(result.task.analysisCoverage.complete, true);
    assert.equal(result.task.analysisCoverage.reviewedSegments, result.task.analysisCoverage.totalSegments);
    assert.equal(segmentCalls, result.task.analysisCoverage.totalSegments);
    assert.equal(finalContext.analysisMode, "hierarchical_full_coverage");
    assert.equal(finalContext.segmentReviews.length, segmentCalls);
    assert.equal(finalContext.market.liveTicks.length, 40);
    assert.ok(!finalContext.market.timeframes["15m"]);
    assert.ok(finalContext.market.timeframes["1m"].historyCount > 0);
    assert.ok(finalContext.market.timeframes["1h"].historyCount > 0);
    assert.ok(finalContext.market.timeframes["1d"].historyCount > 0);
    assert.ok(finalContext.market.timeframes["1mo"].historyCount > 0);
    assert.equal(result.execution.code, "SUGGESTION_PENDING");
    assert.equal(state.orders.filter((order) => order.taskId === taskId).length, 0);
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    state.providers = state.providers.filter((item) => item.id !== providerId);
    if (previousThreshold === undefined) delete process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES;
    else process.env.ANALYSIS_DIRECT_CONTEXT_MAX_BYTES = previousThreshold;
  }
});

test("空仓方向概率达到40%会提示进场，确认后继续监控，AI 明确决定持仓离场", async () => {
  const taskId = `task_entry_exit_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  task.mode = "PAPER";
  const empty = testMarketSnapshot("entry-loop", 100);
  empty.account = { ...(empty.account || {}), positions: [] };
  const holding = testMarketSnapshot("exit-loop", 101);
  holding.account = {
    ...(holding.account || {}),
    positions: [{ symbol: "BTC/USDT", symbolName: "测试品种", quantity: 2, positionOrderId: "P-9", side: "买" }],
  };
  let round = 0;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false, fields: ["卖价", "卖量"] }),
    observeMarket: async () => (round === 0 ? empty : holding),
    requestDecision: async (_provider, context) => {
      if (round === 0) {
        return {
          action: "SELL",
          confidence: 0.53,
          profitProbability: 0.53,
          bullishProfitProbability: 0.41,
          bearishProfitProbability: 0.53,
          targetPositionPct: 10,
          maxOrderValuePct: 4,
          evidenceIds: [context.evidenceIds[0]],
          riskFlags: [],
          decisionTtlSec: 300,
        };
      }
      return {
        action: "SELL",
        exitType: "TAKE_PROFIT",
        confidence: 0.6,
        profitProbability: 0.6,
        bullishProfitProbability: 0.3,
        bearishProfitProbability: 0.6,
        evidenceIds: [context.evidenceIds[0]],
        riskFlags: [],
        decisionTtlSec: 300,
      };
    },
  };
  try {
    const entry = await runMonitoringCycle(taskId, { runtime });
    assert.equal(entry.analysisTriggered, true);
    assert.equal(task.decision.action, "SELL");
    assert.equal(task.decision.exitType || null, null);
    assert.equal(task.pendingAction?.status, "WAITING");
    assert.equal(task.pendingAction?.action, "SELL");
    assert.equal(task.pendingAction?.exitType || null, null);

    startController(taskId, {
      runCycle: async () => {
        task.nextPollAt = new Date(Date.now() + 60_000).toISOString();
        return { task };
      },
    });
    const confirmed = await confirmPendingAction(taskId);
    assert.equal(confirmed.pendingAction.status, "CONFIRMED");
    stopController(taskId);

    round = 1;
    const exit = await runMonitoringCycle(taskId, { runtime });
    assert.equal(exit.analysisTriggered, true);
    assert.equal(task.decision.action, "SELL");
    assert.equal(task.decision.exitType, "TAKE_PROFIT");
    assert.deepEqual(task.decision.targetPositionIds, ["P-9"]);
    assert.equal(task.pendingAction?.status, "WAITING");
    assert.equal(task.pendingAction?.exitType, "TAKE_PROFIT");
    assert.equal(task.pendingAction?.suggestedQty, 2);
  } finally {
    stopController(taskId);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("手动模式同一 K 不重复提示，下一 K 可再次提示入场", async () => {
  const taskId = `task_next_k_entry_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.mode = "PAPER";
  let observed = testMarketSnapshot("next-k-1", 100);
  observed.account.positions = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => observed,
    fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false, fields: ["买价", "买量"] }),
    requestDecision: async (_provider, context) => ({
      action: "BUY", confidence: 0.7, profitProbability: 0.6,
      bullishProfitProbability: 0.6, bearishProfitProbability: 0.2,
      targetSymbol: "BTC/USDT", evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300,
    }),
  };
  try {
    await runMonitoringCycle(taskId, { runtime });
    const firstId = task.pendingAction.id;
    observed = testMarketSnapshot("next-k-2", 101);
    observed.account.positions = [];
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.id, firstId);
    task.pendingAction.entryKWindow -= 60_000;
    observed = testMarketSnapshot("next-k-3", 102);
    observed.account.positions = [{ symbol: "BTC/USDT", side: "买", quantity: 1, positionOrderId: "P-earlier" }];
    await runMonitoringCycle(taskId, { runtime });
    assert.notEqual(task.pendingAction.id, firstId);
    assert.equal(task.pendingAction.action, "BUY");
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("红线触发时即使 AI 买卖概率过线也不得进入下单流程", async () => {
  const taskId = `task_blocked_entry_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  const market = testMarketSnapshot("blocked-entry", 100);
  market.anomaly = true;
  market.account = { ...(market.account || {}), positions: [] };
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    fillSuggestionForm: async () => { throw new Error("blocked trade reached form"); },
    requestDecision: async (_provider, context) => ({
      action: "BUY", confidence: 0.7, profitProbability: 0.7,
      bullishProfitProbability: 0.7, bearishProfitProbability: 0.2,
      evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300,
    }),
  };
  try {
    const result = await runMonitoringCycle(taskId, { runtime });
    assert.equal(result.route, "BLOCKED");
    assert.equal(task.decision.action, "BUY");
    assert.equal(task.pendingAction || null, null);
    assert.equal(result.execution.code, "RISK_GATE_BLOCKED");
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

for (const exitType of [null, "TAKE_PROFIT", "STOP_LOSS"]) {
test(`LIVE 规则标记不阻止自动${exitType || "入场"}提交`, async () => {
  const taskId = `task_live_rule_mark_${exitType}_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.mode = "LIVE";
  task.autoDecisionEnabled = true;
  task.target.url = "https://smyw.haohandahan.cn/client/#/transcc";
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.rules = [{ id: "review", status: "pending", mode: "REVIEW" }, { id: "anomaly", status: "pending", mode: "BLOCK" }];
  const market = testMarketSnapshot("live-rule-mark", 100);
  market.anomaly = true;
  market.account.positions = exitType ? [{ symbol: "BTC/USDT", side: "卖", quantity: 1, positionOrderId: "P-auto-short" }] : [];
  let submitted = 0;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false }),
    submitSuggestionForm: async () => { submitted += 1; return { ok: true, submitted: true, code: "TRADE_SUBMITTED" }; },
    requestDecision: async (_provider, context) => ({
      action: "BUY", exitType, targetPositionIds: exitType ? ["P-auto-short"] : [], confidence: 0.7,
      profitProbability: exitType ? 0.2 : 0.7, bullishProfitProbability: exitType ? 0.2 : 0.7, bearishProfitProbability: 0.2,
      evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300,
    }),
  };
  try {
    const result = await runMonitoringCycle(taskId, { runtime });
    assert.equal(result.task.decision.action, "BUY");
    assert.equal(submitted, 1);
    assert.equal(result.task.status, "MONITORING");
    assert.equal(result.task.pendingAction.status, "AWAITING_FILL");
    assert.equal(result.task.pendingAction.exitType || null, exitType);
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});
}

for (const autoDecisionEnabled of [false, true]) {
test(`实盘${autoDecisionEnabled ? "自动" : "手动"}入场，持仓变化后自动核实`, async () => {
  const taskId = `task_manual_reconcile_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.mode = "LIVE";
  task.autoDecisionEnabled = autoDecisionEnabled;
  task.target.url = "https://smyw.haohandahan.cn/client/#/transcc";
  task.status = "MONITORING";
  task.monitoringEnabled = false;
  const flat = testMarketSnapshot("manual-flat", 100);
  flat.account.positions = [];
  task.market = flat;
  task.metrics.equity = 1000;
  task.decision = { action: "BUY", targetSymbol: "BTC/USDT", bullishProfitProbability: 0.6, bearishProfitProbability: 0.2, targetPositionPct: 10, maxOrderValuePct: 4, riskFlags: [] };
  task.pendingAction = buildPendingAction(task, task.decision);
  let browserSubmits = 0;
  const acknowledged = await confirmPendingAction(taskId, { source: "manual_confirm", runtime: { submitSuggestionForm: async () => { browserSubmits += 1; return { ok: true, submitted: true, code: "TRADE_SUBMITTED" }; } } });
  assert.equal(browserSubmits, autoDecisionEnabled ? 1 : 0);
  assert.equal(acknowledged.pendingAction.status, "AWAITING_FILL");
  task.monitoringEnabled = true;
  const holding = testMarketSnapshot("manual-filled", 101);
  holding.account.positions = [{ symbol: "BTC/USDT", symbolName: "测试品种", positionOrderId: "P-manual", side: "买", quantity: 1 }];
  let observed = flat;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => observed,
    fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false }),
    requestDecision: async (_provider, context) => ({ action: observed === flat ? "BUY" : "HOLD", confidence: 0.6, profitProbability: 0.6, bullishProfitProbability: 0.6, bearishProfitProbability: 0.2, evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300 }),
  };
  try {
    const waiting = await runMonitoringCycle(taskId, { runtime });
    assert.notEqual(waiting.route, "ORDER_PENDING");
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
    observed = holding;
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
    assert.equal(state.orders.find((order) => order.taskId === taskId)?.status, "filled");
    assert.equal(browserSubmits, autoDecisionEnabled ? 1 : 0);
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});
}

for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
test(`手动入场无需软件确认，成交后自动${exitType}并开启下一轮`, async () => {
  const taskId = `manual_full_flow_${exitType}_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  Object.assign(task, { mode: "LIVE", autoDecisionEnabled: false, status: "MONITORING", monitoringEnabled: true });
  let observed = testMarketSnapshot("manual-flow-flat", 100);
  observed.account.positions = [];
  let action = "BUY";
  let exited = false;
  const submissions = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    continueManualEntry: async () => ({ ok: true, continued: false }),
    observeMarket: async () => observed,
    fillSuggestionForm: async () => ({ ok: true, filled: true, submitted: false }),
    submitSuggestionForm: async (input) => { submissions.push(input); return { ok: true, submitted: true }; },
    requestDecision: async (_provider, context) => ({
      action, exitType: exited ? exitType : null, targetPositionIds: exited ? ["P-human"] : [],
      targetSymbol: "BTC/USDT", confidence: 0.7, bullishProfitProbability: 0.6, bearishProfitProbability: 0.3,
      evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300,
    }),
  };
  startController(taskId, { runCycle: async () => { task.nextPollAt = new Date(Date.now() + 60_000).toISOString(); return { task }; } });
  try {
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "WAITING");
    assert.equal(task.pendingAction.source, null);
    assert.equal(submissions.length, 0);
    observed = testMarketSnapshot("manual-flow-holding", 101);
    observed.account.positions = [{ symbol: "BTC/USDT", side: "买入", quantity: 1, positionOrderId: "P-human" }];
    action = "HOLD";
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
    const entry = state.orders.find((order) => order.taskId === taskId);
    assert.equal(entry.status, "filled");
    assert.equal(entry.source, "manual_browser");
    action = "SELL";
    exited = true;
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].exitType, exitType);
    assert.equal(task.pendingAction.status, "AWAITING_FILL");
    observed = testMarketSnapshot("manual-flow-closed", 102);
    observed.account.positions = [];
    action = "HOLD";
    exited = false;
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
    assert.equal(task.stopLocked, false);
    assert.equal(task.monitoringEnabled, true);
    task.lastEntryKWindow -= 60_000;
    observed = testMarketSnapshot("manual-flow-next-k", 103);
    observed.account.positions = [];
    action = "BUY";
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "WAITING");
    assert.equal(submissions.length, 1);
  } finally {
    stopController(taskId);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});
}

test("实盘离场由 AI 自动提交，持仓归零后自动核实", async () => {
  const taskId = `task_manual_exit_reconcile_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.mode = "LIVE";
  task.target.url = "https://smyw.haohandahan.cn/client/#/transcc";
  task.status = "MONITORING";
  task.monitoringEnabled = false;
  const holding = testMarketSnapshot("exit-holding", 100);
  holding.account.positions = [{ symbol: "BTC/USDT", symbolName: "测试品种", positionOrderId: "P-exit", side: "买", quantity: 2 }];
  task.market = holding;
  task.decision = { action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-exit"], targetSymbol: "BTC/USDT", bearishProfitProbability: 0.5, bullishProfitProbability: 0.3, riskFlags: [] };
  task.pendingAction = buildPendingAction(task, task.decision);
  assert.equal(task.pendingAction.baselinePositionQty, 2);
  await confirmPendingAction(taskId, { source: "manual_confirm", runtime: { submitSuggestionForm: async () => ({ ok: true, submitted: true, code: "TRADE_SUBMITTED" }) } });
  task.monitoringEnabled = true;
  const closed = testMarketSnapshot("exit-closed", 99);
  closed.account.positions = [];
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => closed,
    requestDecision: async (_provider, context) => ({ action: "HOLD", confidence: 0.4, profitProbability: 0.3, bullishProfitProbability: 0.3, bearishProfitProbability: 0.3, evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300 }),
  };
  try {
    await runMonitoringCycle(taskId, { runtime });
    assert.equal(task.pendingAction.status, "CONFIRMED");
    assert.equal(state.orders.find((order) => order.taskId === taskId)?.status, "filled");
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("手动入场模式的止盈离场不等待人工确认，也不受规则标记阻挡", async () => {
  const taskId = `task_manual_profit_exit_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.mode = "LIVE";
  task.autoDecisionEnabled = false;
  task.target.url = "https://smyw.haohandahan.cn/client/#/transcc";
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.rules = [{ id: "review", status: "pending", mode: "REVIEW" }, { id: "block", status: "pending", mode: "BLOCK" }];
  const market = testMarketSnapshot("manual-profit-exit", 105);
  market.account.positions = [{ symbol: "BTC/USDT", symbolName: "测试品种", positionOrderId: "P-profit", side: "买", quantity: 1 }];
  let submitted = 0;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: task.target.url, mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => market,
    submitSuggestionForm: async (input) => { submitted += 1; assert.equal(input.exitType, "TAKE_PROFIT"); return { ok: true, submitted: true, code: "TRADE_SUBMITTED" }; },
    requestDecision: async (_provider, context) => ({
      action: "SELL", exitType: "TAKE_PROFIT", targetPositionIds: ["P-profit"], targetSymbol: "BTC/USDT",
      profitProbability: 0.43, bullishProfitProbability: 0.42, bearishProfitProbability: 0.43,
      evidenceIds: [context.evidenceIds[0]], riskFlags: ["HUMAN_REVIEW_REQUIRED"], decisionTtlSec: 300,
    }),
  };
  try {
    const result = await runMonitoringCycle(taskId, { runtime });
    assert.equal(result.task.decision.exitType, "TAKE_PROFIT");
    assert.equal(submitted, 1);
    assert.equal(result.task.pendingAction.status, "AWAITING_FILL");
    assert.equal(result.task.pendingAction.source, "auto_timeout");
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("等待确认时不拆掉监控循环，确认后立即继续", async () => {
  const taskId = `task_resume_after_confirm_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  task.mode = "PAPER";
  task.decision = {
    action: "BUY",
    confidence: 0.8,
    profitProbability: 0.8,
    bullishProfitProbability: 0.8,
    bearishProfitProbability: 0.2,
    targetPositionPct: 10,
    maxOrderValuePct: 4,
    reasonCodes: [],
    evidenceIds: [],
    riskFlags: [],
    createdAt: new Date().toISOString(),
    ttlSec: 300,
  };
  task.pendingAction = buildPendingAction(task, task.decision);
  let cycles = 0;
  try {
    startController(taskId, {
      runCycle: async () => {
        cycles += 1;
        task.nextPollAt = new Date(Date.now() + 20).toISOString();
        return { task };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(cycles >= 2, `expected monitoring to continue while waiting, got ${cycles}`);
    const confirmed = await confirmPendingAction(taskId);
    assert.equal(confirmed.pendingAction.status, "CONFIRMED");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(cycles >= 2, `expected monitoring to resume after confirm, got ${cycles}`);
  } finally {
    stopController(taskId);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("最终决策上下文包含其他账号已审核的共享 Skill 和每分钟第50秒出K策略", async () => {
  const taskId = `task_skills_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.ownerUserId = "skill-owner";
  const skill = {
    id: `skill_${Date.now()}`,
    title: "回撤经验",
    status: "APPROVED",
    ownerUserId: "another-skill-author",
    version: "v1",
    kind: "expert",
    tags: ["回撤"],
    content: "放量突破后观察回撤再决定方向。",
  };
  state.skills.unshift(skill);
  let captured;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => testMarketSnapshot("skill-feed", 200),
    requestDecision: async (_provider, context) => {
      captured = context;
      return { action: "HOLD", confidence: 0.2, profitProbability: 0.2, bullishProfitProbability: 0.2, bearishProfitProbability: 0.2, evidenceIds: [context.evidenceIds[0]], riskFlags: [], decisionTtlSec: 300 };
    },
  };
  try {
    await runAnalysis(taskId, "", { trigger: "manual", runtime });
    assert.equal(captured.strategy.kline.printSecond, 50);
    assert.equal(captured.approvedSkills[0].title, "回撤经验");
    assert.match(captured.approvedSkills[0].content, /放量突破/);
    assert.match(captured.experiencePrompt, /共享知识库中已审核发布的 Skill/);
    assert.match(captured.experiencePrompt, /回撤经验/);
  } finally {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    state.skills = state.skills.filter((item) => item.id !== skill.id);
  }
});

test("分析超过时限则放弃本轮并立刻继续监控", async () => {
  const previous = process.env.ANALYSIS_TIMEOUT_MS;
  process.env.ANALYSIS_TIMEOUT_MS = "40";
  const taskId = `task_timeout_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => testMarketSnapshot("timeout-feed", 200),
    requestDecision: async (_provider, _context, options) => new Promise((_, reject) => {
      const fail = setTimeout(() => reject(new Error("should have aborted")), 2000);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(fail);
        const error = new Error("ANALYSIS_TIMEOUT");
        error.code = "ANALYSIS_TIMEOUT";
        reject(error);
      }, { once: true });
    }),
  };
  try {
    const result = await runMonitoringCycle(taskId, { runtime });
    assert.equal(result.reason, "ANALYSIS_TIMEOUT");
    assert.equal(task.lastAnalysisSucceeded, false);
    assert.match(task.nextTrigger, /超时/);
    assert.ok(new Date(task.nextPollAt).getTime() <= Date.now() + 200);
  } finally {
    if (previous === undefined) delete process.env.ANALYSIS_TIMEOUT_MS;
    else process.env.ANALYSIS_TIMEOUT_MS = previous;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("默认等待分析返回后立即进入下一轮", async () => {
  const previous = process.env.ANALYSIS_TIMEOUT_MS;
  delete process.env.ANALYSIS_TIMEOUT_MS;
  const taskId = `task_wait_analysis_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const runtime = {
    openMarketBrowser: async () => ({ ok: true, url: "https://demo.exchange.local", mode: "test" }),
    browserLoginStatus: async () => ({ ok: true, authenticated: true }),
    observeMarket: async () => testMarketSnapshot("wait-feed", 200),
    requestDecision: async (_provider, context) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        action: "HOLD",
        confidence: 0.2,
        profitProbability: 0.2,
        bullishProfitProbability: 0.2,
        bearishProfitProbability: 0.2,
        evidenceIds: [context.evidenceIds[0]],
        riskFlags: [],
        decisionTtlSec: 300,
      };
    },
  };
  try {
    const result = await runMonitoringCycle(taskId, { runtime });
    assert.notEqual(result.reason, "ANALYSIS_TIMEOUT");
    assert.equal(result.analysisTriggered, true);
    assert.equal(task.lastAnalysisSucceeded, true);
    assert.equal(task.decision.action, "HOLD");
    assert.ok(new Date(task.nextPollAt).getTime() <= Date.now() + 200);
  } finally {
    if (previous === undefined) delete process.env.ANALYSIS_TIMEOUT_MS;
    else process.env.ANALYSIS_TIMEOUT_MS = previous;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});

test("已核实多空持仓的直接止盈必须比较真实入场价和可成交报价", () => {
  for (const side of ["买入", "卖出"]) {
    const position = { positionOrderId: "startup-old", symbol: "DGKZ", side, quantity: 1, orderPrice: 100 };
    const action = side === "买入" ? "SELL" : "BUY";
    const decision = { action, exitType: "TAKE_PROFIT", targetPositionIds: [position.positionOrderId] };
    const market = { symbol: "DGKZ", observedAt: new Date().toISOString(), latest: { price: side === "买入" ? 110 : 90 },
      account: { positionsVerified: true, positions: [position] }, orderBook: { bids: [{ price: 99, volume: 10 }], asks: [{ price: 101, volume: 10 }] } };
    assert.ok(attachPositionExit(decision, market).riskFlags.includes("EXIT_PROFIT_NOT_VERIFIED"));
    assert.equal(attachPositionExit({ ...decision, exitType: "STOP_LOSS" }, market).action, action);
    market.orderBook = { bids: [{ price: side === "买入" ? 105 : 94, volume: 10 }], asks: [{ price: side === "买入" ? 106 : 95, volume: 10 }] };
    assert.equal(attachPositionExit(decision, market).action, action);
    position.orderPrice = null;
    assert.ok(attachPositionExit(decision, market).riskFlags.includes("EXIT_PROFIT_NOT_VERIFIED"));
  }
});
