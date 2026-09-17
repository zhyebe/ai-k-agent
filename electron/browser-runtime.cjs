const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let modulesPromise;
const activeSessions = new Map();
const launchingSessions = new Set();
const queues = new Map();
const confirmations = new Set();
const collectedMarkets = new Map();

function runtimeRoot(app) {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.join(__dirname, "..");
}

async function loadModules(app) {
  if (!modulesPromise) {
    const root = runtimeRoot(app);
    modulesPromise = Promise.all(["browser", "market", "tools", "analysis-context"].map((name) => import(pathToFileURL(path.join(root, "server", `${name}.mjs`)).href)))
      .then(([browser, market, tools, analysis]) => {
        browser.setBrowserSessionFactory(async (sessionId) => {
          if (activeSessions.size + launchingSessions.size >= 4) throw new Error("DESKTOP_BROWSER_SESSION_LIMIT");
          launchingSessions.add(sessionId);
          try {
            const { _electron } = require(app.isPackaged ? path.join(root, "node_modules", "playwright") : "playwright");
            const profile = path.join(app.getPath("userData"), "browser-profiles", sessionId);
            fs.mkdirSync(profile, { recursive: true });
            browser.cleanupStaleChromiumProfileLocks(profile);
            const env = { ...process.env, AXIOM_BROWSER_HOST: "1", AXIOM_BROWSER_PROFILE: profile, AXIOM_BROWSER_PARENT_PID: String(process.pid) };
            delete env.ELECTRON_RUN_AS_NODE;
            const host = await _electron.launch({ executablePath: process.execPath, args: [path.join(root, "electron", "browser-host.cjs")], env, timeout: 20000 });
            const page = await host.firstWindow({ timeout: 15000 }).catch(async (error) => { await host.close(); throw error; });
            activeSessions.set(sessionId, host);
            host.on("close", () => { activeSessions.delete(sessionId); collectedMarkets.delete(sessionId); });
            return {
              context: host.context(), page, ownsBrowser: false, mode: "desktop-embedded",
              close: async () => { activeSessions.delete(sessionId); collectedMarkets.delete(sessionId); await host.close(); },
            };
          } finally {
            launchingSessions.delete(sessionId);
          }
        });
        return { browser, market, tools, analysis };
      });
  }
  return modulesPromise;
}

function scopedSession(message, apiBaseUrl) {
  const input = message.input || {};
  const sessionId = input.sessionId || input.task?.target?.browserSessionId || `task:${input.task?.id}`;
  return crypto.createHash("sha256").update(`${apiBaseUrl}\n${message.userId}\n${sessionId}`).digest("hex").slice(0, 32);
}

async function executeBrowserCall(app, message, apiBaseUrl, signal) {
  if (!message.userId) throw new Error("DESKTOP_BROWSER_USER_REQUIRED");
  const sessionId = scopedSession(message, apiBaseUrl);
  const previous = queues.get(sessionId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    if (Date.now() >= message.deadlineAt) throw new Error("DESKTOP_BROWSER_CALL_EXPIRED");
    const { browser, market, tools, analysis } = await loadModules(app);
    signal.throwIfAborted();
    const input = { ...message.input, sessionId };
    const abort = () => { browser.closeBrowserSession(sessionId).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (message.method === "openMarketBrowser" || message.method === "observeMarket") {
        const task = { ...input.task, target: { ...input.task?.target, browserSessionId: sessionId } };
        const result = await market[message.method](task, input.connector);
        // The public session ID stays stable across desktop installs and reconnects.
        if (result.sessionId) result.sessionId = input.task?.target?.browserSessionId || `task:${input.task?.id}`;
        if (input.show && activeSessions.has(sessionId)) {
          await activeSessions.get(sessionId).evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); } });
        }
        if (message.method === "observeMarket" && result.ok) {
          const compact = analysis.compactCollectedMarket(result);
          collectedMarkets.set(sessionId, compact);
          return compact;
        }
        return result;
      }
      if (message.method === "browserLogin") return await tools.browserLoginWithCredential(input, message.credential);
      if (message.method === "browserLoginStatus") return await tools.browserLoginStatus(input);
      if (message.method === "fillSuggestionForm") return await tools.fillSuggestionForm(input);
      if (message.method === "readTradeControls") return await tools.readTradeControls(input);
      if (message.method === "closeBrowserSession") return await browser.closeBrowserSession(sessionId);
      if (message.method === "submitSuggestionForm") {
        if (!input.confirmationId) throw new Error("TRADE_CONFIRMATION_REQUIRED");
        const key = `${sessionId}:${input.confirmationId}`;
        if (confirmations.has(key)) throw new Error("TRADE_CONFIRMATION_ALREADY_USED");
        if (confirmations.size >= 10000) throw new Error("TRADE_CONFIRMATION_LIMIT");
        const result = await tools.submitSuggestionForm(input);
        if (result?.ok && result?.submitted) confirmations.add(key);
        return result;
      }
      throw new Error("BROWSER_METHOD_UNKNOWN");
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) await browser.closeBrowserSession(sessionId);
    }
  });
  queues.set(sessionId, operation);
  try { return await operation; }
  finally { if (queues.get(sessionId) === operation) queues.delete(sessionId); }
}

async function closeBrowserRuntime() {
  if (modulesPromise) {
    const { browser } = await modulesPromise;
    await browser.closeAllBrowserSessions();
    modulesPromise = null;
  }
  queues.clear();
  collectedMarkets.clear();
}

function getCollectedMarket(marketRef, apiBaseUrl, userId) {
  const sessionId = scopedSession({ userId, input: { sessionId: marketRef?.sessionId } }, apiBaseUrl);
  const market = collectedMarkets.get(sessionId);
  if (!market || market.fingerprint !== marketRef?.fingerprint) throw new Error("DESKTOP_MARKET_SNAPSHOT_EXPIRED");
  return market;
}

module.exports = { executeBrowserCall, closeBrowserRuntime, getCollectedMarket };
