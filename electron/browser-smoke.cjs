const path = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function inspectBrowser({ app }, input) {
  const root = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.join(__dirname, "..");
  const runtime = require("./browser-runtime.cjs");
  const browser = await import(pathToFileURL(path.join(root, "server", "browser.mjs")).href);
  const { parseHaohanOrderBook } = await import(pathToFileURL(path.join(root, "server", "haohan.mjs")).href);
  const controller = new AbortController();
  const call = (method, data) => runtime.executeBrowserCall(app, { id: `smoke-${method}`, method, userId: "smoke-user", input: data, deadlineAt: Date.now() + 45000 }, "https://api.example.test", controller.signal);
  try {
    const opened = await call("openMarketBrowser", { task: { id: "fixture", target: { url: input.url } }, connector: {} });
    if (!opened.ok) throw new Error(opened.message);
    const ids = browser.browserSessionIds();
    const page = await browser.getBrowserPage(ids[0]);
    const orderBook = parseHaohanOrderBook(opened.visibleText);
    const sessionId = "task:fixture";
    const manual = await call("fillSuggestionForm", { sessionId, action: "BUY", price: 20, quantity: 1 });
    const manualBeforeClick = await page.evaluate(() => window.entries.length);
    await page.locator('input[type="button"][value="买入订立"]').click();
    await page.locator(".el-message-box").waitFor();
    const continued = await call("continueManualEntry", { sessionId, action: "BUY" });
    const entry = await call("submitSuggestionForm", { sessionId, confirmationId: "smoke-entry", action: "SELL", price: 20, quantity: 1 });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    const exit = await call("submitSuggestionForm", { sessionId, confirmationId: "smoke-exit", action: "SELL", price: 21, quantity: 3, orderType: "LIMIT", exitType: "TAKE_PROFIT", targetPositionIds: ["P-1", "P-2"] });
    if (!exit.ok) throw new Error(JSON.stringify(exit));
    const { entries, exits } = await page.evaluate(() => ({ entries: window.entries, exits: window.exits }));
    await page.screenshot({ path: input.screenshot });
    const closed = await call("closeBrowserSession", { sessionId: "task:fixture" });
    return { packaged: app.isPackaged, mode: opened.mode, title: opened.title, orderBook, manualFilled: manual.filled, manualBeforeClick, manualContinued: continued.continued, entries, exits, sessions: ids.length, closed, remainingSessions: browser.browserSessionIds().length };
  } finally {
    await runtime.closeBrowserRuntime();
  }
};
