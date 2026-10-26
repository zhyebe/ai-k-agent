const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { _electron } = require("playwright");

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-v1-smoke-"));
  await fs.writeFile(path.join(directory, "connection.json"), JSON.stringify({ apiBaseUrl: "http://old-cloud.invalid" }));
  let modelCalls = 0;
  const model = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer smoke-local-key");
    modelCalls++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, AXIOM_USER_DATA_DIR: directory, AXIOM_API_URL: "http://old-cloud.invalid", DB_MODE: "mysql", MYSQL_URL: "mysql://invalid@127.0.0.1:1/invalid" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const errors = [];
  const launch = async () => {
    const executablePath = process.env.AXIOM_DESKTOP_EXECUTABLE;
    app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [path.join(__dirname, "..")], env, timeout: 30000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.getByText("单机模式 · v1.0.0", { exact: true }).waitFor();
    await page.getByRole("button", { name: "连接器", exact: true }).first().waitFor();
    return page;
  };
  try {
    let page = await launch();
    await page.getByRole("heading", { name: "配置 AI，开始使用" }).waitFor();
    const firstBase = await page.evaluate(() => window.axiomDesktop.apiBaseUrl);
    assert.match(firstBase, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await page.locator("#user-login-title").count(), 0);
    assert.equal(await page.getByRole("button", { name: "退出桌面端" }).count(), 0);
    await page.evaluate(() => { localStorage.setItem("axiom.user.token", "expired-cloud-token"); sessionStorage.setItem("axiom.admin.token", "old-admin-token"); });
    await page.reload();
    await page.getByRole("heading", { name: "配置 AI，开始使用" }).waitFor();
    await page.getByRole("button", { name: "配置 AI", exact: true }).last().click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("名称", { exact: true }).fill("Standalone AI");
    await modal.getByLabel("接口根地址", { exact: true }).fill(`http://127.0.0.1:${model.address().port}/v1`);
    await modal.getByLabel("默认模型", { exact: true }).fill("smoke-model");
    await modal.getByLabel("协议").selectOption("chat");
    await modal.getByLabel("API Key", { exact: true }).fill("smoke-local-key");
    await modal.getByRole("button", { name: "保存配置", exact: true }).click();
    await modal.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "连接器", exact: true }).first().click();
    const provider = page.locator(".provider-row").filter({ hasText: "Standalone AI" });
    const verificationResponse = page.waitForResponse(response => /\/providers\/[^/]+\/test$/.test(response.url()));
    await provider.getByRole("button", { name: "验证", exact: true }).click();
    const verification = await (await verificationResponse).json();
    assert.equal(verification.verification?.ok, true, JSON.stringify(verification));
    await provider.getByText("模型可用", { exact: true }).waitFor();
    assert.equal(modelCalls, 1, "model call travels through the actual desktop runtime");
    await app.close(); app = null;
    const snapshot = await fs.readFile(path.join(directory, "standalone", "workspace.json"), "utf8");
    assert.doesNotMatch(snapshot, /smoke-local-key/);
    page = await launch();
    await page.getByRole("button", { name: "连接器", exact: true }).first().click();
    const restored = page.locator(".provider-row").filter({ hasText: "Standalone AI" });
    await restored.getByRole("button", { name: "使用中", exact: true }).waitFor();
    await restored.getByRole("button", { name: "验证", exact: true }).click();
    await page.getByText(/模型已返回推理结果/).waitFor();
    assert.equal(modelCalls, 2, "encrypted key remains usable after restart");
    const screenshot = process.env.AXIOM_SMOKE_SCREENSHOT || path.join(os.tmpdir(), "axiom-v1-standalone.png");
    await page.screenshot({ path: screenshot });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, packaged: await app.evaluate(({ app }) => app.isPackaged), version: "1.0.0", modelCalls, screenshot }));
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      console.error(await page.locator("body").innerText());
    }
    throw error;
  } finally {
    await app?.close();
    await new Promise(resolve => model.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
