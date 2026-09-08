import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createProvider, publicProvider, requestDecision, verifyProvider } from "../server/provider.mjs";

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
