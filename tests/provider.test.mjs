import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildConversationMessages, createProvider, extractModelText, listProviderModels, normalizeUnitProbability, providerApiKey, providerIdentityKey, providerRequestUrl, publicProvider, requestBrowserActions, requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider } from "../server/provider.mjs";
import { hasDirectionalProbabilities } from "../server/entry-policy.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("all provider formats extract final text without treating reasoning as the decision", () => {
  const final = '{"action":"SELL","bullish_profit_probability":0.3,"bearish_profit_probability":0.6}';
  const reasoning = '{"action":"BUY"}';
  for (const payload of [
    { choices: [{ message: { reasoning_content: reasoning, content: [{ type: "text", text: final.slice(0, 30) }, { type: "text", text: final.slice(30) }] } }] },
    { content: [{ type: "thinking", text: reasoning }, { type: "text", text: final }] },
    { output: [{ type: "reasoning", content: [{ type: "text", text: reasoning }] }, { type: "message", content: [{ type: "output_text", text: final }] }] },
    { candidates: [{ content: { parts: [{ thought: true, text: reasoning }, { text: final }] } }] },
  ]) assert.equal(extractModelText(payload), final);
});

test("GLM complete Chat Completions URLs are not suffixed twice", () => {
  assert.equal(
    providerRequestUrl({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4.5",
      apiFormat: "chat",
    }),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
});

test("OpenAI-compatible wrapped and streaming choices extract model text", () => {
  const final = '{"action":"HOLD"}';
  assert.equal(extractModelText({ data: { choices: [{ delta: { content: final } }] } }), final);
  assert.equal(extractModelText({ choices: [{ text: final }] }), final);
  assert.equal(extractModelText({ choices: [{ message: { content: [{ type: "output_text", content: final }] } }] }), final);
  assert.equal(extractModelText({ response: { output: [{ type: "message", content: [{ type: "output_text", text: final }] }] } }), final);
});

test("action aliases from compatible models do not silently become HOLD", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ action: "buy", bullish_profit_probability: 0.7, bearish_profit_probability: 0.3 }) } }],
  })));
  const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test", model: "compatible-model" }, {}, { fastAnalysis: true });
  assert.equal(result.action, "BUY");
  assert.equal(result.bullishProfitProbability, 0.7);
});

test("GLM live Chat Completions disable dynamic thinking so final content is returned", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.5, bearish_profit_probability: 0.5 }) } }] }));
  });
  const result = await requestDecision({
    apiKey: "test",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    apiFormat: "chat",
    model: "glm-4.5",
  }, {}, { fastAnalysis: true });
  assert.equal(result.action, "HOLD");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 8192);
});

test("GLM-compatible gateway models disable dynamic thinking in live analysis", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.5, bearish_profit_probability: 0.5 }) } }] }));
  });
  const result = await requestDecision({
    apiKey: "test",
    baseUrl: "https://gateway.example.test/v1",
    apiFormat: "chat",
    model: "zai-org/GLM-4.5",
  }, {}, { fastAnalysis: true });
  assert.equal(result.action, "HOLD");
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("GLM models using Anthropic-compatible gateways disable dynamic thinking", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.5, bearish_profit_probability: 0.5 }) }], stop_reason: "end_turn" }));
  });
  const result = await requestDecision({
    apiKey: "test",
    baseUrl: "https://gateway.example.test/v1/messages",
    apiFormat: "anthropic",
    fullUrlMode: true,
    model: "glm-4.5",
  }, {}, { fastAnalysis: true });
  assert.equal(result.action, "HOLD");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 8192);
});

test("reasoning-only live responses are re-asked for a conclusion", async (t) => {
  let calls = 0;
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    calls += 1;
    const payload = calls === 1
      ? { choices: [{ message: { content: "", reasoning_content: "private reasoning" }, finish_reason: "stop" }] }
      : { choices: [{ message: { content: JSON.stringify({ action: "SELL", bullish_profit_probability: 0.2, bearish_profit_probability: 0.7 }) }, finish_reason: "stop" }] };
    return new Response(JSON.stringify(payload));
  });
  const result = await requestDecision({ apiKey: "test-key", baseUrl: "https://provider.example.test", model: "reasoning-model" }, {}, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "SELL");
  assert.equal(result.modelDiagnostics.attempts[0].jsonStatus, "EMPTY_TEXT");
  assert.equal(result.modelDiagnostics.attempts[1].jsonStatus, "COMPLETE_JSON");
  assert.match(bodies[1].messages.at(-1).content, /internal reasoning/);
});

test("nested gateway reasoning-only responses are diagnosed and re-asked", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    const payload = calls === 1
      ? { data: { choices: [{ message: { content: "", reasoning_content: "private reasoning" }, finish_reason: "stop" }] } }
      : { response: { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ action: "BUY", bullish_profit_probability: 0.7, bearish_profit_probability: 0.2 }) }] }] } };
    return new Response(JSON.stringify(payload));
  });
  const result = await requestDecision({ apiKey: "test-key", baseUrl: "https://gateway.example.test", model: "wrapped-reasoning-model" }, {}, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "BUY");
  assert.deepEqual(result.modelDiagnostics.attempts[0].contentTypes, ["reasoning"]);
  assert.equal(result.modelDiagnostics.attempts[0].jsonStatus, "EMPTY_TEXT");
  assert.equal(result.modelDiagnostics.attempts[1].jsonStatus, "COMPLETE_JSON");
});

test("a single complete decision inside prose braces is parsed without repairing malformed JSON", async (t) => {
  const final = { action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3, analysis_summary: 'literal {level} and "quote"' };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: `说明 {非 JSON 注释}\n${JSON.stringify(final)}\n结束` }, finish_reason: "stop" }] })));
  const result = await requestDecision({ apiKey: "secret-test-key", baseUrl: "https://provider.example.test", model: "deepseek-v4-pro" }, {});
  assert.equal(result.action, "BUY");
  assert.equal(result.analysisSummary, final.analysis_summary);
  assert.equal(result.modelDiagnostics.jsonStatus, "COMPLETE_JSON");
  assert.equal(result.modelDiagnostics.contentHash.length, 64);
  assert.doesNotMatch(JSON.stringify(result.modelDiagnostics), /secret-test-key|非 JSON 注释|literal/);
});

