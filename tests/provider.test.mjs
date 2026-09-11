import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildConversationMessages, createProvider, listProviderModels, providerApiKey, providerIdentityKey, providerRequestUrl, publicProvider, requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider } from "../server/provider.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

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
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com", model: "m", apiFormat: "chat" }), "https://api.example.com/v1/chat/completions");
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com/v1", model: "m", apiFormat: "anthropic" }), "https://api.example.com/v1/messages");
  assert.equal(providerRequestUrl({ baseUrl: "https://api.example.com", model: "gemini/custom", apiFormat: "gemini" }), "https://api.example.com/v1beta/models/gemini%2Fcustom:generateContent");
  assert.equal(providerRequestUrl({ baseUrl: "https://custom.example.test/infer?mode=fast", model: "m", apiFormat: "chat", fullUrlMode: true }), "https://custom.example.test/infer?mode=fast");
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
    assert.equal(seen[1].headers["x-goog-api-key"], "gemini-key");
    assert.equal(seen[1].url, "/v1beta/models/gemini-custom:generateContent");
    assert.ok(seen[1].body.systemInstruction);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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

test("root gateway URLs use Responses API; /v1 uses Chat Completions", async () => {
  assert.equal(resolveProviderWireApi({ baseUrl: "https://gateway.example.test" }), "responses");
  assert.equal(resolveProviderWireApi({ baseUrl: "https://api.example.com/v1" }), "chat");
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
