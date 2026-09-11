import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionContext, enforceDecisionLimits, runAnalysis, runMonitoringCycle, startController, startTask, stopController, stopTask } from "../server/engine.mjs";
import { createProvider } from "../server/provider.mjs";
import { analysisLayerWindows } from "../server/analysis-context.mjs";
import { state } from "../server/store.mjs";

test("风险上限只阻断执行路由，不把真实 BUY 意图改成 HOLD", () => {
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
  assert.ok(decision.riskFlags.includes("RISK_LIMIT_EXCEEDED"));
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

test("成功监控轮次持续运行，未变行情不请求模型，变化后开启下一轮并携带上下文", async () => {
  const taskId = `task_monitor_success_${Date.now()}`;
  const task = insertNorthstarTask(taskId);
  task.status = "MONITORING";
  task.monitoringEnabled = true;
  task.stopLocked = false;
  const snapshots = [testMarketSnapshot("fingerprint-a", 100), testMarketSnapshot("fingerprint-a", 100), testMarketSnapshot("fingerprint-b", 101)];
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
  assert.equal(requests[0].market.ticks.length, 0);
  assert.deepEqual(requests[0].market.availableTimeframes, ["1m", "1h", "1d", "1mo"]);
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
  snapshots.push(testMarketSnapshot("fingerprint-b", 101));
  const refreshed = await runMonitoringCycle(taskId, { runtime });
  assert.equal(refreshed.analysisTriggered, true);
  assert.equal(requests.length, 3);
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
  const providerId = `provider_hierarchical_${Date.now()}`;
  const provider = createProvider({ id: providerId, name: "Hierarchical Local", model: "demo", baseUrl: "http://127.0.0.1:1/v1", apiKey: "provider-secret" });
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
      return { action: "BUY", confidence: 0.82, targetPositionPct: 10, maxOrderValuePct: 4, reasonCodes: ["FULL_COVERAGE"], evidenceIds: [context.evidenceIds[0]], invalidation: "测试失效条件", riskFlags: [], decisionTtlSec: 300 };
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
    assert.equal(finalContext.market.liveTicks.length, 0);
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