test("malformed output keeps failure diagnostics and the following valid decision still works", async (t) => {
  const malformed = '{"action":"BUY","bullish_profit_probability":0.9';
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: calls++ < 2 ? malformed : '{"action":"SELL","bullish_profit_probability":0.3,"bearish_profit_probability":0.6}' }], stop_reason: "end_turn", usage: { input_tokens: 32000, output_tokens: 2500 } })));
  const provider = { apiKey: "secret-test-key", apiFormat: "anthropic", baseUrl: "https://api.stepfun.com/step_plan/v1/messages", fullUrlMode: true, model: "step-5-preview" };
  const failure = await requestDecision(provider, {}, { fastAnalysis: true });
  assert.deepEqual(failure.riskFlags, ["INVALID_MODEL_JSON"]);
  assert.equal(failure.action, "HOLD");
  assert.equal(failure.modelDiagnostics.jsonStatus, "INVALID_JSON");
  assert.equal(failure.modelDiagnostics.stopReason, "end_turn");
  assert.deepEqual(failure.modelDiagnostics.contentTypes, ["thinking", "text"]);
  assert.equal(failure.modelDiagnostics.textLength, malformed.length);
  assert.equal(failure.modelDiagnostics.jsonError, "TRUNCATED_JSON");
  assert.equal(failure.modelDiagnostics.attempts.length, 2);
  assert.doesNotMatch(JSON.stringify(failure.modelDiagnostics), /secret-test-key|private reasoning|bullish_profit_probability/);
  const next = await requestDecision(provider, {}, { fastAnalysis: true });
  assert.equal(next.action, "SELL");
  assert.equal(next.bearishProfitProbability, 0.6);
  assert.equal(calls, 3);
});

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} live analysis gives invalid final text and its error back to the same model once`, async (t) => {
    const malformed = '{"action":"SELL",';
    const bodies = [];
    const envelope = (text) => apiFormat === "anthropic" ? { content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text }], stop_reason: "end_turn" }
      : apiFormat === "responses" ? { output: [{ type: "message", content: [{ type: "output_text", text }] }], status: "completed" }
        : apiFormat === "gemini" ? { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }
          : { choices: [{ message: { content: text }, finish_reason: "stop" }] };
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(envelope(bodies.length === 1 ? malformed : JSON.stringify({ action: "SELL", exit_type: "STOP_LOSS", target_position_ids: ["P-1"], bullish_profit_probability: 0.2, bearish_profit_probability: 0.3 }))));
    });
    const result = await requestDecision({ apiKey: "test-key", baseUrl: "https://provider.example.test", apiFormat, model: "same-model" }, { market: { fingerprint: "same-snapshot" }, experiencePrompt: "approved Skill full text", account: { positions: [{ positionOrderId: "P-1" }] } }, { fastAnalysis: true });
    assert.equal(bodies.length, 2);
    const retry = JSON.stringify(bodies[1]);
    assert.match(retry, /TRUNCATED_JSON/);
    assert.ok(retry.includes(JSON.stringify(malformed)));
    assert.match(retry, /same-snapshot/);
    assert.match(retry, /approved Skill full text/);
    assert.match(retry, /P-1/);
    assert.doesNotMatch(retry, /private reasoning/);
    if (apiFormat !== "gemini") assert.equal(bodies[1].model, "same-model");
    assert.equal(result.action, "SELL");
    assert.deepEqual(result.targetPositionIds, ["P-1"]);
    assert.deepEqual(result.modelDiagnostics.attempts.map(item => item.jsonStatus), ["INVALID_JSON", "COMPLETE_JSON"]);
  });
}

test("live format retry is bounded and preserves an AI HOLD when probabilities are complete", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: calls++ === 0 ? '{"action":' : '{"action":"HOLD","bullish_profit_probability":0.6,"bearish_profit_probability":0.3}' }, finish_reason: "stop" }] })));
  const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {}, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "HOLD");
  assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
});

test("format retry never runs on output exhaustion or after cancellation", async (t) => {
  let calls = 0;
  let abort = false;
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (abort) controller.abort(new Error("USER_LOGOUT"));
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"action":"BUY",' }], stop_reason: abort ? "end_turn" : "max_tokens" }));
  });
  const provider = { apiKey: "test", baseUrl: "https://provider.example.test", apiFormat: "anthropic" };
  const exhausted = await requestDecision(provider, {}, { fastAnalysis: true });
  assert.equal(calls, 1);
  assert.ok(exhausted.riskFlags.includes("MODEL_OUTPUT_LIMIT"));
  abort = true;
  await assert.rejects(requestDecision(provider, {}, { fastAnalysis: true, signal: controller.signal }), /USER_LOGOUT/);
  assert.equal(calls, 2);
});

test("invalid decision shapes and conflicting JSON cannot become a successful HOLD or trade", async (t) => {
  let content;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })));
  for (const [text, error] of [["[]", "NON_OBJECT_JSON"], ['"BUY"', "NON_OBJECT_JSON"], ['{"summary":"no action"}', "INVALID_DECISION_ACTION"], ['{"action":"UNKNOWN"}', "INVALID_DECISION_ACTION"], ['{"action":"BUY"}\n{"action":"SELL"}', "MULTIPLE_JSON_VALUES"], ['{"action":"BUY",}', "INVALID_JSON_SYNTAX"]]) {
    content = text;
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {});
    assert.deepEqual(result.riskFlags, ["INVALID_MODEL_JSON"]);
    assert.equal(result.action, "HOLD");
    assert.equal(result.modelDiagnostics.jsonError, error);
  }
});

test("failed format correction preserves diagnostics and cannot expose or execute the partial plan", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (calls++ > 0) throw new Error("private transport detail");
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"SELL","cancel_order_ids":["O-1"],' }, finish_reason: "stop" }] }));
  });
  const result = await requestDecision({ apiKey: "private-key", baseUrl: "https://provider.example.test" }, {}, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.equal(result.action, "HOLD");
  assert.deepEqual(result.cancelOrderIds, []);
  assert.deepEqual(result.targetPositionIds, []);
  assert.deepEqual(result.riskFlags, ["INVALID_MODEL_JSON"]);
  assert.equal(result.modelDiagnostics.retryError, "REQUEST_FAILED");
  assert.doesNotMatch(JSON.stringify(result.modelDiagnostics), /private|O-1/);
});

test("format correction shares the original timeout rather than starting a new deadline", async (t) => {
  let firstSignal;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (calls++ === 0) {
      firstSignal = options.signal;
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":' }, finish_reason: "stop" }] }));
    }
    // Keep the event loop alive while AbortSignal.timeout uses an unref'ed timer.
    const keepAlive = setInterval(() => {}, 50);
    try {
      await new Promise(resolve => firstSignal.addEventListener("abort", resolve, { once: true }));
      assert.equal(options.signal.aborted, true);
      options.signal.throwIfAborted();
    } finally { clearInterval(keepAlive); }
  });
  await assert.rejects(requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {}, { fastAnalysis: true, timeoutMs: 1000 }), { name: "TimeoutError" });
  assert.equal(calls, 2);
});

function decisionEnvelope(apiFormat, decision) {
  const text = typeof decision === "string" ? decision : JSON.stringify(decision);
  if (apiFormat === "anthropic") return { content: [{ type: "text", text }], stop_reason: "end_turn" };
  if (apiFormat === "responses") return { output: [{ type: "message", content: [{ type: "output_text", text }] }], status: "completed" };
  if (apiFormat === "gemini") return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
  return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} exit-plan repair preserves existing order assessments and supplements omitted orders`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify(decisionEnvelope(apiFormat, calls === 1 ? {
        action: "HOLD",
        order_assessments: [
          { order_id: "O-cancel", decision: "CANCEL", reason: "释放冻结保证金更划算", target_position_ids: ["P-1"] },
          { order_id: "O-keep", decision: "KEEP", reason: "成交机会仍然有利" },
        ],
        cancel_order_ids: ["O-direct"],
      } : {
        action: "HOLD",
        exit_plans: [{ position_id: "P-1", held_side: "LONG", quantity: 1, take_profit_price: 110, stop_loss_price: 95, valid_for_sec: 300 }],
        order_assessments: [
          { order_id: "O-cancel", decision: "KEEP", reason: "格式补全不能改写已有撤单判断" },
          { order_id: "O-direct", decision: "KEEP", reason: "不能覆盖显式撤单ID" },
          { order_id: "O-new", decision: "CANCEL", reason: "补充遗漏委托" },
        ],
        cancel_order_ids: ["O-keep"],
      })));
    });
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test", apiFormat }, {
      executionPolicy: { conditionalExits: true },
      account: { positionsVerified: true, positions: [{ positionOrderId: "P-1", quantity: 1, frozenQuantity: 0 }],
        openOrders: ["O-cancel", "O-keep", "O-direct", "O-new"].map(orderId => ({ orderId, remainingQuantity: 1 })) },
    }, { fastAnalysis: true });
    assert.equal(calls, 2);
    assert.deepEqual(result.orderAssessments.map(item => [item.orderId, item.decision]), [["O-cancel", "CANCEL"], ["O-keep", "KEEP"], ["O-new", "CANCEL"]]);
    assert.deepEqual(result.orderAssessments[0].targetPositionIds, ["P-1"]);
    assert.deepEqual(result.cancelOrderIds, ["O-cancel", "O-direct", "O-new"]);
    assert.deepEqual(result.orderAssessmentMissingIds, []);
    assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
  });
}

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  for (const [action, exitType, missingOrderDecision, frozenQuantity = 0] of [
    ["BUY", null, "KEEP"], ["SELL", null, "CANCEL"],
    ["SELL", "STOP_LOSS", "CANCEL"], ["BUY", "TAKE_PROFIT", "KEEP"],
    ["SELL", "STOP_LOSS", "CANCEL", 1], ["BUY", "TAKE_PROFIT", "KEEP", 1],
  ]) {
    const needsSupplement = !exitType || frozenQuantity > 0;
    test(`${apiFormat} ${needsSupplement ? "supplements one omitted order" : "does not delay an unfrozen exit for omitted orders"} without changing ${action} ${exitType || "entry"}${frozenQuantity ? " with frozen holdings" : ""}`, async (t) => {
      const original = {
        action, exit_type: exitType, target_position_ids: exitType ? ["P-1"] : [], target_symbol: "DGKZ", target_price: 1363,
        bullish_profit_probability: 0.58, bearish_profit_probability: 0.31, profit_probability: 0.58,
        holding_plan: { decision: exitType ? "EXIT_NOW" : "UNKNOWN" },
        exit_plans: exitType ? [{ position_id: "P-1", held_side: action === "SELL" ? "LONG" : "SHORT", quantity: 1, valid_for_sec: 300,
          take_profit_price: exitType === "TAKE_PROFIT" ? 1363 : null, stop_loss_price: exitType === "STOP_LOSS" ? 1363 : null, rationale: "original position plan" }] : [],
        order_assessments: [
          { order_id: "O-keep", decision: "KEEP", reason: "original waiting opportunity" },
          { order_id: "O-cancel", decision: "CANCEL", reason: "original margin decision" },
          { order_id: "O-keep-2", decision: "KEEP", reason: "original fill opportunity" },
        ],
      };
      const supplemental = {
        action: "HOLD", bullish_profit_probability: 0.01, bearish_profit_probability: 0.99,
        target_symbol: "OTHER", order_assessments: [
          { order_id: "O-keep", decision: "CANCEL", reason: "must not rewrite assessed order" },
          { order_id: "O-cancel", decision: "KEEP", reason: "must not undo existing cancellation" },
          { order_id: "O-missing", decision: missingOrderDecision, reason: "compare expected fill and released margin" },
          { order_id: "O-unknown", decision: "CANCEL", reason: "not supplied" },
        ], cancel_order_ids: ["O-unknown", "O-keep"],
      };
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response(JSON.stringify(decisionEnvelope(apiFormat, calls === 1 ? original : supplemental)));
      });
      const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test", apiFormat, model: "same-model" }, {
        executionPolicy: { conditionalExits: true },
        account: { positionsVerified: true, positions: exitType ? [{ positionOrderId: "P-1", quantity: 1, frozenQuantity, side: action === "SELL" ? "买" : "卖", orderPrice: 1400 }] : [],
          openOrders: ["O-keep", "O-cancel", "O-keep-2", "O-missing"].map(orderId => ({ orderId, remainingQuantity: 1 })) },
      }, { fastAnalysis: true });
      assert.equal(calls, needsSupplement ? 2 : 1);
      assert.equal(result.action, action);
      assert.equal(result.exitType, exitType);
      assert.deepEqual(result.targetPositionIds, original.target_position_ids);
      assert.equal(result.targetSymbol, "DGKZ");
      assert.equal(result.targetPrice, 1363);
      assert.equal(result.bullishProfitProbability, 0.58);
      assert.equal(result.bearishProfitProbability, 0.31);
      assert.equal(result.profitProbability, 0.58);
      assert.deepEqual(result.orderAssessments.map(item => [item.orderId, item.decision]), [
        ["O-keep", "KEEP"], ["O-cancel", "CANCEL"], ["O-keep-2", "KEEP"], ...(needsSupplement ? [["O-missing", missingOrderDecision]] : []),
      ]);
      assert.equal(result.orderAssessments[0].reason, "original waiting opportunity");
      assert.deepEqual(result.cancelOrderIds, needsSupplement && missingOrderDecision === "CANCEL" ? ["O-cancel", "O-missing"] : ["O-cancel"]);
      assert.deepEqual(result.orderAssessmentMissingIds, needsSupplement ? [] : ["O-missing"]);
      assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
      if (exitType) {
        assert.equal(result.holdingPlan.decision, "EXIT_NOW");
        assert.equal(result.exitPlans[0].positionId, "P-1");
        assert.equal(result.exitPlans[0].rationale, "original position plan");
      }
    });
  }
}

