import "./fixtures/open-market-clock.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { runAnalysis, stopController } from "../server/engine.mjs";
import { requestDecision } from "../server/provider.mjs";
import { suggestOrderPreview } from "../server/execution.mjs";
import { state } from "../server/store.mjs";

for (const action of ["BUY", "SELL"]) {
  test(`${action}: an explicit additional entry survives an omitted existing-position exit plan`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        action, target_symbol: "DGKZ", entry_price: 100, bullish_profit_probability: 0.6, bearish_profit_probability: 0.4,
        holding_plan: { decision: "HOLD_FOR_TARGET", rationale: "旧仓持有，新机会可以增加一笔" }, exit_plans: [],
      }) } }] }));
    });
    const result = await requestDecision({ apiKey: "fixture", baseUrl: "https://fixture.invalid", model: "deepseek-chat" }, {
      account: { positionsVerified: true, positions: [{ positionOrderId: "old", side: "买入", quantity: 1 }] },
      executionPolicy: { conditionalExits: true },
    }, { fastAnalysis: true });
    assert.equal(calls, 1, "unrelated plan omissions must not delay a complete new entry with another model call");
    assert.equal(result.action, action);
    assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
    assert.ok(result.riskFlags.includes("INCOMPLETE_EXIT_PLAN"), "the omitted plan remains visible for continued monitoring");
  });
}

for (const automatic of [true, false]) for (const action of ["BUY", "SELL"]) {
  test(`${automatic ? "automatic" : "manual"} ${action}: three new K entries coexist with old long/short holdings and their exit plans`, async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const id = `multi-entry-${automatic}-${action}`;
    const positions = ["买入", "卖出"].map((side, i) => ({ positionOrderId: `old-${i}`, symbol: "DGKZ", side, quantity: 1, frozenQuantity: 0, orderPrice: 100 }));
    const task = { id, ownerUserId: id, mode: "LIVE", autoDecisionEnabled: automatic, status: "MONITORING", monitoringEnabled: true,
      target: { type: "website", connectorId: "connector_haohan_readonly", browserSessionId: id, url: "https://smyw.haohandahan.cn/client/#/transcc" },
      rules: [], workflow: [], metrics: { equity: 10000 }, decision: { action: "HOLD", evidenceIds: [], riskFlags: [] } };
    state.tasks.unshift(task);
    t.after(() => { stopController(id); state.tasks = state.tasks.filter(item => item !== task); });
    const submissions = [], forms = [];
    const market = () => ({ ok: true, symbol: "DGKZ", timeframe: "1m", observedAt: new Date(now).toISOString(), fingerprint: String(now), source: "test",
      history: [], historyCount: 0, latest: { price: 100 }, quote: { price: 100 }, books: [], indicators: {}, evidenceId: "market:test",
      account: { positionsVerified: true, positions, openOrdersVerified: true, openOrders: [], availableFunds: 10000 } });
    const runtime = {
      openMarketBrowser: async () => ({ ok: true }), browserLoginStatus: async () => ({ ok: true, authenticated: true }), observeMarket: async () => market(),
      continueManualEntry: async () => ({ continued: false }),
      fillSuggestionForm: async input => { forms.push(input); return { ok: true, filled: true, submitted: false }; },
      submitSuggestionForm: async input => { submissions.push(input); return { ok: true, submitted: true }; },
      requestDecision: async (_provider, context) => {
        assert.equal(context.strategy.loop.entry.emptyOnly, false);
        assert.equal(context.strategy.loop.noSecondEntryWhileHolding, false);
        assert.equal(context.strategy.entryQuantity, 1);
        return { action, targetSymbol: "DGKZ", orderType: "LIMIT", entryPrice: action === "BUY" ? 99 : 101, targetPrice: action === "BUY" ? 99 : 101,
          bullishProfitProbability: 0.62, bearishProfitProbability: 0.42, riskFlags: [], evidenceIds: [], decisionTtlSec: 300,
          holdingPlan: { decision: "HOLD_FOR_TARGET" }, exitPlans: positions.map(p => ({ positionId: p.positionOrderId, quantity: 1,
            heldSide: p.side === "买入" ? "LONG" : "SHORT", takeProfitPrice: p.side === "买入" ? 110 : 90, validForSec: 300 })) };
      },
    };
    for (let round = 0; round < 3; round++) {
      await runAnalysis(id, "", { runtime });
      assert.equal(task.decision.action, action);
      assert.equal(task.exitPlans.length, positions.length);
      assert.equal((automatic ? submissions : forms).length, round + 1);
      const submitted = (automatic ? submissions : forms).at(-1);
      assert.equal(submitted.quantity, 1);
      assert.equal(submitted.price, action === "BUY" ? 99 : 101);
      assert.equal(submitted.exitType || null, null);
      assert.deepEqual(submitted.targetPositionIds, []);
      // A new same-K analysis cannot submit or prompt the same opportunity again.
      await runAnalysis(id, "", { runtime });
      assert.equal((automatic ? submissions : forms).length, round + 1);
      // Simulate an exchange fill (a user click in manual mode), retaining old positions.
      positions.push({ ...positions[0], positionOrderId: `new-${round}`, side: action === "BUY" ? "买入" : "卖出", orderPrice: submitted.price });
      now += 60000;
    }
    assert.equal(submissions.length, automatic ? 3 : 0);
    assert.equal(forms.length, automatic ? 0 : 3);
    assert.equal(positions.length, 5);
  });
}

