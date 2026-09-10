import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForApi(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API_EXITED_${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API_START_TIMEOUT");
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("connector test enforces task binding and clears credentials on target change", async () => {
  const port = await freePort();
  const dataDir = `/tmp/axiom-agent-api-boundary-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_MODE: "memory",
      APP_SECRET: "api-boundary-test-secret",
      ADMIN_USERNAME: "boundary-admin",
      ADMIN_PASSWORD: "boundary-admin-pass",
      DESKTOP_USERNAME: "boundary-user",
      DESKTOP_PASSWORD: "boundary-user-pass",
      AXIOM_DATA_DIR: dataDir,
      AXIOM_VAULT_FILE: `${dataDir}/credentials.vault.json`,
      AXIOM_SECRET_FILE: `${dataDir}/.axiom-secret`,
      BROWSER_ALLOWED_DOMAINS: "localhost,127.0.0.1,smyw.haohandahan.cn",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForApi(baseUrl, child);
    const login = await request(baseUrl, "/api/user/login", { method: "POST", body: JSON.stringify({ username: "boundary-user", password: "boundary-user-pass" }) });
    assert.equal(login.status, 200, errors.join(""));
    const headers = { "x-user-token": login.body.token };

    const adminLogin = await request(baseUrl, "/api/admin/login", { method: "POST", body: JSON.stringify({ username: "boundary-admin", password: "boundary-admin-pass" }) });
    assert.equal(adminLogin.status, 200);
    const adminHeaders = { "x-admin-token": adminLogin.body.token };
    const adminWorkspace = await request(baseUrl, "/api/workspace", { headers: adminHeaders });
    assert.equal(adminWorkspace.status, 401);
    assert.equal(adminWorkspace.body.error, "USER_AUTH_REQUIRED");
    const adminTaskAction = await request(baseUrl, "/api/tasks/task_demo_001/start", { method: "POST", headers: adminHeaders, body: "{}" });
    assert.equal(adminTaskAction.status, 401);
    const adminConnector = await request(baseUrl, "/api/connectors/test", { method: "POST", headers: adminHeaders, body: JSON.stringify({ connectorId: "connector_haohan_readonly" }) });
    assert.equal(adminConnector.status, 401);
    for (const path of ["/api/providers", "/api/skills", "/api/credentials"]) {
      const response = await request(baseUrl, path, { headers: adminHeaders });
      assert.equal(response.status, 401, `${path} must reject admin sessions`);
      assert.equal(response.body.error, "USER_AUTH_REQUIRED");
    }
    const userProviders = await request(baseUrl, "/api/providers", { headers });
    assert.equal(userProviders.status, 200);
    const userSkills = await request(baseUrl, "/api/skills", { headers });
    assert.equal(userSkills.status, 200);
    const userCredentials = await request(baseUrl, "/api/credentials", { headers });
    assert.equal(userCredentials.status, 200);
    const userSkill = await request(baseUrl, "/api/skills", { method: "POST", headers, body: JSON.stringify({ title: "boundary skill", content: "boundaryonlytoken 只读观察规则" }) });
    assert.equal(userSkill.status, 201);
    const approvedSkill = await request(baseUrl, `/api/skills/${userSkill.body.skill.id}/approve`, { method: "POST", headers, body: "{}" });
    assert.equal(approvedSkill.status, 200);
    const userProvider = await request(baseUrl, "/api/providers", { method: "POST", headers, body: JSON.stringify({ name: "Boundary Provider", baseUrl: "https://example.invalid/v1", model: "boundary-model", apiKey: "boundary-key" }) });
    assert.equal(userProvider.status, 201);
    assert.equal(userProvider.body.provider.configured, true);
    const secondCreated = await request(baseUrl, "/api/admin/users", { method: "POST", headers: adminHeaders, body: JSON.stringify({ username: "boundary-second", displayName: "第二用户", password: "boundary-second-pass" }) });
    assert.equal(secondCreated.status, 201);
    const secondLogin = await request(baseUrl, "/api/user/login", { method: "POST", body: JSON.stringify({ username: "boundary-second", password: "boundary-second-pass" }) });
    assert.equal(secondLogin.status, 200);
    const secondHeaders = { "x-user-token": secondLogin.body.token };
    const secondProviders = await request(baseUrl, "/api/providers", { headers: secondHeaders });
    assert.equal(secondProviders.status, 200);
    assert.equal(secondProviders.body.providers.some((provider) => provider.name === "Boundary Provider"), false);
    const secondSkills = await request(baseUrl, "/api/skills", { headers: secondHeaders });
    assert.equal(secondSkills.status, 200);
    assert.equal(secondSkills.body.skills.some((skill) => skill.title === "boundary skill"), false);
    const firstRag = await request(baseUrl, "/api/rag/search?q=boundaryonlytoken", { headers });
    const secondRag = await request(baseUrl, "/api/rag/search?q=boundaryonlytoken", { headers: secondHeaders });
    assert.ok(firstRag.body.results.some((result) => result.title === "boundary skill"));
    assert.equal(secondRag.body.results.some((result) => result.title === "boundary skill"), false);
    const adminSummary = await request(baseUrl, "/api/admin/summary", { headers: adminHeaders });
    assert.equal(adminSummary.status, 200);
    assert.equal(adminSummary.body.scope, "accounts_assignments_audit");
    assert.ok(Array.isArray(adminSummary.body.accounts));
    assert.ok(Array.isArray(adminSummary.body.tasks));
    assert.ok(Array.isArray(adminSummary.body.events));
    assert.equal("skills" in adminSummary.body, false);
    assert.equal("providers" in adminSummary.body, false);
    assert.equal("connectors" in adminSummary.body, false);
    const listedUsers = await request(baseUrl, "/api/admin/users", { headers: adminHeaders });
    const assignedUser = listedUsers.body.users.find((user) => user.username === "boundary-user");
    assert.ok(assignedUser);
    const removed = await request(baseUrl, `/api/admin/users/${assignedUser.id}/tasks/task_demo_001`, { method: "DELETE", headers: adminHeaders });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.deepEqual(removed.body.user.assignedTaskIds, []);
    const inaccessible = await request(baseUrl, "/api/workspace", { headers });
    assert.deepEqual(inaccessible.body.tasks, []);
    const invalidAssignment = await request(baseUrl, `/api/admin/users/${assignedUser.id}/tasks`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ taskId: "task_missing" }) });
    assert.equal(invalidAssignment.status, 404);
    assert.equal(invalidAssignment.body.error, "TASK_NOT_FOUND");
    const restored = await request(baseUrl, `/api/admin/users/${assignedUser.id}/tasks`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ taskId: "task_demo_001" }) });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.user.assignedTaskIds, ["task_demo_001"]);

    const first = await request(baseUrl, "/api/tasks", { method: "POST", headers, body: JSON.stringify({ name: "boundary-a", targetType: "website", url: "https://example.com" }) });
    const second = await request(baseUrl, "/api/tasks", { method: "POST", headers, body: JSON.stringify({ name: "boundary-b", targetType: "website", url: "https://example.org" }) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const foreignConnector = second.body.task.target.connectorId;
    const crossTask = await request(baseUrl, "/api/connectors/test", {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: first.body.task.id, connectorId: foreignConnector }),
    });
    assert.equal(crossTask.status, 403);
    assert.equal(crossTask.body.error, "CONNECTOR_TASK_MISMATCH");

    const credential = await request(baseUrl, "/api/connectors/test", {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: first.body.task.id, connectorId: first.body.task.target.connectorId, username: "boundary-account", password: "boundary-password" }),
    });
    assert.equal(credential.status, 200);
    assert.ok(credential.body.credentialRef);

    const changed = await request(baseUrl, "/api/connectors/test", {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: first.body.task.id, type: "website", url: "https://example.net" }),
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.loginStatus, "adapter_review_required");

    const workspace = await request(baseUrl, "/api/workspace", { headers });
    assert.deepEqual(workspace.body.events, []);
    const updated = workspace.body.tasks.find((task) => task.id === first.body.task.id);
    assert.equal(updated.target.url, "https://example.net/");
    assert.equal(updated.target.credentialRef, "");
    assert.equal(updated.target.credentialStatus, "未配置");
    assert.equal(updated.target.accountLabel, "未配置");

    const passwordChanged = await request(baseUrl, `/api/admin/users/${assignedUser.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ password: "boundary-user-new-pass" }) });
    assert.equal(passwordChanged.status, 200);
    const oldSession = await request(baseUrl, "/api/user/session", { headers });
    assert.equal(oldSession.status, 401);
    const oldPasswordLogin = await request(baseUrl, "/api/user/login", { method: "POST", body: JSON.stringify({ username: "boundary-user", password: "boundary-user-pass" }) });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await request(baseUrl, "/api/user/login", { method: "POST", body: JSON.stringify({ username: "boundary-user", password: "boundary-user-new-pass" }) });
    assert.equal(newPasswordLogin.status, 200);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