for (const [failure, exitType] of ["transport", "malformed", "omitted"].flatMap(failure => [null, "STOP_LOSS"].map(exitType => [failure, exitType]))) {
  test(`order supplement ${failure} preserves a complete ${exitType || "entry"} and records only missing order IDs`, async (t) => {
    const original = { action: exitType ? "SELL" : "BUY", exit_type: exitType, target_position_ids: exitType ? ["P-1"] : [],
      bullish_profit_probability: 0.58, bearish_profit_probability: 0.31,
      order_assessments: [{ order_id: "O-keep", decision: "KEEP", reason: "original waiting opportunity" }] };
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 2 && failure === "transport") throw new Error("private transport detail");
      return new Response(JSON.stringify(decisionEnvelope("chat", calls === 1 ? original
        : failure === "malformed" ? '{"action":"HOLD",' : { action: "HOLD", order_assessments: [] })));
    });
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {
      account: { openOrders: [{ orderId: "O-keep" }, { orderId: "O-missing" }] },
    }, { fastAnalysis: true });
    assert.equal(calls, 2);
    assert.equal(result.action, original.action);
    assert.equal(result.exitType, exitType);
    assert.deepEqual(result.targetPositionIds, original.target_position_ids);
    assert.equal(result.bullishProfitProbability, 0.58);
    assert.equal(result.bearishProfitProbability, 0.31);
    assert.deepEqual(result.orderAssessments.map(item => [item.orderId, item.decision]), [["O-keep", "KEEP"]]);
    assert.deepEqual(result.cancelOrderIds, []);
    assert.deepEqual(result.orderAssessmentMissingIds, ["O-missing"]);
    assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
    assert.equal(result.riskFlags.includes("INVALID_MODEL_JSON"), false);
    assert.doesNotMatch(JSON.stringify(result.modelDiagnostics), /private transport detail/);
  });
}

test("complete order assessments keep HOLD and cancellation without an additional model request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify(decisionEnvelope("chat", { action: "HOLD", bullish_profit_probability: 0.48, bearish_profit_probability: 0.35,
      order_assessments: [{ order_id: "O-keep", decision: "KEEP", reason: "waiting still better" }, { order_id: "O-cancel", decision: "CANCEL", reason: "margin release is better" }],
      cancel_order_ids: ["O-cancel-direct"],
    })));
  });
  const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {
    account: { openOrders: ["O-keep", "O-cancel", "O-cancel-direct"].map(orderId => ({ orderId })) },
  }, { fastAnalysis: true });
  assert.equal(calls, 1);
  assert.equal(result.action, "HOLD");
  assert.deepEqual(result.cancelOrderIds, ["O-cancel", "O-cancel-direct"]);
  assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
});

test("order supplement timeout preserves the valid first decision", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(decisionEnvelope("chat", { action: "SELL", bullish_profit_probability: 0.31, bearish_profit_probability: 0.58 })));
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("supplement did not time out")), 2500);
      options.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(options.signal.reason); }, { once: true });
    });
  });
  const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {
    account: { openOrders: [{ orderId: "O-missing" }] },
  }, { fastAnalysis: true, timeoutMs: 1000 });
  assert.equal(calls, 2);
  assert.equal(result.action, "SELL");
  assert.equal(result.bearishProfitProbability, 0.58);
  assert.deepEqual(result.orderAssessmentMissingIds, ["O-missing"]);
  assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
});

test("external cancellation during order supplementation still cancels the entire request", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(decisionEnvelope("chat", { action: "BUY", bullish_profit_probability: 0.58, bearish_profit_probability: 0.31 })));
    controller.abort(new Error("USER_STOPPED_TASK"));
    throw controller.signal.reason;
  });
  await assert.rejects(requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {
    account: { openOrders: [{ orderId: "O-missing" }] },
  }, { fastAnalysis: true, signal: controller.signal }), /USER_STOPPED_TASK/);
  assert.equal(calls, 2);
});

test("conflicting complete outputs and truncated nested JSON never become a trade", async (t) => {
  const buy = JSON.stringify({ action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3 });
  const sell = JSON.stringify({ action: "SELL", bullish_profit_probability: 0.3, bearish_profit_probability: 0.6 });
  let content;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));
  for (content of [`\`\`\`json\n${buy}\n\`\`\`\n${sell}`, `{\"incomplete\":${buy}`, `${buy}\n{\"action\":`]) {
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {});
    assert.equal(result.action, "HOLD");
    assert.deepEqual(result.riskFlags, ["INVALID_MODEL_JSON"]);
  }
  content = `\`\`\`json\n${sell}\n\`\`\``;
  assert.equal((await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {})).action, "SELL");
});

test("AI cancel decisions preserve exact IDs with HOLD and prompt uses net profit/configured quantity", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    assert.match(prompt, /Every round inspect every account.openOrders/);
    assert.match(prompt, /from the current order list only/);
    assert.match(prompt, /Never open, query, scan or operate the historical order list/);
    assert.match(prompt, /Do not label a negative net result TAKE_PROFIT/);
    assert.match(prompt, /User-configured entry quantity: 3/);
    assert.equal(JSON.parse(body.messages.at(-1).content).account.openOrders[0].orderId, "O-1");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.39, bearish_profit_probability: 0.38,
      order_assessments: [{ order_id: "O-1", decision: "CANCEL", reason: "entry price no longer favorable", target_position_ids: ["P-1"] }, { order_id: "O-2", decision: "KEEP" }] }) } }] }));
  });
  const decision = await requestDecision({ apiKey: "test", baseUrl: "https://example.test", model: "fast" }, { account: { openOrders: [{ orderId: "O-1" }] }, strategy: { entryQuantity: 3 } }, { fastAnalysis: true });
  assert.deepEqual(decision.cancelOrderIds, ["O-1"]);
  assert.equal(decision.orderAssessments[1].decision, "KEEP");
  assert.deepEqual(decision.orderAssessments[0].targetPositionIds, ["P-1"]);
  assert.equal(calls, 1);
  assert.deepEqual(buildConversationMessages({ recentRounds: [{ decision }] })[1] && JSON.parse(buildConversationMessages({ recentRounds: [{ decision }] })[1].content).cancelOrderIds, ["O-1"]);
});

