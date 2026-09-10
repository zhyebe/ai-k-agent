import assert from "node:assert/strict";
import test from "node:test";
import { attachDesktopAiSocket, callProviderMethod, desktopAiRequired, hasDesktopAi, resetDesktopAiForTests } from "../server/desktop-ai.mjs";

test("production requires a connected desktop before model HTTP leaves the API host", async () => {
  resetDesktopAiForTests();
  const previous = process.env.AXIOM_REQUIRE_DESKTOP_AI;
  const previousWait = process.env.AXIOM_DESKTOP_AI_WAIT_MS;
  process.env.AXIOM_REQUIRE_DESKTOP_AI = "1";
  process.env.AXIOM_DESKTOP_AI_WAIT_MS = "0";
  try {
    assert.equal(desktopAiRequired(), true);
    assert.equal(hasDesktopAi("user_1"), false);
    await assert.rejects(
      () => callProviderMethod("requestDecision", "user_1", { provider: { apiKey: "k", baseUrl: "https://example.invalid", model: "demo" }, context: {} }),
      /DESKTOP_AI_OFFLINE/,
    );
  } finally {
    if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_AI;
    else process.env.AXIOM_REQUIRE_DESKTOP_AI = previous;
    if (previousWait === undefined) delete process.env.AXIOM_DESKTOP_AI_WAIT_MS;
    else process.env.AXIOM_DESKTOP_AI_WAIT_MS = previousWait;
    resetDesktopAiForTests();
  }
});

test("desktop AI runtime executes the model call locally and returns the result", async () => {
  resetDesktopAiForTests();
  const previous = process.env.AXIOM_REQUIRE_DESKTOP_AI;
  process.env.AXIOM_REQUIRE_DESKTOP_AI = "1";
  const socket = {
    readyState: 1,
    handlers: {},
    send(raw) {
      const message = JSON.parse(raw);
      assert.equal(message.type, "ai.call");
      assert.equal(message.method, "requestDecision");
      assert.equal(message.provider.apiKey, "desktop-key");
      assert.equal(message.provider.baseUrl, "https://ai.example.test");
      assert.equal("encryptedKey" in message.provider, false);
      const reply = JSON.stringify({
        type: "ai.result",
        id: message.id,
        ok: true,
        result: { action: "HOLD", confidence: 0.4, riskFlags: ["FROM_DESKTOP"] },
      });
      queueMicrotask(() => this.handlers.message?.(reply));
    },
    on(event, handler) { this.handlers[event] = handler; },
    off(event) { delete this.handlers[event]; },
  };
  try {
    attachDesktopAiSocket("user_1", socket);
    const result = await callProviderMethod("requestDecision", "user_1", {
      provider: { apiKey: "desktop-key", baseUrl: "https://ai.example.test", model: "demo" },
      context: { market: { trend: "range" } },
    });
    assert.equal(result.action, "HOLD");
    assert.equal(result.confidence, 0.4);
    assert.deepEqual(result.riskFlags, ["FROM_DESKTOP"]);
  } finally {
    if (previous === undefined) delete process.env.AXIOM_REQUIRE_DESKTOP_AI;
    else process.env.AXIOM_REQUIRE_DESKTOP_AI = previous;
    resetDesktopAiForTests();
  }
});
