import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

function loadApi() {
  const api = {};
  const calls = [];
  const source = fs.readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8").replaceAll("import.meta", "({ env: {} })");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    exports: api, window: { localStorage: storage(), sessionStorage: storage() },
    Headers, URL, URLSearchParams, AbortController, AbortSignal, DOMException,
    fetch: (url, options) => new Promise((resolve) => { calls.push({ url, ...options, resolve }); }),
  });
  return { api, calls };
}

const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("logout clears the session, aborts old requests and rejects a response even when fetch ignores cancellation", async () => {
  const { api, calls } = loadApi();
  api.setUserToken("session-A");
  const input = { name: "Provider", model: "model", baseUrl: "https://example.test" };
  const oldSave = api.saveProvider(input);
  const oldRejected = assert.rejects(oldSave, /SESSION_ENDED/);
  assert.equal(api.getPendingRequests(), 1);
  const logout = api.userLogout();
  assert.equal(api.getUserToken(), "");
  assert.equal(api.getPendingRequests(), 0);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].headers.get("x-user-token"), "session-A");
  api.setUserToken("session-B");
  const newSave = api.saveProvider(input);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.get("x-user-token"), "session-B");
  calls[0].resolve(json({ provider: { id: "provider-A" } }));
  await oldRejected;
  assert.equal(api.getPendingRequests(), 1, "old cleanup cannot decrement the new session's pending count");
  calls[1].resolve(json({ ok: true }));
  await logout;
  calls[2].resolve(json({ provider: { id: "provider-B" } }));
  assert.equal((await newSave).id, "provider-B");
  assert.equal(api.getPendingRequests(), 0);
});

test("changing the API server invalidates old responses and preserves same-session mutation deduplication", async () => {
  const { api, calls } = loadApi();
  api.setUserToken("session-A");
  const input = { name: "Provider" };
  const first = api.saveProvider(input);
  const duplicate = api.saveProvider(input);
  const rejected = Promise.all([assert.rejects(first, /SESSION_ENDED/), assert.rejects(duplicate, /SESSION_ENDED/)]);
  assert.equal(calls.length, 1);
  await api.configureApiBaseUrl("https://new-api.test");
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(json({ provider: { id: "old-server-provider" } }));
  await rejected;
  api.setUserToken("session-A");
  const next = api.saveProvider(input);
  assert.equal(calls[1].url, "https://new-api.test/api/providers");
  calls[1].resolve(json({ provider: { id: "new-server-provider" } }));
  assert.equal((await next).id, "new-server-provider");
});
