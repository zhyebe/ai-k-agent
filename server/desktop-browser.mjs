import { invokeDesktopAi } from "./desktop-ai.mjs";
import { openMarketBrowser, observeMarket, observeExecutionMarket } from "./market.mjs";
import { browserLogin, browserLoginStatus, browserScanControls, cancelOpenOrders, continueManualEntry, fillSuggestionForm, readTradeControls, submitSuggestionForm } from "./tools.mjs";
import { closeBrowserSession } from "./browser.mjs";
import { getCredential } from "./vault.mjs";

export function desktopBrowserRequired() {
  return process.env.AXIOM_REQUIRE_DESKTOP_BROWSER === "1";
}

const methods = { openMarketBrowser, observeMarket, observeExecutionMarket, browserLogin, browserLoginStatus, browserScanControls, cancelOpenOrders, continueManualEntry, fillSuggestionForm, readTradeControls, submitSuggestionForm, closeBrowserSession };

export async function callBrowserMethod(method, userId, input = {}, options = {}) {
  if (!Object.hasOwn(methods, method)) throw new Error("BROWSER_METHOD_UNKNOWN");
  if (!desktopBrowserRequired()) {
    if (["openMarketBrowser", "observeMarket", "observeExecutionMarket"].includes(method)) return methods[method](input.task, input.connector, options);
    if (method === "closeBrowserSession") return closeBrowserSession(input.sessionId);
    return methods[method](input);
  }
  if (!userId) throw new Error("DESKTOP_BROWSER_USER_REQUIRED");
  let credential;
  if (method === "browserLogin") {
    credential = getCredential(input.credentialRef, { ownerUserId: String(userId) });
    if (!credential) throw new Error("CREDENTIAL_REF_NOT_FOUND");
  }
  const observationStartedMs = Date.now();
  const observationStartedAt = new Date(observationStartedMs).toISOString();
  const browserProvider = input.provider || input.browserProvider || null;
  const { provider: _provider, browserProvider: _browserProvider, ...safeInput } = input;
  const browserInput = {
    ...safeInput,
    ...(method === "observeMarket" ? { serverObservedAt: observationStartedAt } : {}),
  };
  if (input.task) {
    const task = input.task;
    browserInput.task = { id: task.id, symbol: task.symbol, timeframe: task.timeframe, target: task.target, exitObservationIndex: task.exitObservationIndex };
  }
  const { signal, ...callOptions } = options || {};
  // Browser runtime may run on a different machine or have a skewed clock.
  // Keep a server-side start stamp as the conservative age bound for every
  // read-only market snapshot, not only the fast exit snapshot. Otherwise a
  // valid model response can be rejected as expired solely because the
  // desktop timestamp is old/future or the browser call spent time in queue.
  const result = await invokeDesktopAi(userId, method, {
    channel: "browser",
    requiredCapability: input.targetSummary || method === "observeExecutionMarket" ? "browser-summary-exit-v1" : "",
    input: browserInput,
    provider: browserProvider,
    credential: credential ? { username: credential.username, password: credential.password, target: credential.target } : undefined,
    signal,
    options: { timeoutMs: method === "observeMarket" || method === "browserLogin" ? 120000 : 45000, ...callOptions },
  });
  if (!["observeMarket", "observeExecutionMarket"].includes(method) || !result?.ok) return result;
  // These methods always read the live DOM during this call. Use server-side
  // start as a conservative age bound, including queue/network time, instead
  // of comparing clocks on two machines. Never renew a cached analysis
  // snapshot. Preserve original desktop time for diagnostics.
  const callAgeSec = Number(((Date.now() - observationStartedMs) / 1000).toFixed(2));
  const stamp = (book) => ({
    ...book,
    desktopObservedAt: book.observedAt || null,
    observedAt: observationStartedAt,
    // Client freshness uses the client clock and is therefore not comparable
    // with server time. The elapsed call age is a conservative upper bound:
    // the live DOM is read after this call starts.
    freshnessSec: callAgeSec,
  });
  return { ...stamp(result), books: (result.books || []).map(stamp) };
}
