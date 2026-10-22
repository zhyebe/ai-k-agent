const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright");

async function main() {
  const { refreshingTradeFixture: tradeFixture } = await import("../tests/fixtures/trade-page.mjs");
  const { loginFixture } = await import("../tests/fixtures/login-page.mjs");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "axiom browser 中文 "));
  const executablePath = process.env.AXIOM_DESKTOP_EXECUTABLE;
  const screenshot = path.join(process.env.AXIOM_SMOKE_OUTPUT || os.tmpdir(), "axiom-client-browser-smoke.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  let modelRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/v1")) {
      modelRequests++;
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"offline model fixture"}');
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/login-fixture" ? loginFixture : tradeFixture);
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
    assert.equal(result.title, "Trade controls fixture");
    assert.equal(result.manualFilled, true);
    assert.equal(result.manualBeforeClick, 0);
    assert.equal(result.manualContinued, true);
    assert.deepEqual(result.entries.map((item) => item.side), ["BUY", "SELL"]);
    assert.deepEqual(result.exits, [{ id: "P-1", price: "21", quantity: "2" }, { id: "P-2", price: "21", quantity: "1" }]);
    assert.equal(result.cancellation.results[0].code, "ORDER_CANCELLED");
    assert.equal(result.unverifiedCancellation.results[0].code, "ORDER_CANCEL_UNVERIFIED");
    assert.equal(result.unverifiedCancellation.results[0].cancelled, false);
    assert.equal(result.historyVisits, 0);
    assert.deepEqual(result.background.map(item => item.state), ["minimized", "hidden"]);
    for (const item of result.background) {
      assert.equal(item.observationVerified, true);
      assert.equal(item.controlRedraws, 4, "entry and exit confirmations survive a DOM replacement without duplicate clicks");
      assert.ok(item.windowsAfter.length > 0);
      assert.ok(item.windowsAfter.every(window => !window.minimized && window.visible), "execution restores the browser surface before Playwright actions");
      assert.deepEqual(item.entries.map(entry => entry.side), ["BUY", "SELL"]);
      assert.deepEqual(item.exits, [{ id: "P-1", price: "100", quantity: "2" }, { id: "P-10", price: "100", quantity: "1" }]);
      assert.equal(item.historyVisits, 0);
    }
    assert.equal(result.orderBook.bids[0].price, 100);
    assert.equal(modelRequests, 0, "known login and trade controls must not depend on model availability");
    assert.deepEqual(result.logins.map(item => item.state), ["visible", "minimized", "hidden"]);
    for (const login of result.logins) {
      assert.equal(login.authenticated, true);
      assert.match(login.url, /#\/transcc$/);
      assert.equal(login.attempts, 1);
      assert.equal(login.agreementChanges, 1);
      assert.equal(login.documentOpens, 0);
      assert.equal(login.redraws, 2);
    }
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
