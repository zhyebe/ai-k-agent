const path = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function inspectBrowser({ app }, input) {
  const root = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : path.join(__dirname, "..");
  const runtime = require("./browser-runtime.cjs");
  const browser = await import(pathToFileURL(path.join(root, "server", "browser.mjs")).href);
  const { parseHaohanOrderBook } = await import(pathToFileURL(path.join(root, "server", "haohan.mjs")).href);
  const { createProvider } = await import(pathToFileURL(path.join(root, "server", "provider.mjs")).href);
  const { summaryExitCandidates } = await import(pathToFileURL(path.join(root, "server", "summary-exit-policy.mjs")).href);
  const controller = new AbortController();
  const call = (method, data, credential) => runtime.executeBrowserCall(app, { id: `smoke-${method}`, method, userId: "smoke-user", input: data, credential, deadlineAt: Date.now() + 45000 }, "https://api.example.test", controller.signal);
  try {
    const opened = await call("openMarketBrowser", { task: { id: "fixture", target: { url: input.url } }, connector: {} });
    if (!opened.ok) throw new Error(opened.message);
    const ids = browser.browserSessionIds();
    const page = await browser.getBrowserPage(ids[0]);
    const orderBook = parseHaohanOrderBook(opened.visibleText);
    const sessionId = "task:fixture";
    const targetUrl = "https://smyw.haohandahan.cn/client/#/transcc";
    const html = await fetch(input.url).then(response => response.text());
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
    await page.goto(targetUrl);
    const prepareAccount = (holding = false, orders = false) => page.evaluate(({ holding, orders }) => {
      window.smokePositions ??= document.querySelector("#positions tbody").innerHTML;
      window.smokeOrders ??= document.querySelector("#orders tbody").innerHTML;
      document.querySelector("#positions tbody").innerHTML = holding ? window.smokePositions : '<tr><td colspan="6">暂无数据</td></tr>';
      document.querySelector("#orders tbody").innerHTML = orders ? window.smokeOrders : '<tr><td colspan="11">暂无数据</td></tr>';
      let summary = document.querySelector("#summary");
      if (!summary) {
        summary = document.createElement("section"); summary.id = "summary"; summary.style.display = "none";
        document.body.append(summary);
        const tab = document.createElement("div"); tab.className = "head_l_btns"; tab.textContent = "持仓汇总";
        tab.onclick = () => orderPane("summary"); document.body.append(tab);
        window.orderPane = name => {
          if (name === "history") window.historyVisits++;
          for (const id of ["positions", "orders", "history", "summary"]) document.getElementById(id).style.display = id === name ? "" : "none";
        };
      }
      window.summaryExits ??= [];
      summary.innerHTML = '<table><thead><tr><th>商品名称</th><th>买 | 卖</th><th>订立均价</th><th>存货数量</th><th>委托冻结数量</th><th>转让</th></tr></thead><tbody>'
        + (holding ? '<tr><td>测试商品</td><td>买入</td><td>99</td><td>3</td><td>0</td><td><span class="spotS" onclick="summaryTransfer(\'LONG\',3)">转让</span></td></tr><tr><td>测试商品</td><td>卖出</td><td>102</td><td>1</td><td>0</td><td><span class="spotS" onclick="summaryTransfer(\'SHORT\',1)">转让</span></td></tr>' : '<tr><td colspan="6">暂无数据</td></tr>') + '</tbody></table>';
      window.summaryTransfer = (side, quantity) => setTimeout(() => {
        const box = document.createElement("div"); box.className = "el-dialog";
        box.innerHTML = '<div>转让 测试商品</div><div class="inputWrap"><p>转让价格</p><input type="number" value="19"></div><div class="inputWrap"><p>转让数量</p><input type="number" disabled value="' + quantity + '"></div><button>确 定</button><button>取 消</button>';
        box.querySelector("button").onclick = () => {
          window.summaryExits.push({ side, price: box.querySelector("input").value, quantity: box.querySelectorAll("input")[1].value });
          box.remove(); notice("转让成功");
        };
        box.querySelectorAll("button")[1].onclick = () => box.remove(); document.body.append(box);
      }, 500);
    }, { holding, orders });
    const transferSummaries = async (confirmationPrefix, browserProvider) => {
      for (const side of ["LONG", "SHORT"]) {
        await page.evaluate(() => window.redrawNextControl(".el-dialog button"));
        const summary = { symbol: "DGKZ", symbolName: "测试商品", side, quantity: side === "LONG" ? 3 : 1, averagePrice: side === "LONG" ? 99 : 102, frozenQuantity: 0 };
        const market = { symbol: "DGKZ", observedAt: new Date().toISOString(), account: { positionSummariesVerified: true, positionSummaries: [summary] }, orderBook };
        const candidate = summaryExitCandidates({}, market)[0];
        if (!candidate) throw new Error(`SMOKE_SUMMARY_EXIT_MISSING:${side}`);
        const result = await call("submitSuggestionForm", { sessionId, confirmationId: `${confirmationPrefix}-${side}`, ...candidate.decision, symbol: "DGKZ", symbolName: "测试商品", quantity: summary.quantity, browserProvider });
        if (!result.ok) throw new Error(JSON.stringify({ side, ...result }));
      }
    };
    await prepareAccount();
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
    await prepareAccount(true, true);
    await transferSummaries("smoke-summary");
    const { entries, exits, detailExits } = await page.evaluate(() => ({ entries: window.entries, exits: window.summaryExits, detailExits: window.exits }));
    const controls = await call("browserScanControls", { sessionId });
    if (!controls.ok || controls.controls.some(control => /历史委托/.test(control.label))) throw new Error("SMOKE_HISTORY_CONTROL_EXPOSED");
    const cancellation = await call("cancelOpenOrders", { sessionId, orderIds: ["O-1"] });
    if (!cancellation.ok) throw new Error(JSON.stringify(cancellation));
    await page.evaluate(() => { window.silentCancellation = true; });
    const unverifiedCancellation = await call("cancelOpenOrders", { sessionId, orderIds: ["O-10"] });
    const historyVisits = await page.evaluate(() => window.historyVisits);
    // Exercise the shipped Electron/Playwright runtime while Windows hides or
    // minimizes the trade window, including model-unavailable execution and
    // the real final price/position guard. All requests stay on a local fixture.
    const browserProvider = createProvider({ baseUrl: `${input.url}/v1`, model: "offline-fixture", apiKey: "synthetic-key" });
    const background = [];
    for (const state of ["minimized", "hidden"]) {
      await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
      await page.reload();
      await prepareAccount();
      await runtime.setSmokeWindowState(state);
      const observationStartedAt = Date.now();
      const observed = await call("observeExecutionMarket", {
        task: { id: "fixture", symbol: "DGKZ", timeframe: "1m", target: { browserSessionId: sessionId } },
        connector: { reviewStatus: "APPROVED", adapterId: "haohan-readonly", capabilities: ["read_visible_market"] },
      });
      const observationVerified = observed.account?.positionsVerified && observed.account?.positionSummariesVerified && observed.account?.openOrdersVerified;
      if (!observed.ok || !observationVerified) throw new Error(JSON.stringify({ state, phase: "observe-before-trade", durationMs: Date.now() - observationStartedAt, ...observed }));
      for (const action of ["BUY", "SELL"]) {
        await page.evaluate(() => window.redrawNextControl(".el-message-box button"));
        const result = await call("submitSuggestionForm", { sessionId, confirmationId: `smoke-${state}-${action}`, action, price: 100, quantity: 1, browserProvider });
        if (!result.ok) throw new Error(JSON.stringify({ state, action, ...result }));
      }
      await prepareAccount(true);
      await transferSummaries(`smoke-${state}`, browserProvider);
      background.push({ state, observationVerified, windowsAfter: await runtime.setSmokeWindowState("inspect"), ...await page.evaluate(() => ({ entries: window.entries, exits: window.summaryExits, detailExits: window.exits, historyVisits: window.historyVisits, controlRedraws: window.controlRedraws })) });
    }
    const loginHtml = await fetch(`${input.url}/login-fixture`).then(response => response.text());
    await page.unroute("https://smyw.haohandahan.cn/client/**");
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: loginHtml }));
    const logins = [];
    for (const state of ["visible", "minimized", "hidden"]) {
      await page.goto(targetUrl.replace("transcc", "login"));
      await page.reload();
      await runtime.setSmokeWindowState(state);
      const result = await call("browserLogin", { sessionId, adapterId: "haohan-readonly", targetUrl, browserProvider },
        { username: "fixture", password: "fixture-password", target: { url: targetUrl } });
      if (!result.ok || !result.authenticated) throw new Error(JSON.stringify({ state, phase: "login", ...result }));
      logins.push({ state, authenticated: result.authenticated, url: page.url(), ...await page.evaluate(() => ({
        attempts: window.loginAttempts, agreementChanges: window.agreementChanges, documentOpens: window.documentOpens, redraws: window.redraws,
      })) });
    }
    await runtime.setSmokeWindowState("visible");
    await page.screenshot({ path: input.screenshot });
    const closed = await call("closeBrowserSession", { sessionId: "task:fixture" });
    return { packaged: app.isPackaged, mode: opened.mode, title: opened.title, orderBook, manualFilled: manual.filled, manualBeforeClick, manualContinued: continued.continued, entries, exits, detailExits, cancellation, unverifiedCancellation, historyVisits, background, logins, sessions: ids.length, closed, remainingSessions: browser.browserSessionIds().length };
  } finally {
    await runtime.closeBrowserRuntime();
  }
};
