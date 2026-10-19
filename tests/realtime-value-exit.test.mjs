import assert from "node:assert/strict";
import test from "node:test";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { requestDecision } from "../server/provider.mjs";
import { attachPositionExit } from "../server/engine.mjs";
import { analyzeCollectedMarket } from "../server/market-analysis.mjs";

test("实时货值变化 preserves signed account amounts separately from daily and non-realtime values", () => {
  for (const [display, expected] of [["+1.01元", 1.01], ["1元", 1], ["0元", 0], ["-2.50元", -2.5], ["+1,234.56元", 1234.56], ["--", null]]) {
    const account = parseHaohanAccount(`今日盈亏 -99元 货值变化 88元 实时货值变化 ${display}`);
    assert.equal(account.realtimeValueChange, expected);
    assert.equal(account.dayPnl, -99);
    assert.equal(account.valueChange, 88);
  }
  assert.equal(parseHaohanAccount("今日盈亏 99元 货值变化 88元").realtimeValueChange, null);
});

function envelope(format, value) {
  const text = JSON.stringify(value);
  if (format === "anthropic") return { content: [{ type: "text", text }] };
  if (format === "responses") return { output_text: text };
  if (format === "gemini") return { candidates: [{ content: { parts: [{ text }] } }] };
  return { choices: [{ message: { content: text } }] };
}

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} sends realtime account context as AI reference without creating a program exit`, async t => {
    const positions = [{ positionOrderId: "P-profit", side: "买入", orderPrice: 100, quantity: 1, roundTripFee: 1 }, { positionOrderId: "P-loss", side: "买入", orderPrice: 105, quantity: 1, roundTripFee: 1 }];
    let amount, calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const messages = body.input || body.messages || body.contents.map(item => ({ content: item.parts[0].text }));
      const prompt = body.system || body.systemInstruction?.parts[0].text || messages.filter(item => item.role === "system").map(item => item.content).join("\n");
      assert.match(prompt, /realtimeValueChange.*仅作为.*参考/);
      assert.match(prompt, /不得单独触发离场/);
      assert.match(prompt, /盈利与亏损离场均由AI/);
      assert.match(prompt, /逐仓可成交盈亏/);
      assert.match(prompt, /实时盘面优先/);
      assert.match(prompt, /分析完成后.*再次核对/);
      assert.match(prompt, /持续扩亏且继续持有更可能恶化/);
      const context = JSON.parse(messages.at(-1).content);
      assert.equal(context.account.realtimeValueChange, amount);
      assert.equal(context.account.dayPnl, 99);
      assert.equal(context.market.trend, "up");
      assert.deepEqual(context.account.positions, positions);
      return new Response(JSON.stringify(envelope(apiFormat, {
        action: "HOLD", exit_type: null, target_position_ids: [], bullish_profit_probability: 0.65, bearish_profit_probability: 0.25,
        holding_plan: { decision: "HOLD_FOR_TARGET", rationale: "实时货值只作账户环境参考，逐仓由AI判断" },
        exit_plans: positions.map(p => ({ position_id: p.positionOrderId, held_side: "LONG", quantity: 1, valid_for_sec: 120, take_profit_price: 108, stop_loss_price: 95,
          realtime_take_profit: { value_above: 1, take_profit_price: p.orderPrice + 1.5 } })),
      })));
    });
    for (amount of [null, -1, 0, 1.99, 2, 2.01]) {
      const result = await requestDecision({ apiKey: "test", apiFormat, baseUrl: "https://provider.example.test/v1", model: apiFormat === "chat" ? "deepseek-chat" : "compatible" }, {
        account: { realtimeValueChange: amount, dayPnl: 99, positionsVerified: true, positions }, market: { trend: "up" },
      }, { fastAnalysis: true });
      assert.equal(result.action, "HOLD");
      assert.deepEqual(result.targetPositionIds, []);
      assert.equal(result.bullishProfitProbability, 0.65);
      assert.deepEqual(result.exitPlans[0].realtimeTakeProfit, { valueAbove: 1, takeProfitPrice: 101.5 });
    }
    assert.equal(calls, 6);
  });
}

test("desktop layered analysis retains the realtime amount and trend in the model context", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages.at(-1).content);
    assert.equal(input.market.account.realtimeValueChange, 1.01);
    assert.equal(input.market.timeframes["1m"].history.length, 1);
    assert.match(body.messages[0].content, /realtimeValueChange.*仅作为.*参考/);
    assert.match(body.messages[0].content, /实时盘面优先/);
    return new Response(JSON.stringify(envelope("chat", { action: "HOLD", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3 })));
  });
  const now = Date.now();
  await analyzeCollectedMarket({ apiKey: "test", baseUrl: "https://provider.example.test" }, {
    symbol: "DGKZ", timeframe: "1m", dataAt: new Date(now).toISOString(), account: { realtimeValueChange: 1.01 },
    history: [{ timestamp: now - 60000, open: 100, high: 103, low: 99, close: 102, volume: 10 }],
  }, {});
});

for (const heldSide of ["LONG", "SHORT"]) {
  test(`${heldSide}: positive account total does not make a losing position eligible for profit-taking`, () => {
    const isLong = heldSide === "LONG";
    const position = (id, entry) => ({ positionOrderId: id, symbol: "DGKZ", side: isLong ? "买入" : "卖出", orderPrice: entry, quantity: 1, roundTripFee: 1 });
    const market = { symbol: "DGKZ", observedAt: new Date().toISOString(), account: { realtimeValueChange: 2, positionsVerified: true, positions: [position("P-profit", isLong ? 100 : 103), position("P-loss", isLong ? 103 : 100)] }, orderBook: { bids: [{ price: 101.5, volume: 100 }], asks: [{ price: 101.5, volume: 100 }] } };
    const decision = { action: isLong ? "SELL" : "BUY", exitType: "TAKE_PROFIT", targetPositionIds: ["P-profit"] };
    assert.equal(attachPositionExit(decision, market).exitType, "TAKE_PROFIT");
    const mixed = attachPositionExit({ ...decision, targetPositionIds: ["P-profit", "P-loss"] }, market);
    assert.equal(mixed.action, "HOLD");
    assert.ok(mixed.riskFlags.includes("EXIT_PROFIT_NOT_VERIFIED"));
  });
}
