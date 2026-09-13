const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "axiom browser 中文 "));
  const executablePath = process.env.AXIOM_DESKTOP_EXECUTABLE;
  const screenshot = path.join(process.env.AXIOM_SMOKE_OUTPUT || os.tmpdir(), "axiom-client-browser-smoke.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<html><head><title>Desktop browser fixture</title></head><body style="background:#101820;color:white"><h1>Desktop browser fixture</h1><table><tr><td>销售①</td><td>101</td><td>20</td></tr><tr><td>采购①</td><td>100</td><td>30</td></tr></table></body></html>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let host;
  try {
    const env = { ...process.env, AXIOM_BROWSER_HOST: "1", AXIOM_BROWSER_SMOKE: "1", AXIOM_BROWSER_PROFILE: profile, AXIOM_BROWSER_PARENT_PID: String(process.pid) };
    delete env.ELECTRON_RUN_AS_NODE;
    host = await _electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : [path.join(__dirname, "..", "electron", "browser-host.cjs")],
      env,
      timeout: 30000,
    });
    await host.firstWindow();
    const result = await host.evaluate((electron, input) => globalThis.axiomBrowserSmoke(electron, input), { url: `http://127.0.0.1:${server.address().port}`, screenshot });
    assert.equal(result.packaged, Boolean(executablePath));
    assert.equal(result.mode, "desktop-embedded");
    assert.equal(result.title, "Desktop browser fixture");
    assert.equal(result.orderBook.bids[0].price, 100);
    assert.equal(result.orderBook.asks[0].price, 101);
    assert.equal(result.sessions, 1);
    assert.equal(result.closed, true);
    assert.equal(result.remainingSessions, 0);
    console.log(JSON.stringify({ ok: true, platform: process.platform, ...result, screenshot }));
  } finally {
    await host?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

const deadline = setTimeout(() => { console.error("DESKTOP_SMOKE_TIMEOUT"); process.exit(1); }, 90000);
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