test("missing conditional exits are returned to AI and preserve corrected plans or incomplete evidence", async (t) => {
  let calls = 0;
  let correctedPlan = true;
  const response = { action: "HOLD", bullish_profit_probability: 0.3, bearish_profit_probability: 0.2, holding_plan: { decision: "HOLD_FOR_TARGET" } };
  const plan = { position_id: "P-1", held_side: "LONG", quantity: 2, valid_for_sec: 90, take_profit_price: 104, stop_loss_price: 99, rationale: "profit path invalidates below 99" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls += 1;
    if (calls % 2 === 0) {
      assert.match(body.messages.at(-1).content, /every verified unfrozen position requires an exit_plans item/);
      assert.match(body.messages.at(-1).content, /Forecast trend, entry and exit together/);
      assert.match(body.messages.at(-1).content, /不乘数量，不是整仓金额、账户汇总、百分比或K线根数/);
      assert.match(body.messages.at(-1).content, /AI-operated counterparties as a hypothesis supported by price\/order-book evidence/);
      assert.deepEqual(JSON.parse(body.messages.at(-2).content), response);
    } else {
      assert.match(body.messages[0].content, /Report UNKNOWN if evidence is insufficient/);
    }
    const content = calls % 2 === 0 && correctedPlan ? { ...response, exit_plans: [plan] } : response;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  const provider = { apiKey: "test", baseUrl: "https://provider.example.test" };
  const context = { executionPolicy: { conditionalExits: true }, account: { positionsVerified: true, positions: [{ positionOrderId: "P-1", side: "买涨", quantity: 2, orderPrice: 100, frozenQuantity: 0 }] } };
  const corrected = await requestDecision(provider, context, { fastAnalysis: true });
  assert.equal(calls, 2);
  assert.deepEqual(corrected.exitPlans, [{ positionId: "P-1", heldSide: "LONG", quantity: 2, validForSec: 90, takeProfitPrice: 104, stopLossPrice: 99, rationale: plan.rationale }]);
  assert.equal(corrected.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
  correctedPlan = false;
  const incomplete = await requestDecision(provider, context, { fastAnalysis: true });
  assert.equal(calls, 4);
  assert.equal(incomplete.action, "HOLD");
  assert.ok(incomplete.riskFlags.includes("INCOMPLETE_EXIT_PLAN"));
  assert.ok(incomplete.riskFlags.includes("ANALYSIS_INCOMPLETE"));
});

test("live fast analysis disables official DeepSeek thinking without changing the model or custom gateways", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", bullish_profit_probability: 0.52, bearish_profit_probability: 0.2, target_symbol: "DGKZ" }) } }] }));
  });
  for (const baseUrl of ["https://api.deepseek.com", "https://gateway.example.test"]) {
    const decision = await requestDecision({ apiKey: "test", baseUrl, apiFormat: "chat", model: "deepseek-v4-pro" }, { market: { observedAt: "2026-10-09T06:00:00Z" }, evidenceIds: [] }, { fastAnalysis: true });
    assert.equal(decision.action, "BUY");
    assert.equal(decision.bullishProfitProbability, 0.52);
  }
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[1].thinking, undefined);
  assert.equal(bodies[0].model, "deepseek-v4-pro");
  assert.match(bodies[0].messages[0].content, /Latency-critical live decision/);
  assert.equal(bodies.length, 2);
});

test("Step 5 live analysis uses high effort and the model's full output allowance", async (t) => {
  const requests = [];
  const final = { action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3, target_symbol: "SYNTHETIC" };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return new Response(JSON.stringify(body.messages[0].role === "system"
      ? { choices: [{ message: { content: JSON.stringify(final) } }] }
      : { content: [{ type: "thinking", thinking: "synthetic reasoning" }, { type: "text", text: JSON.stringify(final) }], stop_reason: "end_turn" }));
  });
  const provider = { apiKey: "test", model: "step-5-preview", fullUrlMode: true };
  for (const apiFormat of ["chat", "anthropic"]) {
    const baseUrl = `https://api.stepfun.com/step_plan/v1/${apiFormat === "chat" ? "chat/completions" : "messages"}`;
    const result = await requestDecision({ ...provider, baseUrl, apiFormat }, {}, { fastAnalysis: true });
    assert.equal(result.action, "BUY");
    assert.equal(result.bullishProfitProbability, 0.6);
  }
  assert.equal(requests[0].reasoning_effort, "high");
  assert.deepEqual(requests[1].output_config, { effort: "high" });
  assert.equal(requests[0].max_tokens, 65536);
  assert.equal(requests[1].max_tokens, 65536);
  await requestDecision({ ...provider, baseUrl: "https://api.stepfun.com/step_plan/v1/messages", apiFormat: "anthropic" }, {}, { fastAnalysis: true, maxOutputTokens: 6000 });
  assert.equal(requests[2].max_tokens, 6000);
  for (const baseUrl of ["https://api.stepfun.com/step_plan/v1/messages", "https://gateway.example.test/messages"]) {
    await requestDecision({ ...provider, baseUrl, apiFormat: "anthropic" }, {}, { fastAnalysis: baseUrl.includes("gateway") });
    assert.equal(requests.at(-1).output_config, undefined);
    assert.equal(requests.at(-1).max_tokens, 4096);
  }
});

test("Step 5 output overrides above 8192 survive both APIs and respect the model limit", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ action: "BUY", bullish_profit_probability: 0.6, bearish_profit_probability: 0.3 }) }], stop_reason: "end_turn" }));
  });
  for (const apiFormat of ["chat", "anthropic"]) {
    const provider = { apiKey: "test", model: "step-5-preview", fullUrlMode: true, apiFormat,
      baseUrl: `https://api.stepfun.com/step_plan/v1/${apiFormat === "chat" ? "chat/completions" : "messages"}` };
    for (const [maxOutputTokens, expected] of [[32768, 32768], [100000, 65536], [-1, 1]]) {
      await requestDecision(provider, {}, { fastAnalysis: true, maxOutputTokens });
      assert.equal(requests.at(-1).max_tokens, expected);
    }
  }
});

test("thinking-only token exhaustion reports the failure instead of presenting it as an AI HOLD", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    content: [{ type: "thinking", thinking: '{"action":"BUY"}' }],
    stop_reason: "max_tokens", usage: { output_tokens: 4096 },
  })));
  const result = await requestDecision({ apiKey: "test", baseUrl: "https://api.stepfun.com/step_plan/v1/messages", apiFormat: "anthropic", fullUrlMode: true, model: "step-5-preview" }, {});
  assert.equal(result.action, "HOLD");
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.riskFlags, ["EMPTY_MODEL_RESPONSE", "MODEL_OUTPUT_LIMIT"]);
  assert.match(result.invalidation, /输出额度上限/);
});

