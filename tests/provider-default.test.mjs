import assert from "node:assert/strict";
import test from "node:test";
import { setTaskProvider } from "../server/engine.mjs";
import { resolveDefaultProviderId, state } from "../server/store.mjs";

test("analysis prefers a user-owned configured provider over DeepSeek", () => {
  const original = state.providers;
  state.providers = [
    { id: "provider_deepseek", ownerUserId: "", encryptedKey: "enc-deepseek", baseUrl: "https://api.deepseek.com/v1" },
    { id: "provider_tiancheng", ownerUserId: "user_1", encryptedKey: "enc-tiancheng", baseUrl: "https://ai.tiancheng.tcyun.net" },
  ];
  try {
    assert.equal(resolveDefaultProviderId("user_1"), "provider_tiancheng");
    assert.equal(resolveDefaultProviderId("user_1", "provider_deepseek"), "provider_deepseek");
    assert.equal(resolveDefaultProviderId("user_2"), "provider_deepseek");
  } finally {
    state.providers = original;
  }
});

test("task provider switch persists the selected model id", () => {
  const originalProviders = state.providers;
  const taskId = `task_provider_switch_${Date.now()}`;
  state.providers = [
    { id: "provider_deepseek", ownerUserId: "", name: "DeepSeek", model: "deepseek-v4-pro", encryptedKey: "enc-deepseek", baseUrl: "https://api.deepseek.com/v1" },
    { id: "provider_tiancheng", ownerUserId: "user_1", name: "天成 AI", model: "gpt-6-astra", encryptedKey: "enc-tiancheng", baseUrl: "https://ai.tiancheng.tcyun.net" },
  ];
  state.tasks.unshift({ id: taskId, providerId: "provider_deepseek", pendingAction: null, status: "READY" });
  try {
    const task = setTaskProvider(taskId, "provider_tiancheng", "user_1");
    assert.equal(task.providerId, "provider_tiancheng");
    assert.equal(state.tasks.find((item) => item.id === taskId).providerId, "provider_tiancheng");
  } finally {
    state.providers = originalProviders;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});
