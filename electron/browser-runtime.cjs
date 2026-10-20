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

function browserOperationPriority(method) {
  if (["browserLogin", "browserLoginStatus", "browserScanControls", "submitSuggestionForm", "cancelOpenOrders", "continueManualEntry", "fillSuggestionForm"].includes(method)) return 100;
  if (["observeExecutionMarket", "readTradeControls"].includes(method)) return 80;
  if (method === "openMarketBrowser") return 40;
  return 10;
}

function enqueueSessionOperation(sessionId, method, signal, deadlineAt, operation) {
  let state = queues.get(sessionId);
  if (!state || typeof state !== "object" || !Array.isArray(state.pending)) {
    state = { running: false, sequence: 0, pending: [] };
    queues.set(sessionId, state);
  }
  const job = { method, signal, deadlineAt, operation, priority: browserOperationPriority(method), sequence: state.sequence++ };
  const result = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  const removeOnAbort = () => {
    if (job.started) return;
    const index = state.pending.indexOf(job);
    if (index >= 0) {
      state.pending.splice(index, 1);
      job.reject(signal.reason || new Error("DESKTOP_BROWSER_CALL_CANCELLED"));
    }
  };
  signal.addEventListener("abort", removeOnAbort, { once: true });
  state.pending.push(job);
  state.pending.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
  const drain = async () => {
    if (state.running) return;
    state.running = true;
    try {
      while (state.pending.length) {
        const next = state.pending.shift();
        if (next.signal.aborted) {
          next.reject(next.signal.reason || new Error("DESKTOP_BROWSER_CALL_CANCELLED"));
          continue;
        }
        next.started = true;
        try { next.resolve(await next.operation()); }
        catch (error) { next.reject(error); }
        finally { next.signal.removeEventListener("abort", removeOnAbort); }
      }
    } finally {
      state.running = false;
      if (!state.pending.length && queues.get(sessionId) === state) queues.delete(sessionId);
    }
  };
  drain().catch((error) => { if (!job.started) job.reject(error); });
  return result;
}

async function executeBrowserCall(app, message, apiBaseUrl, signal) {
  if (!message.userId) throw new Error("DESKTOP_BROWSER_USER_REQUIRED");
  const sessionId = scopedSession(message, apiBaseUrl);
  const withBrowser = async (operation) => {
    return enqueueSessionOperation(sessionId, message.method, signal, message.deadlineAt, async () => {
      signal.throwIfAborted();
      if (Date.now() >= message.deadlineAt) throw new Error("DESKTOP_BROWSER_CALL_EXPIRED");
      return operation();
    });
  };
  const execute = async () => {
    signal.throwIfAborted();
    if (Date.now() >= message.deadlineAt) throw new Error("DESKTOP_BROWSER_CALL_EXPIRED");
    const { browser, market, tools, analysis } = await loadModules(app);
    signal.throwIfAborted();
    const input = { ...message.input, sessionId, ...(message.provider ? { browserProvider: message.provider } : {}) };
    const shouldCloseOnAbort = () => !(["openMarketBrowser", "observeMarket", "observeExecutionMarket", "readTradeControls", "browserLoginStatus"].includes(message.method)
      && ["DESKTOP_DISCONNECTED", "DESKTOP_RECONNECTED"].includes(signal.reason?.message));
    const abort = () => { if (shouldCloseOnAbort()) browser.closeBrowserSession(sessionId).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (["openMarketBrowser", "observeMarket", "observeExecutionMarket"].includes(message.method)) {
        const task = { ...input.task, target: { ...input.task?.target, browserSessionId: sessionId } };
        const result = await market[message.method](task, input.connector, { ...(message.options || {}), withBrowser });
        signal.throwIfAborted();
        // The public session ID stays stable across desktop installs and reconnects.
        if (result.sessionId) result.sessionId = input.task?.target?.browserSessionId || `task:${input.task?.id}`;
        if (input.show && activeSessions.has(sessionId)) {
          await activeSessions.get(sessionId).evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); } });
        }
        if (message.method === "observeMarket" && result.ok) {
          const compact = analysis.compactCollectedMarket(result);
          // The API server owns decision validity. Pass its call-start stamp
          // through the desktop runtime so client clock skew cannot make the
          // next AI result appear older/newer than the snapshot used.
          if (message.input?.serverObservedAt) compact.observedAt = message.input.serverObservedAt;
          collectedMarkets.set(sessionId, compact);
          return compact;
        }
        return result;
      }
      if (message.method === "browserLogin") return await tools.browserLoginWithCredential(input, message.credential);
      if (message.method === "browserLoginStatus") return await tools.browserLoginStatus(input);
      if (message.method === "browserScanControls") return await tools.browserScanControls(input);
      if (message.method === "fillSuggestionForm") return await tools.fillSuggestionForm(input);
      if (message.method === "continueManualEntry") return await tools.continueManualEntry(input);
      if (message.method === "readTradeControls") return await tools.readTradeControls(input);
      if (message.method === "cancelOpenOrders") return await tools.cancelOpenOrders(input);
      if (message.method === "closeBrowserSession") return await browser.closeBrowserSession(sessionId);
      if (message.method === "submitSuggestionForm") {
        if (!input.confirmationId) throw new Error("TRADE_CONFIRMATION_REQUIRED");
        const key = `${sessionId}:${input.confirmationId}`;
        if (confirmations.has(key)) throw new Error("TRADE_CONFIRMATION_ALREADY_USED");
        if (confirmations.size >= 10000) throw new Error("TRADE_CONFIRMATION_LIMIT");
        const result = await tools.submitSuggestionForm(input);
        if (!signal.aborted && result?.ok && result?.submitted) confirmations.add(key);
        return result;
      }
      throw new Error("BROWSER_METHOD_UNKNOWN");
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted && shouldCloseOnAbort()) await browser.closeBrowserSession(sessionId);
    }
  };
  // Only DOM phases of full collection need the same-session queue. Its slow
  // read-only history requests must leave room for position/exit observations.
  return message.method === "observeMarket" ? execute() : withBrowser(execute);
}

async function closeBrowserRuntime() {
  try {
    if (modulesPromise) {
      const { browser } = await modulesPromise;
      await browser.closeAllBrowserSessions();
      modulesPromise = null;
    }
  } finally {
    queues.clear();
    collectedMarkets.clear();
    confirmations.clear();
  }
}

function getCollectedMarket(marketRef, apiBaseUrl, userId) {
  const sessionId = scopedSession({ userId, input: { sessionId: marketRef?.sessionId } }, apiBaseUrl);
  const market = collectedMarkets.get(sessionId);
  if (!market || market.fingerprint !== marketRef?.fingerprint) throw new Error("DESKTOP_MARKET_SNAPSHOT_EXPIRED");
  // The API server is the authority for snapshot age. Rebind the cached
  // desktop copy to its server-side observation metadata before AI analysis.
  if (marketRef?.observedAt) market.observedAt = marketRef.observedAt;
  if (Number.isFinite(Number(marketRef?.freshnessSec))) market.freshnessSec = Number(marketRef.freshnessSec);
  return market;
}

module.exports = { executeBrowserCall, closeBrowserRuntime, getCollectedMarket };
