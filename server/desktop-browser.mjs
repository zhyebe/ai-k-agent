import { invokeDesktopAi } from "./desktop-ai.mjs";
import { openMarketBrowser, observeMarket, observeExecutionMarket } from "./market.mjs";
import { browserLogin, browserLoginStatus, cancelOpenOrders, continueManualEntry, fillSuggestionForm, readTradeControls, submitSuggestionForm } from "./tools.mjs";
import { closeBrowserSession } from "./browser.mjs";
import { getCredential } from "./vault.mjs";

export function desktopBrowserRequired() {
  return process.env.AXIOM_REQUIRE_DESKTOP_BROWSER === "1";
}

const methods = { openMarketBrowser, observeMarket, observeExecutionMarket, browserLogin, browserLoginStatus, cancelOpenOrders, continueManualEntry, fillSuggestionForm, readTradeControls, submitSuggestionForm, closeBrowserSession };

export async function callBrowserMethod(method, userId, input = {}, options = {}) {
  if (!Object.hasOwn(methods, method)) throw new Error("BROWSER_METHOD_UNKNOWN");
  if (!desktopBrowserRequired()) {
    if (["openMarketBrowser", "observeMarket", "observeExecutionMarket"].includes(method)) return methods[method](input.task, input.connector);
    if (method === "closeBrowserSession") return closeBrowserSession(input.sessionId);
    return methods[method](input);
  }
  if (!userId) throw new Error("DESKTOP_BROWSER_USER_REQUIRED");
  let credential;
  if (method === "browserLogin") {
    credential = getCredential(input.credentialRef, { ownerUserId: String(userId) });
    if (!credential) throw new Error("CREDENTIAL_REF_NOT_FOUND");
  }
  const browserInput = { ...input };
  if (input.task) {
    const task = input.task;
    browserInput.task = { id: task.id, symbol: task.symbol, timeframe: task.timeframe, target: task.target, exitObservationIndex: task.exitObservationIndex };
  }
  const { signal, ...callOptions } = options || {};
  return invokeDesktopAi(userId, method, {
    channel: "browser",
    requiredCapability: method === "observeExecutionMarket" ? "browser-exit-v1" : "",
    input: browserInput,
    credential: credential ? { username: credential.username, password: credential.password, target: credential.target } : undefined,
    signal,
    options: { timeoutMs: method === "observeMarket" || method === "browserLogin" ? 120000 : 45000, ...callOptions },
  });
}
