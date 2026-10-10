import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildConversationMessages, createProvider, listProviderModels, normalizeUnitProbability, providerApiKey, providerIdentityKey, providerRequestUrl, publicProvider, requestBrowserActions, requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider } from "../server/provider.mjs";
import { hasDirectionalProbabilities } from "../server/entry-policy.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("AI cancel decisions preserve exact IDs with HOLD and prompt uses net profit/configured quantity", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    assert.match(prompt, /Every round inspect every account.openOrders/);
    assert.match(prompt, /Do not label a flat or negative net result TAKE_PROFIT/);
    assert.match(prompt, /User-configured entry quantity: 3/);
    assert.equal(JSON.parse(body.messages.at(-1).content).account.openOrders[0].orderId, "O-1");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.6, bearish_profit_probability: 0.4,
      order_assessments: [{ order_id: "O-1", decision: "CANCEL", reason: "entry price no longer favorable" }, { order_id: "O-2", decision: "KEEP" }] }) } }] }));
  });
  const decision = await requestDecision({ apiKey: "test", baseUrl: "https://example.test", model: "fast" }, { account: { openOrders: [{ orderId: "O-1" }] }, strategy: { entryQuantity: 3 } }, { fastAnalysis: true });
  assert.deepEqual(decision.cancelOrderIds, ["O-1"]);
  assert.equal(decision.orderAssessments[1].decision, "KEEP");
  assert.equal(calls, 1);
  assert.deepEqual(buildConversationMessages({ recentRounds: [{ decision }] })[1] && JSON.parse(buildConversationMessages({ recentRounds: [{ decision }] })[1].content).cancelOrderIds, ["O-1"]);
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
  const published = publicProvider(provider);
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
    assert.match(seen[0].body.system, />= 0\.45/);
    assert.match(seen[0].body.system, /do not wait for a finished/);
    assert.match(seen[0].body.system, /second 50/);
    assert.match(seen[0].body.system, /approved Skills/);
    assert.match(seen[0].body.system, /MUST be BUY/);
    assert.match(seen[0].body.system, /selected probability must be >= 0\.45/);
    assert.match(seen[0].body.system, /hard entry requirement/);
    assert.match(seen[0].body.system, /BUY requires bullish_profit_probability >= 0\.45; SELL requires bearish_profit_probability >= 0\.45/);
    assert.doesNotMatch(seen[0].body.system, /differ by less than 0\.05|narrow-gap trigger/);
    assert.match(seen[0].body.system, /short can capture 20 -> 19/);
    assert.match(seen[0].body.system, /another K can produce another entry/);
    assert.match(seen[0].body.system, /never HOLD merely because an earlier position exists/);
    assert.match(seen[0].body.system, /profit_probability equals the selected direction/);
    assert.match(seen[0].body.system, /User-configured entry quantity: 1 per new order/);
    assert.match(seen[0].body.system, /Never leave an AI-identified maximum-profit or minimum-loss exit as HOLD/);
    assert.match(seen[0].body.system, /BROWSER_PLAN/);
    assert.match(seen[0].body.system, /host only fills the target form/);
    assert.match(seen[0].body.system, /Never swap these meanings/);
    assert.match(seen[0].body.system, /Price response outranks static displayed depth/);
    assert.match(seen[0].body.system, /correct persistent directional bias/);
    assert.match(seen[0].body.system, /Finish the round's JSON fully/);
    assert.match(seen[0].body.system, /monitoring continues next round/);
    assert.doesNotMatch(seen[0].body.system, /aborts this round at 50s/);
    assert.match(seen[0].body.system, /maximizes expected net profit or minimizes expected loss/);
    assert.match(seen[0].body.system, /Exit timing is an AI forecast, not a fixed immediate-profit rule/);
    assert.match(seen[0].body.system, /A positive current mark alone is not an exit signal/);
    assert.match(seen[0].body.system, /Do not wait for another K after you explicitly decide that exit now is optimal/);
    assert.doesNotMatch(seen[0].body.system, /any positive net proceeds after known fees and slippage/);
    assert.match(seen[0].body.system, /Both manual-entry and auto-entry modes automate exits/);
    assert.match(seen[0].body.system, /never lower them to justify HOLD/);
    assert.equal(seen[1].headers["x-goog-api-key"], "gemini-key");
    assert.equal(seen[1].url, "/v1beta/models/gemini-custom:generateContent");
    assert.ok(seen[1].body.systemInstruction);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("below 45% HOLD is preserved without a second AI request even when probabilities are close", async (t) => {
  let calls = 0;
  let bullish = 0;
  let bearish = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: bullish, bearish_profit_probability: bearish }) } }] }));
  });
  for (const [longProbability, shortProbability] of [[0.44, 0.42], [0.21, 0.2], [0.449999, 0.44]]) {
    bullish = longProbability;
    bearish = shortProbability;
    const before = calls;
    const result = await requestDecision({ apiKey: "test", baseUrl: "https://provider.example.test", model: "demo", apiFormat: "chat" }, { account: { positions: [] } });
    assert.equal(result.action, "HOLD");
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
      assert.match(requests[1].messages.at(-1).content, /compare exiting now with holding through the next relevant move/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("owned providers with the same name, model and URL share an identity", () => {
  const first = { ownerUserId: "user_1", name: "gateway", model: "your-model", baseUrl: "https://gateway.example.test/" };
  const second = { ownerUserId: "user_1", name: "Gateway", model: "your-model", baseUrl: "https://gateway.example.test" };
  assert.equal(providerIdentityKey(first), providerIdentityKey(second));
  assert.equal(publicProvider({ ...first, encryptedKey: "x" }).owned, true);
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
    assert.deepEqual(received.messages[1].content.includes("EMA20 slope is flat"), true);
    assert.match(received.messages[0].content, /counterparty may be AI-controlled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HOLD above 45% is returned to AI for correction even with open positions", async () => {
  let calls = 0;
  let correct = true;
  const correctionMessages = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls += 1;
    const messages = JSON.parse(body).messages;
    if (calls % 2 === 0) correctionMessages.push(messages.at(-1).content);
    response.setHeader("content-type", "application/json");
    const decision = calls % 2 === 0 && correct
      ? { action: "SELL", bullish_profit_probability: 0.41, bearish_profit_probability: 0.53, profit_probability: 0.53 }
      : { action: "HOLD", bullish_profit_probability: 0.41, bearish_profit_probability: 0.53, profit_probability: 0.53 };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "demo", apiKey: "key" });
    const corrected = await requestDecision(provider, { account: { positions: [] } });
    assert.equal(corrected.action, "SELL");
    assert.equal(corrected.bearishProfitProbability, 0.53);
    assert.equal(calls, 2);
    correct = false;
    const inconsistent = await requestDecision(provider, { account: { positions: [] } });
    assert.equal(inconsistent.action, "HOLD");
    assert.ok(inconsistent.riskFlags.includes("ANALYSIS_INCOMPLETE"));
    assert.ok(inconsistent.riskFlags.includes("INCONSISTENT_ACTION_PROBABILITY"));
    assert.equal(calls, 4);
    correct = true;
    const holding = await requestDecision(provider, { account: { positions: [{ quantity: 1, side: "买" }] } });
    assert.equal(holding.action, "SELL");
    assert.equal(calls, 6);
    assert.ok(correctionMessages.every((message) => /selected direction's profit probability >= 0\.45/.test(message)));
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
    assert.match(promptMessage.content, /审核通过的 Skill/);
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
      bullish_profit_probability: 0.44,
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
