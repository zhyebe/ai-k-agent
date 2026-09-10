import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildConversationMessages, createProvider, publicProvider, requestDecision, requestSegmentReview, resolveProviderWireApi, verifyProvider } from "../server/provider.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("provider verification checks an OpenAI-compatible models endpoint", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer provider-secret");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [] }));
  });
  const port = await listen(server);
  try {
    const provider = createProvider({ name: "Local", model: "demo", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "provider-secret" });
    const result = await verifyProvider(provider);
    assert.equal(result.ok, true);
    assert.equal(result.status, "已验证");
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
    name: "我的天成",
    baseUrl: "https://ai.tiancheng.tcyun.net",
    model: "gpt-6-astra",
    apiKey: "sk-user-owned",
    apiFormat: "openai_responses",
  });
  provider.ownerUserId = "user_desktop_1";
  const published = publicProvider(provider);
  assert.equal(published.configured, true);
  assert.equal(published.apiFormat, "responses");
  assert.equal("encryptedKey" in published, false);
  assert.equal("apiKey" in published, false);
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

test("天成网关按 Codex/cc-switch 走 Responses API，不打 chat/completions", async () => {
  assert.equal(resolveProviderWireApi({ baseUrl: "https://ai.tiancheng.tcyun.net" }), "responses");
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
    const provider = createProvider({ name: "天成 AI", model: "gpt-6-astra", baseUrl: `http://127.0.0.1:${port}`, apiKey: "provider-secret", apiFormat: "responses" });
    const result = await requestDecision(provider, { market: { trend: "up" }, evidenceIds: [] });
    assert.equal(requestUrl, "/responses");
    assert.equal(received.model, "gpt-6-astra");
    assert.ok(Array.isArray(received.input));
    assert.equal(result.action, "HOLD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