test("provider verification performs a real inference with the configured model", async () => {
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer provider-secret");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).model, "arbitrary-model-id");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Local", model: "arbitrary-model-id", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "provider-secret" });
    const result = await verifyProvider(provider);
    assert.equal(result.ok, true);
    assert.equal(result.status, "模型可用");
    assert.equal(publicProvider(provider).keyPreview, "pro***ret");
    assert.equal("encryptedKey" in publicProvider(provider), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider verification rejects an HTTP-success response without conclusion text", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "private reasoning" } }] }));
  });
  const result = await verifyProvider({ apiKey: "provider-secret", baseUrl: "https://gateway.example.test/v1", model: "glm-4.5", apiFormat: "chat" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "EMPTY_MODEL_RESPONSE");
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("provider configuration rejects non-http endpoints", () => {
  assert.throws(() => createProvider({ baseUrl: "javascript:alert(1)", model: "demo" }), /PROVIDER_URL_INVALID/);
});

test("desktop users can create an owned provider and keep the wire format", () => {
  const provider = createProvider({
    name: "我的网关",
    baseUrl: "https://gateway.example.test",
    model: "your-model",
    apiKey: "sk-user-owned",
    apiFormat: "openai_responses",
  });
  provider.ownerUserId = "user_desktop_1";
  const published = publicProvider(provider, "user_desktop_1");
  assert.equal(published.configured, true);
  assert.equal(published.owned, true);
  assert.equal(published.apiFormat, "responses");
  assert.equal("encryptedKey" in published, false);
  assert.equal("apiKey" in published, false);
});

test("editing a provider keeps its encrypted key when the key is omitted", () => {
  const provider = createProvider({ name: "Old", baseUrl: "https://gateway.example.test/v1", model: "first-model", apiKey: "stored-secret" });
  const edited = createProvider({ id: provider.id, name: "New", model: "any-new-model" }, provider);
  assert.equal(providerApiKey(edited), "stored-secret");
  assert.equal(edited.name, "New");
  assert.equal(edited.model, "any-new-model");
  assert.deepEqual(edited.models, ["any-new-model", "first-model"]);
});

test("model discovery accepts OpenAI and Gemini model list shapes", async () => {
  let shape = "openai";
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.setHeader("content-type", "application/json");
    response.end(shape === "openai"
      ? JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "custom/model" }] })
      : JSON.stringify({ models: [{ name: "models/gemini-custom" }] }));
  });
  const port = await listen(server);
  try {
    const openai = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "manual-model", apiKey: "key", apiFormat: "chat" });
    assert.deepEqual((await listProviderModels(openai)).models, ["deepseek-flash", "custom/model"]);
    shape = "gemini";
    const gemini = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, modelsUrl: `http://127.0.0.1:${port}/v1/models`, model: "gemini-custom", apiKey: "key", apiFormat: "gemini" });
    assert.deepEqual((await listProviderModels(gemini)).models, ["gemini-custom"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("root model-list URL resolves to /models without forcing /v1", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/models");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "gpt-6-astra" }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}`, modelsUrl: `http://127.0.0.1:${port}`, model: "gpt-6-astra", apiKey: "key", apiFormat: "responses" });
    assert.deepEqual((await listProviderModels(provider)).models, ["gpt-6-astra"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("verification rejects a missing configured model even if model listing works", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") return response.end(JSON.stringify({ data: [{ id: "real-model" }] }));
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: { message: "model fake-model not found" } }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-model", apiKey: "key", apiFormat: "chat" });
    assert.deepEqual((await listProviderModels(provider)).models, ["real-model"]);
    const result = await verifyProvider(provider);
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVIDER_ENDPOINT_OR_MODEL_NOT_FOUND");
    assert.equal(result.status, "接口或模型不存在");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("protocol adapters and full URL mode preserve arbitrary endpoints", () => {
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com", model: "m", apiFormat: "chat" }), "https://api.example.com/chat/completions");
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com/v1", model: "m", apiFormat: "anthropic" }), "https://api.example.com/v1/messages");
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com", model: "gemini/custom", apiFormat: "gemini" }), "https://api.example.com/v1beta/models/gemini%2Fcustom:generateContent");
  assert.equal(providerRequestUrl({ baseUrl: "https://custom.example.test/infer?mode=fast", model: "m", apiFormat: "chat", fullUrlMode: true }), "https://custom.example.test/infer?mode=fast");
  assert.equal(providerRequestUrl({ baseUrl: "https://custom.example.test", model: "m", apiFormat: "chat", fullUrlMode: true }), "https://custom.example.test/chat/completions");
  assert.equal(providerRequestUrl({ baseUrl: "https://custom.example.test/v1", model: "m", apiFormat: "responses", fullUrlMode: true }), "https://custom.example.test/v1/responses");
});

test("Anthropic and Gemini adapters send their native authentication and payloads", async () => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/messages") {
      response.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ action: "BUY", confidence: 0.6 }) }] }));
      return;
    }
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ action: "SELL", confidence: 0.7 }) }] } }] }));
  });
  const port = await listen(server);
  try {
    const anthropic = createProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "claude-custom", apiKey: "anthropic-key", apiFormat: "anthropic" });
    const gemini = createProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "gemini-custom", apiKey: "gemini-key", apiFormat: "gemini" });
    assert.equal((await requestDecision(anthropic, { evidenceIds: [] })).action, "BUY");
    assert.equal((await requestDecision(gemini, { evidenceIds: [] })).action, "SELL");
    assert.equal(seen[0].headers["x-api-key"], "anthropic-key");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0].body.model, "claude-custom");
    assert.ok(seen[0].body.system);
    const prompt = seen[0].body.system;
    assert.match(prompt, /40% 不再是入场硬门、上限或 HOLD 触发器/);
    assert.doesNotMatch(prompt, /selected probability must be >=|hard entry requirement|BUY requires bullish_profit_probability >=/);
    assert.match(prompt, /AI recognizes the broad market trend first/);
    assert.match(prompt, /历史 trend 字段、已完成 K 线和片段 trend 只是过去的证据，不是下单条件/);
    assert.match(prompt, /入场依据是从当前可成交价出发对未来路径的预测/);
    assert.match(prompt, /预测亏损将继续扩大、恢复路径失效或继续持有的预期损失更大/);
    assert.match(prompt, /BUY means long\/up: profit when price rises; SELL means short\/down: profit when price falls/);
    assert.match(prompt, /趋势内回撤/);
    assert.match(prompt, /Next K and roughly 10 K are forecast checkpoints, not holding limits/);
    assert.match(prompt, /5根只是举例，不设固定持仓K数/);
    assert.match(prompt, /max_hold_k\/max_hold_minutes are forecasts, not host timers/);
    assert.match(prompt, /收益与风险必须一起预测/);
    assert.match(prompt, /亏损也是预测对象/);
    assert.match(prompt, /预测未来路径可能持续亏损或扩亏时/);
    assert.match(prompt, /多空统一按每单位有利价格点差设定2～4点目标/);
    assert.match(prompt, /达到至少2点且已知费用后非负就立即EXIT_NOW\/TAKE_PROFIT/);
    assert.match(prompt, /4点为硬上限/);
    assert.match(prompt, /费用未知按用户点差边界执行，净利润保持未知/);
    assert.doesNotMatch(prompt, /Close with TAKE_PROFIT when actual executable net gain reaches|when realized executable net gain meets the reasonable target|由AI选择离场时机/);
    assert.match(prompt, /预期未来盈利不等于当前已盈利/);
    assert.match(prompt, /连续多轮仍为-1点不是继续扩大/);
    assert.doesNotMatch(prompt, /只要 AI 预测未来约 2–5 根 K|TAKE_PROFIT only when exiting now is forecast to maximize|or further loss expansion is forecast/);
    assert.match(prompt, /亏1个点不是自动止损信号/);
    assert.match(prompt, /损失在持续扩大、继续持有更可能恶化而非恢复/);
    assert.match(prompt, /previousAnalysis\.decision\.positionAudit\.positions/);
    assert.match(prompt, /LONG: bid minus entry; SHORT: entry minus ask/);
    assert.match(prompt, /-1点变-3点是扩大，-3点变-1点是收窄/);
    assert.match(prompt, /下一根及 1–5 根 K 只用于择时/);
    assert.doesNotMatch(prompt, /minimum expected loss only when the profitable path is invalidated|Profit targets and planned exits must stay within the next 5 K/);
    assert.match(prompt, /User-configured entry quantity: 1 per new order/);
    assert.match(prompt, /TAKE_PROFIT requires at least 2 favorable executable price points and nonnegative net PnL/);
    assert.match(prompt, /STOP_LOSS requires evidence-based adverse-path and recovery analysis/);
    assert.match(prompt, /Both manual-entry and auto-entry modes automate exits/);
    assert.match(prompt, /Price response outranks static displayed depth/);
    assert.match(prompt, /correct persistent directional bias/);
    assert.match(prompt, /Report UNKNOWN if evidence is insufficient/);
    assert.match(prompt, /invalidation field is one structural price/);
    assert.match(prompt, /趋势方向与当前入场时机分别判断/);
    assert.doesNotMatch(prompt, /下次可行动条件/);
    assert.doesNotMatch(prompt, /数据过期或风险超限时失效/);
    assert.equal(seen[1].headers["x-goog-api-key"], "gemini-key");
    assert.equal(seen[1].url, "/v1beta/models/gemini-custom:generateContent");
    assert.ok(seen[1].body.systemInstruction);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("below 40% HOLD is preserved without a second AI request even when probabilities are close", async (t) => {
  let calls = 0;
  let bullish = 0;
  let bearish = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: bullish, bearish_profit_probability: bearish }) } }] }));
  });
  for (const [longProbability, shortProbability] of [[0.39, 0.38], [0.21, 0.2], [0.399999, 0.39]]) {
    bullish = longProbability;
    bearish = shortProbability;
    const before = calls;
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test", model: "demo", apiFormat: "chat" }, { account: { positions: [] } });
    assert.equal(result.action, "HOLD");
    assert.equal(result.invalidation, "");
    assert.equal(result.bullishProfitProbability, bullish);
    assert.equal(result.bearishProfitProbability, bearish);
    assert.equal(result.riskFlags.includes("INCONSISTENT_ACTION_PROBABILITY"), false);
    assert.equal(calls, before + 1);
  }
});

