import assert from "node:assert/strict";
import test from "node:test";
import { requestDecision } from "../server/provider.mjs";

const flat = { positionsVerified: true, positions: [], positionSummariesVerified: true, positionSummaries: [], openOrdersVerified: true, openOrders: [] };
const provider = { apiKey: "fixture", baseUrl: "https://fixture.invalid", model: "fixture" };
const envelope = (format, value) => {
  const text = JSON.stringify(value);
  return format === "anthropic" ? { content: [{ type: "text", text }] }
    : format === "gemini" ? { candidates: [{ content: { parts: [{ text }] } }] }
      : format === "responses" ? { output_text: text } : { choices: [{ message: { content: text } }] };
};

for (const format of ["chat", "responses", "anthropic", "gemini"]) {
  for (const [action, bullish, bearish, orderType] of [
    ["BUY", 0.4, 0.8, "MARKET"], ["SELL", 0.8, 0.42, "LIMIT"],
    ["BUY", 0.45, 0.8, "LIMIT"], ["SELL", 0.8, 0.6, "MARKET"],
    ["HOLD", 0.4, 0.42, "MARKET"], ["HOLD", 0.6, 0.8, "MARKET"],
  ]) {
    test(`${format}: AI owns ${action} at ${bullish}/${bearish} and ${orderType} price without forced correction`, async t => {
      let calls = 0;
      const reason = action === "HOLD" ? "主判断：震荡，概率达标但当前价格无合适盈利空间，继续观察" : "主判断：偏跌，所选价格有盈利空间";
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response(JSON.stringify(envelope(format, {
          action, bullish_profit_probability: bullish, bearish_profit_probability: bearish,
          order_type: orderType, ...(orderType === "LIMIT" ? { entry_price: 101, target_price: 101 } : {}), analysis_summary: reason,
        })));
      });
      const result = await requestDecision({ ...provider, apiFormat: format }, { account: flat }, { fastAnalysis: true });
      assert.equal(calls, 1);
      assert.equal(result.action, action);
      assert.equal(result.bullishProfitProbability, bullish);
      assert.equal(result.bearishProfitProbability, bearish);
      assert.equal(result.orderType, orderType);
      assert.equal(result.entryPrice, orderType === "LIMIT" ? 101 : null);
      assert.equal(result.targetPrice, orderType === "LIMIT" ? 101 : null);
      assert.equal(result.analysisSummary, reason);
      assert.equal(result.riskFlags.includes("INCONSISTENT_ACTION_PROBABILITY"), false);
      assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
    });
  }
}

test("JSON repair may return eligible HOLD without forcing another trade request", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: ++calls === 1 ? '{"action":'
    : JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.44, bearish_profit_probability: 0.45, analysis_summary: "当前无合适入场价" }) } }] })));
  const result = await requestDecision(provider, { account: flat }, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "HOLD");
  assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
});
