import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

async function start(directory) {
  const token = crypto.randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, AXIOM_STANDALONE: "1", AXIOM_LOCAL_TOKEN: token, AXIOM_DATA_DIR: directory, PORT: "0", HOST: "0.0.0.0", DB_MODE: "mysql", MYSQL_URL: "mysql://invalid:invalid@127.0.0.1:1/invalid", APP_SECRET: "old-cloud-secret" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error(`LOCAL_START_TIMEOUT ${errors}`)); }, 15000);
    child.once("message", resolve);
    child.once("exit", code => reject(new Error(`LOCAL_START_FAILED ${code} ${errors}`)));
    child.once("error", reject);
  });
  const message = await ready.finally(() => clearTimeout(timer));
  const base = `http://127.0.0.1:${message.port}`;
  return {
    token, base,
    async request(route, body, method = body === undefined ? "GET" : "POST", authenticated = true) {
      const response = await fetch(`${base}${route}`, { method, headers: { ...(authenticated ? { "x-user-token": token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.send({ type: "shutdown" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code] = await exited.finally(() => clearTimeout(timer));
      assert.equal(code, 0, errors);
    },
  };
}

test("standalone needs no account/database and restores encrypted configuration with fresh runtime access", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-standalone-"));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  runtime = await start(directory);
  assert.equal((await runtime.request("/api/workspace", undefined, "GET", false)).status, 401);
  assert.equal((await runtime.request("/api/admin/login", { username: "admin", password: "local-admin" })).status, 404);
  assert.equal((await runtime.request("/api/user/login", {})).status, 404);
  const health = (await runtime.request("/api/health")).body;
  assert.equal(health.persistence.mode, "file");
  assert.equal(health.persistentSecret, true);
  assert.equal((await runtime.request("/api/user/session")).body.user.id, "local-user");
  const workspace = (await runtime.request("/api/workspace")).body;
  assert.equal(workspace.skills.length, 1);
  assert.equal(workspace.skills[0].owned, true);
  assert.equal(workspace.skills[0].status, "APPROVED");
  const provider = await runtime.request("/api/providers", { name: "Local AI", baseUrl: "https://example.invalid/v1", apiKey: "standalone-secret-key", model: "test-model" });
  assert.equal(provider.status, 201);
  assert.equal(provider.body.provider.configured, true);
  const task = await runtime.request("/api/tasks", { name: "本机任务", targetType: "website", url: "https://smyw.haohandahan.cn/client/#/transcc", username: "target-username", password: "target-password", entryQuantity: 2, mode: "PAPER" });
  assert.equal(task.status, 201);
  await runtime.request(`/api/skills/${workspace.skills[0].id}`, undefined, "DELETE");
  const oldToken = runtime.token;
  const secret = await fs.readFile(path.join(directory, ".axiom-secret"), "utf8");
  assert.notEqual(secret.trim(), "old-cloud-secret");
  await runtime.close();
  const saved = await fs.readFile(path.join(directory, "workspace.json"), "utf8");
  assert.doesNotMatch(saved, /standalone-secret-key|target-password|target-username/);
  const snapshot = JSON.parse(saved);
  snapshot.tasks[0].monitoringEnabled = true;
  snapshot.tasks[0].status = "MONITORING";
  await fs.writeFile(path.join(directory, "workspace.json"), JSON.stringify(snapshot));
  runtime = await start(directory);
  const rejected = await fetch(`${runtime.base}/api/workspace`, { headers: { "x-user-token": oldToken } });
  assert.equal(rejected.status, 401);
  const restored = (await runtime.request("/api/workspace")).body;
  assert.equal(restored.providers[0].configured, true);
  assert.equal(restored.tasks[0].entryQuantity, 2);
  assert.equal(restored.tasks[0].status, "PAUSED");
  assert.equal(restored.tasks[0].monitoringEnabled, false);
  assert.equal(restored.skills.length, 0, "deleted built-in knowledge must not reappear on restart");
  assert.equal(await fs.readFile(path.join(directory, ".axiom-secret"), "utf8"), secret);
  await runtime.request("/api/health");
  const workspaceFile = path.join(directory, "workspace.json");
  await fs.rename(workspaceFile, `${workspaceFile}.saved`);
  await fs.mkdir(workspaceFile);
  const failedSave = await runtime.request("/api/providers", { id: restored.providers[0].id, model: "unsaved-model" });
  assert.equal(failedSave.status, 503);
  const failedWorkspace = (await runtime.request("/api/workspace")).body;
  assert.equal(failedWorkspace.providers[0].model, "test-model", "failed edit must not replace the committed provider in memory");
  assert.equal(failedWorkspace.health.dbAvailable, false);
  await fs.rmdir(workspaceFile);
  await fs.rename(`${workspaceFile}.saved`, workspaceFile);
  assert.equal((await runtime.request("/api/providers", { id: restored.providers[0].id, model: "test-model" })).status, 200);
  const reused = await runtime.request("/api/tasks", { name: "复用凭据", targetType: "website", url: "https://smyw.haohandahan.cn/client/#/transcc" });
  assert.equal(reused.body.task.target.credentialStatus, "已托管");
  await runtime.close();
  await fs.unlink(path.join(directory, ".axiom-secret"));
  await assert.rejects(start(directory), /LOCAL_SECRET_MISSING/);
});
