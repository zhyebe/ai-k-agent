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
    await page.screenshot({ path: input.screenshot });
    const orderBook = parseHaohanOrderBook(opened.visibleText);
    const closed = await call("closeBrowserSession", { sessionId: "task:fixture" });
    return { packaged: app.isPackaged, mode: opened.mode, title: opened.title, orderBook, sessions: ids.length, closed, remainingSessions: browser.browserSessionIds().length };
  } finally {
    await runtime.closeBrowserRuntime();
  }
};