for (const [bullish, bearish, selectedAction] of [[0.44, 0.42, "SELL"], [0.48, 0.51, "BUY"], [0.51, 0.48, "SELL"]]) {
  test(`probability proximity does not override AI-selected ${selectedAction} at ${bullish}/${bearish}`, async () => {
    let calls = 0;
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {}
      calls += 1;
      const decision = { action: selectedAction, bullish_profit_probability: bullish, bearish_profit_probability: bearish };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
    });
    const port = await listen(server);
    try {
      const result = await requestDecision(createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" }), {});
      assert.equal(calls, 1);
      assert.equal(result.action, selectedAction);
      assert.equal(result.bullishProfitProbability, bullish);
      assert.equal(result.bearishProfitProbability, bearish);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("missing probabilities do not force a below-threshold HOLD into an entry", async () => {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    calls += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.03 }) } }] }));
  });
  const port = await listen(server);
  try {
    const result = await requestDecision(createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" }), {});
    assert.equal(calls, 1);
    assert.equal(result.action, "HOLD");
    assert.equal(hasDirectionalProbabilities(result), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
  test(`${exitType} with HOLD is corrected by AI even below entry thresholds`, async () => {
    let calls = 0;
    const requests = [];
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      calls += 1;
      const decision = { action: calls === 1 ? "HOLD" : "SELL", exit_type: exitType, target_position_ids: ["P-risk"], bullish_profit_probability: 0.2, bearish_profit_probability: 0.2 };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
    });
    const port = await listen(server);
    try {
      const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
      const result = await requestDecision(provider, { account: { positions: [{ side: "买", quantity: 1, positionOrderId: "P-risk" }] } });
      assert.equal(calls, 2);
      assert.equal(result.action, "SELL");
      assert.equal(result.exitType, exitType);
      assert.deepEqual(result.targetPositionIds, ["P-risk"]);
      assert.match(requests[1].messages.at(-1).content, /TAKE_PROFIT requires >=2 favorable executable points/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("AI EXIT_NOW缺少可执行离场动作时交还AI补全，不作为新入场执行", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    if (calls === 2) {
      assert.match(payload.messages.at(-1).content, /EXIT_NOW/);
      assert.match(payload.messages.at(-1).content, /亏1个点不是自动止损信号/);
      assert.doesNotMatch(payload.messages.at(-1).content, /minimum expected loss only when the profitable path is invalidated/);
    }
    const result = calls === 1
      ? { action: "BUY", bullish_profit_probability: 0.6, holding_plan: { decision: "EXIT_NOW" } }
      : { action: "SELL", exit_type: "STOP_LOSS", target_position_ids: ["P-1"], holding_plan: { decision: "EXIT_NOW" } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  const result = await requestDecision(createProvider({ apiKey: "test", baseUrl: "https://provider.example.test", model: "demo" }), { account: { positions: [{ positionOrderId: "P-1", side: "买", quantity: 1 }] } });
  assert.equal(calls, 2);
  assert.equal(result.action, "SELL");
  assert.equal(result.exitType, "STOP_LOSS");
});

test("AI未补全EXIT_NOW时保留未完成证据，不把离场误作入场", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", bullish_profit_probability: 0.6, holding_plan: { decision: "EXIT_NOW" } }) } }] }));
  });
  const result = await requestDecision(createProvider({ apiKey: "test", baseUrl: "https://provider.example.test", model: "demo" }), { account: { positions: [{ positionOrderId: "P-1", side: "买", quantity: 1 }] } });
  assert.equal(calls, 2);
  assert.equal(result.action, "HOLD");
  assert.equal(result.bullishProfitProbability, 0.6);
  assert.ok(result.riskFlags.includes("INCOMPLETE_EXIT_PLAN"));
  assert.ok(result.riskFlags.includes("ANALYSIS_INCOMPLETE"));
});

test("owned providers with the same name, model and URL share an identity", () => {
  const first = { ownerUserId: "user_1", name: "gateway", model: "your-model", baseUrl: "https://gateway.example.test/" };
  const second = { ownerUserId: "user_1", name: "Gateway", model: "your-model", baseUrl: "https://gateway.example.test" };
  assert.equal(providerIdentityKey(first), providerIdentityKey(second));
  assert.notEqual(providerIdentityKey(first), providerIdentityKey({ ...second, ownerUserId: "user_2" }));
  assert.equal(publicProvider({ ...first, encryptedKey: "x" }, "user_1").owned, true);
  assert.equal(publicProvider({ ...first, encryptedKey: "x" }, "user_2").owned, false);
  assert.equal(publicProvider({ ...first, encryptedKey: "x" }).owned, false);
});

test("provider decision receives bounded evidence context", async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", evidence_ids: ["evidence:one"] }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Local", model: "demo", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "provider-secret" });
    const result = await requestDecision(provider, {
      market: { trend: "range" },
      account: { exposurePct: 0 },
      rules: [],
      evidence: [{ evidenceId: "evidence:one", excerpt: "EMA20 slope is flat" }],
      evidenceIds: ["evidence:one"],
    });
    assert.equal(result.action, "HOLD");
    assert.ok(received.messages.at(-1).content.includes("EMA20 slope is flat"));
    assert.match(received.messages[0].content, /counterparty may be AI-controlled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [bullish, bearish, selectedAction, management] of [
  [0.48, 0.35, "BUY", "CANCEL"],
  [0.4, 0.35, "BUY", "KEEP"],
  [0.35, 0.4, "SELL", "CANCEL_IDS"],
  [0.44, 0.35, "BUY", "CANCEL"],
  [0.35, 0.41, "SELL", "KEEP"],
  [0.48, 0.53, "BUY", "KEEP"],
]) {
  test(`AI HOLD ${bullish}/${bearish} with ${management} is preserved without a probability threshold`, async (t) => {
    const bodies = [];
    const original = { action: "HOLD", bullish_profit_probability: bullish, bearish_profit_probability: bearish,
      holding_plan: { decision: "HOLD_FOR_TARGET", rationale: "existing position can continue holding" },
      ...(management === "CANCEL_IDS" ? { cancel_order_ids: ["O-1"] }
        : { order_assessments: [{ order_id: "O-1", decision: management, reason: "independent existing-order assessment", target_position_ids: ["P-1"] }] }) };
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(original) } }] }));
    });
    const context = { experiencePrompt: "Source research recommends waiting for extra confirmation.",
      account: { positions: [{ positionOrderId: "P-1", quantity: 1 }], openOrders: [{ orderId: "O-1", instrumentId: "OTHER" }] } };
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, context, { fastAnalysis: true });
    assert.equal(bodies.length, 1);
    const messages = bodies[0].messages;
    assert.match(messages[0].content, /40% 不再是入场硬门/);
    assert.match(messages[0].content, /AI recognizes the broad market trend first/);
    assert.equal(result.action, "HOLD");
    assert.equal(result.exitType, null);
    assert.equal(result.bullishProfitProbability, bullish);
    assert.equal(result.bearishProfitProbability, bearish);
    assert.equal(result.profitProbability, 0);
    assert.equal(result.holdingPlan.decision, "HOLD_FOR_TARGET");
    if (management === "CANCEL_IDS") assert.deepEqual(result.cancelOrderIds, ["O-1"]);
    else {
      assert.equal(result.orderAssessments[0].orderId, "O-1");
      assert.equal(result.orderAssessments[0].decision, management);
      assert.deepEqual(result.orderAssessments[0].targetPositionIds, ["P-1"]);
    }
    assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
  });
}

