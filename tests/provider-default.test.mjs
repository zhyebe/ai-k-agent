import assert from "node:assert/strict";
import test from "node:test";
import { setTaskProvider } from "../server/engine.mjs";
import { collapseDuplicateProviders, findProviderForUser, persistTask, publicProviderList, publicState, publicTask, resolveDefaultProviderId, setPersistence, state } from "../server/store.mjs";

test("signed-in users share providers while ownership remains specific to the creator", () => {
  const original = state.providers;
  state.providers = [
    { id: "provider_unconfigured", ownerUserId: "user_2", baseUrl: "https://api.example.com/v1" },
    { id: "provider_shared", providerKey: "legacy-key", ownerUserId: "", encryptedKey: "enc-shared", baseUrl: "https://api.example.com/v1" },
    { id: "provider_owned", ownerUserId: "user_1", encryptedKey: "enc-owned", baseUrl: "https://gateway.example.test" },
  ];
  try {
    assert.equal(resolveDefaultProviderId("user_1"), "provider_shared");
    assert.equal(resolveDefaultProviderId("user_1", "provider_shared"), "provider_shared");
    assert.equal(resolveDefaultProviderId("user_2"), "provider_shared");
    assert.equal(resolveDefaultProviderId("user_2", "provider_owned"), "provider_owned");
    assert.deepEqual(publicProviderList("user_1").map(({ id, owned }) => ({ id, owned })), [
      { id: "provider_unconfigured", owned: false }, { id: "provider_shared", owned: false }, { id: "provider_owned", owned: true },
    ]);
    assert.deepEqual(publicProviderList("user_2").map(({ id, owned }) => ({ id, owned })), [
      { id: "provider_unconfigured", owned: true }, { id: "provider_shared", owned: false }, { id: "provider_owned", owned: false },
    ]);
    assert.deepEqual(publicProviderList(""), []);
    assert.equal(findProviderForUser("provider_shared", ""), null);
    assert.equal(findProviderForUser("", ""), null);
    assert.equal(resolveDefaultProviderId("", "provider_owned"), "");
    assert.equal(findProviderForUser("provider_owned", "user_2").id, "provider_owned");
    assert.equal(findProviderForUser("legacy-key", "user_2").id, "provider_shared");
    assert.equal(findProviderForUser("missing", "user_2"), null);
    assert.equal(resolveDefaultProviderId("user_2", "missing"), "missing", "a removed selection must not silently use a different provider");
    assert.equal(JSON.stringify(publicProviderList("user_2")).includes("enc-owned"), false);
  } finally {
    state.providers = original;
  }
});

test("workspace returns shared providers and creator permissions even without tasks", () => {
  const original = state.providers;
  state.providers = [
    { id: "provider_owned", ownerUserId: "user_1", name: "自建网关", model: "your-model", encryptedKey: "enc-owned", baseUrl: "https://gateway.example.test" },
    { id: "provider_other", ownerUserId: "user_2", name: "别人的", model: "other", encryptedKey: "enc-other", baseUrl: "https://other.example.test" },
  ];
  try {
    const snapshot = publicState({ taskIds: [], userId: "user_1" });
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.providers.map(({ id, owned }) => ({ id, owned })), [
      { id: "provider_owned", owned: true }, { id: "provider_other", owned: false },
    ]);
  } finally {
    state.providers = original;
  }
});

test("task can select another user's shared provider without granting access to their tasks", () => {
  const originalProviders = state.providers;
  const taskId = `task_provider_switch_${Date.now()}`;
  const siblingId = `${taskId}_same_user`;
  const otherId = `${taskId}_other_user`;
  const persisted = [];
  setPersistence({ saveTask: (task) => persisted.push(task) });
  state.providers = [
    { id: "provider_owned", ownerUserId: "user_1", name: "自建网关", model: "your-model", encryptedKey: "enc-owned", baseUrl: "https://gateway.example.test" },
  ];
  state.tasks.unshift({ id: taskId, ownerUserId: "user_2", providerId: "", pendingAction: null, status: "READY" });
  state.tasks.unshift({ id: siblingId, ownerUserId: "user_2", providerId: "" }, { id: otherId, ownerUserId: "user_1", providerId: "other-choice" });
  try {
    assert.throws(() => setTaskProvider(taskId, "provider_owned", "user_1"), /TASK_ACCESS_DENIED/);
    assert.throws(() => setTaskProvider(taskId, "", "user_2"), /PROVIDER_NOT_READY/);
    const task = setTaskProvider(taskId, "provider_owned", "user_2");
    assert.equal(task.providerId, "provider_owned");
    assert.equal(state.tasks.find((item) => item.id === taskId).providerId, "provider_owned");
    assert.equal(state.tasks.find((item) => item.id === siblingId).providerId, "provider_owned");
    assert.equal(state.tasks.find((item) => item.id === otherId).providerId, "other-choice");
    assert.deepEqual(persisted, [], "selection does not write persistent state");
    assert.equal("providerId" in publicTask(task), false);
  } finally {
    state.providers = originalProviders;
    state.tasks = state.tasks.filter((item) => ![taskId, siblingId, otherId].includes(item.id));
    setPersistence(null);
  }
});

test("subsequent task persistence excludes the transient provider selection", async () => {
  let saved;
  setPersistence({ saveTask: (task) => { saved = task; } });
  try {
    const task = { id: "local-selection", providerId: "local-model", name: "Task", ownerUserId: "user_1" };
    await persistTask(task);
    assert.equal("providerId" in saved, false);
    assert.equal(saved.ownerUserId, "user_1");
    assert.equal(task.providerId, "local-model");
  } finally { setPersistence(null); }
});

test("listing shared providers cannot deduplicate or delete another creator's data", () => {
  const original = state.providers;
  const provider = { name: "gateway", model: "model", baseUrl: "https://gateway.example.test", encryptedKey: "enc-test" };
  state.providers = [
    { ...provider, id: "a_1", ownerUserId: "user_a" }, { ...provider, id: "a_2", ownerUserId: "user_a" },
    { ...provider, id: "b_1", ownerUserId: "user_b" }, { ...provider, id: "b_2", ownerUserId: "user_b" },
  ];
  try {
    assert.equal(collapseDuplicateProviders(), 0);
    assert.equal(collapseDuplicateProviders("user_c"), 0);
    assert.equal(collapseDuplicateProviders("user_a"), 1);
    assert.deepEqual(publicProviderList("user_a").map((item) => item.id), ["a_1", "b_1", "b_2"]);
    assert.equal(collapseDuplicateProviders("user_b"), 1);
    assert.deepEqual(publicProviderList("user_b").map((item) => item.id), ["a_1", "b_1"]);
  } finally { state.providers = original; }
});
