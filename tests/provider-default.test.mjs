import assert from "node:assert/strict";
import test from "node:test";
import { setTaskProvider } from "../server/engine.mjs";
import { publicProviderList, resolveDefaultProviderId, state } from "../server/store.mjs";

test("analysis uses only the signed-in user's configured providers", () => {
  const original = state.providers;
  state.providers = [
    { id: "provider_shared", ownerUserId: "", encryptedKey: "enc-shared", baseUrl: "https://api.example.com/v1" },
    { id: "provider_owned", ownerUserId: "user_1", encryptedKey: "enc-owned", baseUrl: "https://gateway.example.test" },
  ];
  try {
    assert.equal(resolveDefaultProviderId("user_1"), "provider_owned");
    assert.equal(resolveDefaultProviderId("user_1", "provider_shared"), "provider_owned");
    assert.equal(resolveDefaultProviderId("user_2"), "");
    assert.deepEqual(publicProviderList("user_1").map((item) => item.id), ["provider_owned"]);
    assert.deepEqual(publicProviderList("user_2"), []);
    assert.deepEqual(publicProviderList(""), []);
  } finally {
    state.providers = original;
  }
});

test("task provider switch persists the selected model id", () => {
  const originalProviders = state.providers;
  const taskId = `task_provider_switch_${Date.now()}`;
  state.providers = [
    { id: "provider_owned", ownerUserId: "user_1", name: "自建网关", model: "your-model", encryptedKey: "enc-owned", baseUrl: "https://gateway.example.test" },
  ];
  state.tasks.unshift({ id: taskId, providerId: "", pendingAction: null, status: "READY" });
  try {
    const task = setTaskProvider(taskId, "provider_owned", "user_1");
    assert.equal(task.providerId, "provider_owned");
    assert.equal(state.tasks.find((item) => item.id === taskId).providerId, "provider_owned");
  } finally {
    state.providers = originalProviders;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  }
});