test("unchanged HOLD with order assessments preserves probabilities and never fabricates an order", async (t) => {
  let calls = 0;
  const original = { action: "HOLD", bullish_profit_probability: 0.48, bearish_profit_probability: 0.35,
    order_assessments: [{ order_id: "O-1", decision: "KEEP" }] };
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(original) } }] }));
  });
  for (const _round of [1, 2]) {
    const before = calls;
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test" }, {}, { fastAnalysis: true });
    assert.equal(calls, before + 1);
    assert.equal(result.action, "HOLD");
    assert.equal(result.bullishProfitProbability, 0.48);
    assert.equal(result.bearishProfitProbability, 0.35);
    assert.equal(result.orderAssessments[0].decision, "KEEP");
    assert.equal(result.riskFlags.includes("ANALYSIS_INCOMPLETE"), false);
    assert.equal(result.riskFlags.includes("INCONSISTENT_ACTION_PROBABILITY"), false);
  }
});

test("HOLD above 40% remains an AI decision and is not forced into an entry", async () => {
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls += 1;
    const messages = JSON.parse(body).messages;
    response.setHeader("content-type", "application/json");
    const decision = { action: "HOLD", bullish_profit_probability: 0.41, bearish_profit_probability: 0.53, profit_probability: 0.53 };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
    const first = await requestDecision(provider, { account: { positions: [] } });
    assert.equal(first.action, "HOLD");
    assert.equal(first.bearishProfitProbability, 0.53);
    assert.equal(calls, 1);
    const holding = await requestDecision(provider, { account: { positions: [{ quantity: 1, side: "买" }] } });
    assert.equal(holding.action, "HOLD");
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider decision sends approved experience as a separate analysis prompt", async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD" }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
    await requestDecision(provider, { evidenceIds: ["evidence:skill:one:v1"], experiencePrompt: "标题：盘口回撤经验\n原文：放量突破后观察回撤" });
    const promptMessage = received.messages.find((message) => message.content.includes("标题：盘口回撤经验"));
    assert.ok(promptMessage);
    assert.match(promptMessage.content, /共享知识库中已审核发布的 Skill/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider browser control returns visible click actions", async () => {
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.match(payload.messages[0].content, /built-in browser/);
    assert.match(payload.messages[0].content, /Never open, query, scan or operate 历史委托/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ goal: "ENTRY_BUY_UP", actions: [{ type: "click", label: "买入订立" }] }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
    const result = await requestBrowserActions(provider, { goal: "ENTRY_BUY_UP", controls: { buttons: [{ label: "买入订立" }] } });
    assert.equal(result.ok, true);
    assert.equal(result.actions[0].label, "买入订立");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("normalizeUnitProbability accepts 0.45, 45 and 45%", () => {
  assert.equal(normalizeUnitProbability(0.45), 0.45);
  assert.equal(normalizeUnitProbability(45), 0.45);
  assert.equal(normalizeUnitProbability("45%"), 0.45);
  assert.equal(normalizeUnitProbability("45％"), 0.45);
  assert.equal(normalizeUnitProbability("0.52"), 0.52);
});

test("provider decision never derives profit probability from confidence", async () => {
  const server = http.createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", confidence: 0.92 }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
    const result = await requestDecision(provider, { evidenceIds: [] });
    assert.equal(result.profitProbability, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider decision preserves target board identity and per-board assessments", async () => {
  const server = http.createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      action: "BUY",
      target_symbol: "DGKZ",
      target_symbol_name: "丹桂康砖（二期）",
      target_instrument_id: "537",
      confidence: 0.75,
      profit_probability: "52%",
      bullish_profit_probability: 52,
      bearish_profit_probability: "0.41",
      board_assessments: [
        { symbol: "DGJJ", symbol_name: "丹桂金尖（二期）", instrument_id: "536", action: "HOLD", confidence: 0.4, summary: "等待" },
        { symbol: "DGKZ", symbol_name: "丹桂康砖（二期）", instrument_id: "537", action: "BUY", confidence: 0.75, summary: "满足条件" },
      ],
    }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "board-model", apiKey: "key" });
    const result = await requestDecision(provider, { market: { books: [] }, evidenceIds: [] });
    assert.equal(result.targetSymbol, "DGKZ");
    assert.equal(result.targetInstrumentId, "537");
    assert.equal(result.profitProbability, 0.52);
    assert.equal(result.bullishProfitProbability, 0.52);
    assert.equal(result.bearishProfitProbability, 0.41);
    assert.equal(result.boardAssessments.length, 2);
    assert.equal(result.boardAssessments[0].action, "HOLD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider decision preserves next-K, ten-K and AI holding-duration forecasts", async () => {
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.match(payload.messages[0].content, /holding_plan/);
    assert.match(payload.messages[0].content, /max_hold_k/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      action: "HOLD",
      bullish_profit_probability: 0.39,
      bearish_profit_probability: 0.31,
      forecast_horizon: {
        next_k: { direction: "DOWN", probability: "42%", expected_move_pct: "-0.8", path: "先回撤", invalidation: "跌破支撑" },
        next_10k: { direction: "UP", probability: 0.67, expected_move_pct: 2.1, path: "回撤后反弹", invalidation: "失守长期支撑" },
      },
      holding_plan: { decision: "HOLD_THROUGH_PULLBACK", max_hold_k: 10, max_hold_minutes: 10, rationale: "多K恢复路径更优", invalidation: "多周期转弱" },
    }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "forecast-model", apiKey: "key" });
    const result = await requestDecision(provider, { evidenceIds: [] });
    assert.equal(result.forecastHorizon.nextK.direction, "DOWN");
    assert.equal(result.forecastHorizon.nextK.probability, 0.42);
    assert.equal(result.forecastHorizon.next10K.direction, "UP");
    assert.equal(result.forecastHorizon.next10K.probability, 0.67);
    assert.equal(result.holdingPlan.decision, "HOLD_THROUGH_PULLBACK");
    assert.equal(result.holdingPlan.maxHoldK, 10);
    assert.equal(result.holdingPlan.maxHoldMinutes, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("monitoring history preserves each position's trend exit plan and closing decision", () => {
  const plan = { positionId: "P-long", heldSide: "LONG", quantity: 1, validForSec: 1800, takeProfitPrice: 112, stopLossPrice: 94, rationale: "大趋势向上，96-99 为预期回撤，94 为结构失效" };
  const messages = buildConversationMessages({ conversation: { recentRounds: [
    { round: 1, decision: { action: "HOLD", holdingPlan: { decision: "HOLD_THROUGH_PULLBACK", maxHoldK: 18, rationale: "小时趋势向上，下一K回撤不改变盈利路径", invalidation: "大趋势结构失效" }, exitPlans: [plan] } },
    { round: 2, decision: { action: "SELL", exit_type: "STOP_LOSS", target_position_ids: ["P-long"], exit_plans: [{ position_id: "P-long", held_side: "LONG", quantity: 1, valid_for_sec: 60, take_profit_price: null, stop_loss_price: 94, rationale: "实际跌破原趋势失效边界" }] } },
  ] } });
  const held = JSON.parse(messages[1].content);
  assert.deepEqual(held.exitPlans, [plan]);
  assert.equal(held.holdingPlan.maxHoldK, 18);
  const closed = JSON.parse(messages[3].content);
  assert.equal(closed.exitType, "STOP_LOSS");
  assert.deepEqual(closed.targetPositionIds, ["P-long"]);
  assert.equal(closed.exitPlans[0].stopLossPrice, 94);
});

for (const apiFormat of ["chat", "responses", "anthropic", "gemini"]) {
  test(`${apiFormat} fast decisions receive broad-trend guidance, flash-price exclusions and prior exit plans`, async t => {
    const bodies = [];
    const plan = { positionId: "P-long", heldSide: "LONG", quantity: 1, validForSec: 1800, takeProfitPrice: 112, stopLossPrice: 94, rationale: "大趋势向上，96-99 回撤不失效" };
    const previousPosition = { positionId: "P-long", side: "LONG", quantity: 1, entryPrice: 100, exitQuotePrice: 97, exitQuotePnlPoints: -3, lastObservedAt: "2026-10-15T06:00:00Z" };
    const currentPosition = { ...previousPosition, exitQuotePrice: 99, exitQuotePnlPoints: -1, lastObservedAt: "2026-10-15T06:01:00Z" };
    const final = JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.61, bearish_profit_probability: 0.24,
      forecast_horizon: { next_k: { direction: "DOWN" }, next_10k: { direction: "UP" } },
      holding_plan: { decision: "HOLD_THROUGH_PULLBACK", max_hold_k: 18, rationale: "大趋势延续" }, exit_plans: [plan] });
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const payload = apiFormat === "anthropic" ? { content: [{ type: "text", text: final }] }
        : apiFormat === "responses" ? { output_text: final }
          : apiFormat === "gemini" ? { candidates: [{ content: { parts: [{ text: final }] } }] }
            : { choices: [{ message: { content: final } }] };
      return new Response(JSON.stringify(payload));
    });
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test/v1", model: "compatible-model", apiFormat }, {
      account: { positionContext: [currentPosition] },
      previousAnalysis: { decision: { positionAudit: { observedAt: previousPosition.lastObservedAt, positionsVerified: true, positions: [previousPosition] } }, exitPlans: [{ ...plan, status: "ARMED", expiresAt: "2026-10-15T07:00:00Z" }] },
      conversation: { recentRounds: [{ decision: { action: "HOLD", exitPlans: [plan] } }] },
    }, { fastAnalysis: true });
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    const messages = body.input || body.messages || body.contents.map(item => ({ ...item, content: item.parts[0].text }));
    const prompt = body.system || body.systemInstruction?.parts[0].text || messages.filter(item => item.role === "system").map(item => item.content).join("\n");
    assert.match(prompt, /AI recognizes the broad market trend first/);
    assert.match(prompt, /Next K and roughly 10 K are forecast checkpoints, not holding limits/);
    assert.match(prompt, /5根只是举例，不设固定持仓K数/);
    assert.match(prompt, /max_hold_k\/max_hold_minutes are forecasts, not host timers/);
    assert.doesNotMatch(prompt, /minimum expected loss only when the profitable path is invalidated|Profit targets and planned exits must stay within the next 5 K/);
    assert.match(prompt, /exclude its price and derived high\/low\/return/);
    assert.match(prompt, /fresh executable bid\/ask as a separate execution fact/);
    assert.match(prompt, /not an ordinary next-K pullback or suspect flash price/);
    assert.match(prompt, /收益与风险必须一起预测/);
    assert.match(prompt, /多空统一按每单位有利价格点差设定2～4点目标/);
    assert.match(prompt, /达到至少2点且已知费用后非负就立即EXIT_NOW\/TAKE_PROFIT/);
    assert.match(prompt, /4点为硬上限/);
    assert.match(prompt, /费用未知按用户点差边界执行，净利润保持未知/);
    assert.doesNotMatch(prompt, /Close with TAKE_PROFIT when actual executable net gain reaches|when realized executable net gain meets the reasonable target|由AI选择离场时机/);
    assert.match(prompt, /预期未来盈利不等于当前已盈利/);
    assert.match(prompt, /连续多轮仍为-1点不是继续扩大/);
    assert.doesNotMatch(prompt, /只要 AI 预测未来约 2–5 根 K|TAKE_PROFIT only when exiting now is forecast to maximize|or further loss expansion is forecast/);
    assert.match(prompt, /亏1个点不是自动止损信号/);
    assert.match(prompt, /previousAnalysis\.decision\.positionAudit\.positions/);
    assert.match(prompt, /LONG: bid minus entry; SHORT: entry minus ask/);
    assert.match(prompt, /Lead with broad trend/);
    assert.doesNotMatch(prompt, /target 1-5 K when trend remains valid|favorable exit over the next 1-5 K/);
    const context = JSON.parse(messages.at(-1).content);
    assert.equal(context.previousAnalysis.exitPlans[0].rationale, plan.rationale);
    assert.equal(context.previousAnalysis.exitPlans[0].status, "ARMED");
    assert.deepEqual(context.previousAnalysis.decision.positionAudit.positions, [previousPosition]);
    assert.deepEqual(context.account.positionContext, [currentPosition]);
    const history = messages.find(item => ["assistant", "model"].includes(item.role));
    assert.deepEqual(JSON.parse(history.content).exitPlans, [plan]);
    assert.equal(result.holdingPlan.maxHoldK, 18);
    assert.equal(result.forecastHorizon.nextK.direction, "DOWN");
    assert.equal(result.forecastHorizon.next10K.direction, "UP");
    assert.equal(result.action, "HOLD");
    assert.equal(result.bullishProfitProbability, 0.61);
  });
}