test("predicted entry price is an explicit LIMIT; MARKET remains immediate at the current market", () => {
  const task = { mode: "LIVE", market: { latest: { price: 100 } } };
  assert.equal(suggestOrderPreview(task, { action: "BUY", orderType: "LIMIT", entryPrice: 98 }).suggestedPrice, 98);
  assert.equal(suggestOrderPreview(task, { action: "SELL", orderType: "LIMIT", entryPrice: 102 }).suggestedPrice, 102);
  assert.equal(suggestOrderPreview(task, { action: "BUY", orderType: "MARKET", entryPrice: 98 }).suggestedPrice, 100);
});

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} receives explicit trend, entry timing and independent new-entry instructions`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const messages = body.input || body.messages || body.contents;
      const prompt = body.system || body.systemInstruction?.parts[0].text || messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      assert.match(prompt, /买多预测阶段低位入、阶段高位出/);
      assert.match(prompt, /买空预测阶段高位入、阶段低位出/);
      assert.match(prompt, /不要求上一单离场或账户空仓/);
      assert.match(prompt, /不强制顶层 action 为 HOLD/);
      assert.match(prompt, /主判断：偏涨\/偏跌\/震荡/);
      assert.match(prompt, /不是等待精确极值/);
      assert.match(prompt, /只要任一方向存在有证据支持、可证伪的正净收益路径/);
      assert.match(prompt, /预测入场价尚未到但限价成交后的预期净收益仍为正时，用同方向 LIMIT/);
      assert.match(prompt, /持仓和旧委托不是全局入场锁/);
      assert.match(prompt, /下一 K 或新的价格\/趋势机会必须重新判断并可再次下单/);
      assert.doesNotMatch(prompt, /When the broad trend supports 买涨 return BUY now/);
      assert.doesNotMatch(prompt, /趋势向上且可以买涨就本轮返回 BUY/);
      assert.match(prompt, /realtimeValueChange.*大于等于2/);
      const value = JSON.stringify({ action: "BUY", order_type: "LIMIT", entry_price: 98, target_price: 98,
        bullish_profit_probability: 0.7, bearish_profit_probability: 0.3,
        analysis_summary: "主判断：偏涨；预测回踩98后向103，采用限价入场" });
      const response = apiFormat === "anthropic" ? { content: [{ type: "text", text: value }] }
        : apiFormat === "responses" ? { output_text: value }
          : apiFormat === "gemini" ? { candidates: [{ content: { parts: [{ text: value }] } }] }
            : { choices: [{ message: { content: value } }] };
      return new Response(JSON.stringify(response));
    });
    const decision = await requestDecision({ apiKey: "fixture", apiFormat, baseUrl: "https://fixture.invalid", model: apiFormat === "chat" ? "deepseek-chat" : "fixture" }, { account: { positions: [] }, market: {} });
    assert.equal(calls, 1);
    assert.equal(decision.action, "BUY", "a worthwhile forecast entry uses an explicit BUY LIMIT plan");
    assert.equal(decision.orderType, "LIMIT");
    assert.equal(decision.entryPrice, 98);
    assert.match(decision.analysisSummary, /主判断：偏涨/);
  });
}
