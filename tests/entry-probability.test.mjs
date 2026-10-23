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
  for (const [bullish, bearish, action] of [[0.44, 0.45, "SELL"], [0.45, 0.44, "BUY"], [0.7, 0.45, "SELL"]]) {
    test(`${format}: AI corrects HOLD at ${bullish}/${bearish} and chooses ${action} itself`, async t => {
      const bodies = [];
      t.mock.method(globalThis, "fetch", async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify(envelope(format, {
          action: bodies.length === 1 ? "HOLD" : action, bullish_profit_probability: bullish, bearish_profit_probability: bearish,
          analysis_summary: bodies.length === 1 ? "震荡偏弱，两侧概率约0.44-0.45不足45%，HOLD。" : "已达入场概率门槛",
        })));
      });
      const result = await requestDecision({ ...provider, apiFormat: format }, { account: flat, experiencePrompt: "approved evidence", market: { fingerprint: "same-market" } }, { fastAnalysis: true });
      assert.equal(bodies.length, 2);
      assert.equal(result.action, action);
      assert.equal(result.bullishProfitProbability, bullish);
      assert.equal(result.bearishProfitProbability, bearish);
      const correction = JSON.stringify(bodies[1]);
      assert.match(correction, /INCONSISTENT_ACTION_PROBABILITY/);
      assert.match(correction, /same-market/);
      assert.match(correction, /approved evidence/);
      assert.match(correction, /0\.45/);
      assert.equal(result.modelDiagnostics.attempts[0].decisionError, "INCONSISTENT_ACTION_PROBABILITY");
      assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
    });
  }
}

for (const correction of [
  { action: "HOLD", bullish_profit_probability: 0.44, bearish_profit_probability: 0.45 },
  { action: "BUY", bullish_profit_probability: 0.44, bearish_profit_probability: 0.45 },
  { action: "HOLD", bullish_profit_probability: 0.44, bearish_profit_probability: 0.4499 },
  { action: "SELL", bullish_profit_probability: 0.44 },
]) test(`unresolved probability conflict reports failure instead of inventing an order: ${JSON.stringify(correction)}`, async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(envelope("chat", ++calls === 1
    ? { action: "HOLD", bullish_profit_probability: 0.44, bearish_profit_probability: 0.45 } : correction))));
  const result = await requestDecision(provider, { account: flat }, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "HOLD");
  assert.ok(result.riskFlags.includes("INCONSISTENT_ACTION_PROBABILITY"));
  assert.ok(result.riskFlags.includes("ANALYSIS_INCOMPLETE"));
  assert.match(result.invalidation, /概率与动作矛盾/);
});

for (const [action, bullish, bearish] of [["HOLD", 0.44, 0.4499], ["BUY", 0.45, 0.8], ["SELL", 0.8, 0.45]]) {
  test(`consistent ${action} ${bullish}/${bearish} makes one model request`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(envelope("chat", { action, bullish_profit_probability: bullish, bearish_profit_probability: bearish }))); });
    const result = await requestDecision(provider, { account: flat }, { fastAnalysis: true });
    assert.equal(result.action, action);
    assert.equal(calls, 1);
  });
}

test("one shared correction budget covers JSON repair and probability conflict", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: ++calls === 1 ? '{"action":'
    : JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.44, bearish_profit_probability: 0.45 }) } }] })));
  const result = await requestDecision(provider, { account: flat }, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.ok(result.riskFlags.includes("ANALYSIS_INCOMPLETE"));
});

for (const account of [{ ...flat, positions: [{ quantity: 1 }] }, { ...flat, openOrders: [{ remainingQuantity: 1 }] }, { ...flat, positionsVerified: false }]) {
  test(`account not ready never requests a forced entry: ${JSON.stringify(account)}`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(envelope("chat", { action: "HOLD", bullish_profit_probability: 0.6, bearish_profit_probability: 0.45 }))); });
    const result = await requestDecision(provider, { account }, { fastAnalysis: true });
    assert.equal(result.action, "HOLD");
    assert.equal(calls, 1);
  });
}