test("continuous monitoring sends prior rounds as bounded conversation context", async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "BUY", confidence: 0.7 }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Local", model: "demo", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "provider-secret" });
    const context = {
      market: { trend: "up" },
      evidenceIds: [],
      conversation: {
        round: 3,
        trigger: "controller",
        recentRounds: [
          { round: 1, route: "SUGGESTION_PENDING", market: { symbol: "DGKZ", trend: "range", fingerprint: "a" }, decision: { action: "HOLD", confidence: 0.4 } },
          { round: 2, route: "SUGGESTION_PENDING", market: { symbol: "DGKZ", trend: "up", fingerprint: "b" }, decision: { action: "BUY", confidence: 0.6 } },
        ],
      },
    };
    assert.equal(buildConversationMessages(context).length, 4);
    const result = await requestDecision(provider, context);
    assert.equal(result.action, "BUY");
    assert.equal(received.messages.filter((message) => message.role === "assistant").length, 2);
    assert.match(received.messages.at(-1).content, /"round":3/);
    assert.match(received.messages[1].content, /prior_monitoring_round/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider reviews a complete market segment and binds the returned review to its hash", async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segment_summary: "片段趋势向上，末端量能增加", trend: "up", bullish_evidence: ["高点抬升"], confidence: 0.75 }) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Local", model: "demo", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "provider-secret" });
    const segment = { segmentId: "segment:test:kline:15m:0", kind: "kline", timeframe: "15m", rowCount: 2, contentHash: "hash-1", rows: [[1, 100], [2, 101]] };
    const result = await requestSegmentReview(provider, segment, { symbol: "DGKZ" });
    assert.equal(result.ok, true);
    assert.equal(result.segmentId, segment.segmentId);
    assert.equal(result.contentHash, segment.contentHash);
    assert.equal(result.rowCount, segment.rowCount);
    assert.equal(received.messages[0].role, "system");
    assert.match(received.messages[0].content, /First assess broad multi-bar trend/);
    assert.match(received.messages[0].content, /exclude its price from trend, levels, returns/);
    assert.equal(JSON.parse(received.messages[1].content).segment.segmentId, segment.segmentId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("root gateway URLs use Chat Completions by default; Responses stays explicit", async () => {
  assert.equal(resolveProviderWireApi({ baseUrl: "https://gateway.example.test" }), "chat");
  assert.equal(resolveProviderWireApi({ baseUrl: "https://api.example.com/v1" }), "chat");
  assert.equal(resolveProviderWireApi({ baseUrl: "https://gateway.example.test", apiFormat: "responses" }), "responses");
  let requestUrl = "";
  let received;
  const server = http.createServer(async (request, response) => {
    requestUrl = request.url;
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ output_text: JSON.stringify({ action: "HOLD", confidence: 0.3 }) }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Gateway", model: "your-model", baseUrl: `http://127.0.0.1:${port}`, apiKey: "provider-secret", apiFormat: "responses" });
    const result = await requestDecision(provider, { market: { trend: "up" }, evidenceIds: [] });
    assert.equal(requestUrl, "/responses");
    assert.equal(received.model, "your-model");
    assert.ok(Array.isArray(received.input));
    assert.equal(result.action, "HOLD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("legacy root Responses configs fall back to CC Switch Chat endpoint", async () => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    seen.push(request.url);
    if (request.url !== "/chat/completions") {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", confidence: 0.5 }) } }] }));
  });
  const port = await listen(server);
  try {
    const result = await requestDecision({ baseUrl: `http://127.0.0.1:${port}`, model: "demo", apiKey: "key", apiFormat: "responses" }, { evidenceIds: [] });
    assert.equal(result.action, "HOLD");
    assert.deepEqual(seen, ["/responses", "/v1/responses", "/chat/completions"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTML from a wrong root endpoint falls through to the Responses route", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    if (request.url === "/v1/responses") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ output_text: JSON.stringify({ action: "HOLD", confidence: 0.5 }) }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><html><body>web ui</body></html>");
  });
  const port = await listen(server);
  try {
    const result = await requestDecision({ baseUrl: `http://127.0.0.1:${port}`, model: "demo", apiKey: "key", apiFormat: "responses" }, { evidenceIds: [] });
    assert.equal(result.action, "HOLD");
    assert.deepEqual(seen, ["/responses", "/v1/responses"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("plaintext apiKey is enough for a local model request without encryptedKey", async () => {
  let seenAuth = "";
  const server = http.createServer(async (request, response) => {
    seenAuth = String(request.headers.authorization || "");
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", confidence: 0.1 }) } }] }));
  });
  const port = await listen(server);
  try {
    const result = await requestDecision({
      name: "Local",
      model: "demo",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "plain-desktop-key",
    }, { market: { trend: "range" }, evidenceIds: [] });
    assert.equal(seenAuth, "Bearer plain-desktop-key");
    assert.equal(result.action, "HOLD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
