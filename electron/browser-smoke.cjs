const path = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function inspectBrowser({ app }, input) {
  const root = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.join(__dirname, "..");
  const runtime = require("./browser-runtime.cjs");
  const browser = await import(pathToFileURL(path.join(root, "server", "browser.mjs")).href);
  const { parseHaohanOrderBook } = await import(pathToFileURL(path.join(root, "server", "haohan.mjs")).href);
  const { createProvider } = await import(pathToFileURL(path.join(root, "server", "provider.mjs")).href);
  const { positionProfitExit } = await import(pathToFileURL(path.join(root, "server", "exit-policy.mjs")).href);
  const controller = new AbortController();
  const call = (method, data) => runtime.executeBrowserCall(app, { id: `smoke-${method}`, method, userId: "smoke-user", input: data, deadlineAt: Date.now() + 45000 }, "https://api.example.test", controller.signal);
  try {
    const opened = await call("openMarketBrowser", { task: { id: "fixture", target: { url: input.url } }, connector: {} });
    if (!opened.ok) throw new Error(opened.message);
    const ids = browser.browserSessionIds();
    const page = await browser.getBrowserPage(ids[0]);
    const orderBook = parseHaohanOrderBook(opened.visibleText);
    const sessionId = "task:fixture";
    await page.evaluate(() => {
      const wrapper = document.createElement("div");
      for (const node of [...document.body.children]) wrapper.append(node);
      document.body.append(wrapper);
      pane("transfer");
      const buy = document.querySelector("#buy");
      const fields = [...buy.querySelectorAll("li")];
      fields.forEach(field => field.remove());
      setTimeout(() => fields.reverse().forEach(field => buy.prepend(field)), 1200);
    });
    const manual = await call("fillSuggestionForm", { sessionId, action: "BUY", price: 20, quantity: 1 });
    if (!manual.ok) throw new Error(JSON.stringify(manual));
    const manualBeforeClick = await page.evaluate(() => window.entries.length);
    await page.locator('input[type="button"][value="买入订立"]').click();
    await page.locator(".el-message-box").waitFor();
    const continued = await call("continueManualEntry", { sessionId, action: "BUY" });
    const entry = await call("submitSuggestionForm", { sessionId, confirmationId: "smoke-entry", action: "SELL", price: 20, quantity: 1 });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    const exit = await call("submitSuggestionForm", { sessionId, confirmationId: "smoke-exit", action: "SELL", price: 21, quantity: 3, orderType: "LIMIT", exitType: "TAKE_PROFIT", targetPositionIds: ["P-1", "P-2"] });
    if (!exit.ok) throw new Error(JSON.stringify(exit));
    const { entries, exits } = await page.evaluate(() => ({ entries: window.entries, exits: window.exits }));
    // Exercise the shipped Electron/Playwright runtime while Windows hides or
    // minimizes the trade window, including model-unavailable execution and
    // the real final price/position guard. All requests stay on a local fixture.
    const html = await fetch(input.url).then(response => response.text());
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>')
      .replace('value="19"', 'value="100"').replace("value='19.5'", "value='100'") }));
    const browserProvider = createProvider({ baseUrl: `${input.url}/v1`, model: "offline-fixture", apiKey: "synthetic-key" });
    const background = [];
    for (const state of ["minimized", "hidden"]) {
      await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
      await page.reload();
      await runtime.setSmokeWindowState(state);
      for (const action of ["BUY", "SELL"]) {
        const result = await call("submitSuggestionForm", { sessionId, confirmationId: `smoke-${state}-${action}`, action, price: 100, quantity: 1, browserProvider });
        if (!result.ok) throw new Error(JSON.stringify({ state, action, ...result }));
      }
      await page.evaluate(() => {
        const th = document.createElement("th"); th.textContent = "订单价格";
        document.querySelector("#positions thead tr").append(th);
        for (const row of document.querySelectorAll("#positions tbody tr")) {
          const td = document.createElement("td"); td.textContent = row.cells[1].textContent === "买入" ? "98" : "103"; row.append(td);
        }
      });
      for (const side of ["LONG", "SHORT"]) {
        const position = { positionOrderId: side === "LONG" ? "P-1" : "P-10", symbol: "DGKZ", symbolName: "测试商品", side, quantity: side === "LONG" ? 2 : 1, orderPrice: side === "LONG" ? 98 : 103 };
        const market = { symbol: "DGKZ", observedAt: new Date().toISOString(), account: { positionsVerified: true }, orderBook };
        const candidate = positionProfitExit(position, market);
        if (!candidate) throw new Error(`SMOKE_EXIT_GUARD_MISSING:${side}`);
        const result = await call("submitSuggestionForm", { sessionId, confirmationId: `smoke-${state}-${side}`, ...candidate.decision, symbol: "DGKZ", symbolName: "测试商品", quantity: position.quantity, browserProvider });
        if (!result.ok) throw new Error(JSON.stringify({ state, side, ...result }));
      }
      background.push({ state, windowsAfter: await runtime.setSmokeWindowState("inspect"), ...await page.evaluate(() => ({ entries: window.entries, exits: window.exits })) });
    }
    await runtime.setSmokeWindowState("visible");
    await page.screenshot({ path: input.screenshot });
    const closed = await call("closeBrowserSession", { sessionId: "task:fixture" });
    return { packaged: app.isPackaged, mode: opened.mode, title: opened.title, orderBook, manualFilled: manual.filled, manualBeforeClick, manualContinued: continued.continued, entries, exits, background, sessions: ids.length, closed, remainingSessions: browser.browserSessionIds().length };
  } finally {
    await runtime.closeBrowserRuntime();
  }
};
