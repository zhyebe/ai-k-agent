import assert from "node:assert/strict";
import test from "node:test";
import { requestDecision } from "../server/provider.mjs";
import { decisionLatencyContext, decisionEnvelope, latencyDecision } from "./fixtures/decision-latency.mjs";

// Same fixture measured on v0.3.88 (0cb472a), before request deduplication.
const baselineBytes = { chat: 112566, responses: 112577, anthropic: 112511, gemini: 112637 };

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} fast input keeps all knowledge, history and account facts without duplicate decisions`, async t => {
    const context = await decisionLatencyContext();
    const before = structuredClone(context);
    let body;
    let requestBytes;
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      requestBytes = Buffer.byteLength(options.body);
      body = JSON.parse(options.body);
      return new Response(JSON.stringify(decisionEnvelope(apiFormat, latencyDecision(context))));
    });
    const result = await requestDecision({ apiKey: "fixture", baseUrl: "https://fixture.invalid/v1", model: "fixture", apiFormat }, context, { fastAnalysis: true });
    assert.equal(calls, 1);
    const messages = body.input || body.messages || body.contents.map(m => ({ role: m.role, content: m.parts[0].text }));
    const system = body.system || body.systemInstruction?.parts[0].text || messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.equal(system.split("唯一当前交易流程").length - 1, 1);
    assert.match(system, /选定方向盈利概率>=40%/);
    assert.match(system, /盈利点差>=1时程序立即整行离场，不等待AI/);
    assert.match(system, /亏损点差<=-2时独立AI请求决定EXIT或HOLD/);
    assert.match(system, /下一根及随后1～3根K/);
    const rounds = messages.filter(m => m.content.includes('"type":"prior_monitoring_round"')).map(m => JSON.parse(m.content));
    const decisions = messages.filter(m => ["assistant", "model"].includes(m.role)).map(m => JSON.parse(m.content));
    assert.equal(rounds.length, 8);
    assert.equal(decisions.length, 8);
    for (let i = 0; i < 8; i++) {
      assert.equal(rounds[i].round, i + 1);
      assert.equal(rounds[i].market.fingerprint, `round-${i}`);
      assert.equal("decision" in rounds[i], false);
      assert.equal(decisions[i].analysisSummary, context.conversation.recentRounds[i].decision.analysisSummary);
      assert.deepEqual(decisions[i].exitPlans, context.previousAnalysis.exitPlans);
      assert.deepEqual(decisions[i].orderAssessments, context.previousAnalysis.decision.orderAssessments);
    }
    const current = JSON.parse(messages.at(-1).content);
    assert.deepEqual(current.account, context.account);
    assert.deepEqual(current.market, context.market);
    assert.deepEqual(current.previousAnalysis, context.previousAnalysis);
    assert.equal("recentRounds" in current.conversation, false);
    assert.equal(messages.filter(m => m.content.includes(context.experiencePrompt)).length, 1);
    assert.deepEqual(context, before);
    assert.deepEqual(result.exitPlans, context.previousAnalysis.exitPlans);
    assert.deepEqual(result.orderAssessments.map(o => o.orderId), context.account.openOrders.map(o => o.orderId));
    assert.ok(requestBytes < baselineBytes[apiFormat] * 0.85, `input budget regressed: ${requestBytes} bytes`);
    assert.equal(result.modelDiagnostics.requestBytes, requestBytes);
    assert.ok(result.modelDiagnostics.responseDurationMs >= 0);
    assert.equal(result.modelDiagnostics.providerAttempts, 1);
  });
}

const usageCases = [
  ["chat", { usage: { prompt_tokens: 1000, completion_tokens: 240, prompt_tokens_details: { cached_tokens: 700 }, completion_tokens_details: { reasoning_tokens: 140 } } }, { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 700, reasoningTokens: 140 }],
  ["responses", { usage: { input_tokens: 1000, output_tokens: 240, input_tokens_details: { cached_tokens: 700 }, output_tokens_details: { reasoning_tokens: 140 } } }, { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 700, reasoningTokens: 140 }],
  ["anthropic", { usage: { input_tokens: 300, output_tokens: 240, cache_read_input_tokens: 700, cache_creation_input_tokens: 50 } }, { inputTokens: 1050, outputTokens: 240, cachedInputTokens: 700, cacheCreationInputTokens: 50 }],
  ["gemini", { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 140, cachedContentTokenCount: 700 } }, { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 700, reasoningTokens: 140 }],
];
for (const [apiFormat, usage, expected] of usageCases) {
  test(`${apiFormat} measures request time and sanitized token usage without recording reasoning`, async t => {
    let now = 0;
    let calls = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.method(globalThis, "fetch", async () => {
      now += ++calls * 15;
      const envelope = decisionEnvelope(apiFormat, calls === 1 ? { invalid: true } : { action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3 });
      return new Response(JSON.stringify({ ...envelope, ...usage, privateField: "private reasoning" }));
    });
    const result = await requestDecision({ apiKey: "secret", baseUrl: "https://fixture.invalid/v1", model: "fixture", apiFormat }, {}, { fastAnalysis: true });
    assert.equal(calls, 2);
    assert.equal(result.action, "BUY");
    assert.deepEqual(result.modelDiagnostics.usage, expected);
    assert.deepEqual(result.modelDiagnostics.attempts.map(a => a.responseDurationMs), [15, 30]);
    assert.deepEqual(result.modelDiagnostics.attempts.map(a => a.usage), [expected, expected]);
    assert.doesNotMatch(JSON.stringify(result.modelDiagnostics), /private|secret/);
  });
}

test("missing or malformed usage is unknown, not fabricated or copied into diagnostics", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ...decisionEnvelope("chat", { action: "HOLD" }), usage: { prompt_tokens: "private", completion_tokens: -2, rawOutput: "private" } })));
  const result = await requestDecision({ apiKey: "secret", baseUrl: "https://fixture.invalid/v1", apiFormat: "chat" }, {});
  assert.equal(result.modelDiagnostics.usage, undefined);
  assert.doesNotMatch(JSON.stringify(result.modelDiagnostics), /private|secret/);
});

test("gateway timing includes endpoint negotiation and reading the full response", async t => {
  let now = 0;
  let calls = 0;
  let finalBytes;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    now += 10;
    if (calls < 3) return new Response('{"message":"unsupported route"}', { status: 404 });
    finalBytes = Buffer.byteLength(options.body);
    const response = new Response(JSON.stringify(decisionEnvelope("chat", { action: "BUY" })));
    const read = response.text.bind(response);
    response.text = async () => { now += 25; return read(); };
    return response;
  });
  const result = await requestDecision({ apiKey: "fixture", baseUrl: "https://fixture.invalid", apiFormat: "responses" }, {});
  assert.equal(result.action, "BUY");
  assert.equal(result.modelDiagnostics.wireApi, "chat");
  assert.equal(result.modelDiagnostics.providerAttempts, 3);
  assert.equal(result.modelDiagnostics.responseDurationMs, 55);
  assert.equal(result.modelDiagnostics.requestBytes, finalBytes);
});
