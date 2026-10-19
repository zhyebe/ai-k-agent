import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, readVisiblePage, setBrowserSessionFactory } from "../server/browser.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { cancelOpenOrders, continueManualEntry, fillSuggestionForm, isOrderCancellationResponse, readTradeControls, submitSuggestionForm } from "../server/tools.mjs";

import { tradeFixture } from "./fixtures/trade-page.mjs";
import { observeExecutionMarket } from "../server/market.mjs";

let browser;
let page;
before(async () => {
  browser = await chromium.launch({ ...(process.platform === "darwin" ? { channel: "chrome" } : {}), headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route("http://127.0.0.1/trade-fixture", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture }));
  setBrowserSessionFactory(async () => ({ browser, context, page, ownsBrowser: false, mode: "test" }));
  await openBrowserPage({ sessionId: "trade-fixture", url: "http://127.0.0.1/trade-fixture", waitMs: 0 });
});
after(async () => {
  await closeAllBrowserSessions();
  setBrowserSessionFactory(null);
  await browser?.close();
});

test("collection reads current orders and restores holdings without mixing history", async () => {
  await page.reload();
  const snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true });
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positions.length, 3);
  assert.equal(account.openOrdersVerified, true);
  assert.deepEqual(account.openOrders.map((order) => order.orderId), ["O-10", "O-1", "O-2"]);
  assert.equal(account.openOrders[1].remainingQuantity, 2);
  assert.equal(await page.locator("#positions").isVisible(), true);
});

test("initial empty table waits for Haohan holdings query without a loading mask", async () => {
  await page.reload();
  await page.evaluate(() => {
    const table = document.querySelector("#positions");
    const rows = table.querySelector("tbody").innerHTML;
    table.__vue__ = { pageData: { total: null }, isNetWrong: false };
    const tab = [...document.querySelectorAll(".header_l_item")].find((node) => node.textContent === "持仓明细");
    tab.onclick = () => {
      orderPane("positions");
      table.querySelector("tbody").innerHTML = '<tr><td colspan="6">暂无数据</td></tr>';
      setTimeout(() => { table.querySelector("tbody").innerHTML = rows; table.__vue__.pageData.total = 3; }, 400);
    };
  });
  const snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true, quick: true });
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positionsVerified, true);
  assert.equal(account.positionEmpty, false);
  assert.equal(account.positions.length, 3);
});

test("positions-only reads use the live active tab without remounting current orders", async () => {
  await page.reload();
  await page.evaluate(() => {
    const tab = document.querySelector(".header_l_item");
    tab.classList.add("s");
    window.orderPaneCalls = [];
    const original = window.orderPane;
    window.orderPane = (name) => { window.orderPaneCalls.push(name); original(name); };
  });
  const snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true, quick: true, accountScope: "positions" });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(await page.evaluate(() => window.orderPaneCalls), []);
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positionsVerified, true);
  assert.equal(account.openOrdersVerified, false);
});

test("empty current orders verify emptiness while loading orders stay unverified", async () => {
  await page.reload();
  await page.locator("#orders tbody").evaluate((node) => { node.innerHTML = '<tr><td colspan="11">暂无数据</td></tr>'; });
  let snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true });
  let account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.openOrdersVerified, true);
  assert.equal(account.openOrdersEmpty, true);
  await page.evaluate(() => {
    const mask = document.createElement("div");
    mask.className = "el-loading-mask";
    mask.style.height = "30px";
    mask.textContent = "loading";
    document.querySelector("#orders").append(mask);
  });
  snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true });
  account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.openOrdersVerified, false);
  assert.equal(account.openOrdersEmpty, false);
  assert.equal(account.positionsVerified, true);
});

test("selected-order toolbar cancels exact IDs and partial remainder, never other orders or positions", async () => {
  await page.reload();
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1", "O-10"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-1", remaining: 2 }, { id: "O-10", remaining: 1 }]);
  assert.deepEqual(await page.evaluate(() => window.exits), []);
  assert.equal(await page.evaluate(() => window.wrongCancelAll), 0);
  assert.equal(await page.locator("#orders tbody tr").count(), 1);
});

for (const scenario of ["cancelRejected", "fillDuringCancel", "silentCancellation"]) {
  test(`cancellation truthfully verifies ${scenario}`, async () => {
    await page.reload();
    await page.evaluate((name) => { window[name] = true; }, scenario);
    const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
    assert.equal(result.results[0].code, scenario === "cancelRejected" ? "ORDER_CANCEL_REJECTED" : scenario === "fillDuringCancel" ? "ORDER_ALREADY_FILLED" : "ORDER_CANCELLED", JSON.stringify(result));
    assert.equal(result.results[0].cancelled, scenario === "silentCancellation");
  });
}

test("missing exact order never cancels an order with a similar ID", async () => {
  await page.reload();
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-100"] });
  assert.equal(result.results[0].code, "ORDER_NO_LONGER_OPEN");
  assert.deepEqual(await page.evaluate(() => window.cancelled), []);
});

test("unfinished cancellation dialog is dismissed automatically and a later attempt can complete", async () => {
  await page.reload();
  await page.evaluate(() => {
    document.querySelector("#history table").__vue__ = { pageData: { total: 0 }, isNetWrong: false };
    window.cancelObserver = new MutationObserver(() => {
      const box = document.querySelector(".el-dialog");
      if (!box || box.dataset.testDisabled) return;
      box.dataset.testDisabled = "1";
      box.querySelector("button").disabled = true;
      box.querySelectorAll("button")[1].onclick = () => box.remove();
    });
    window.cancelObserver.observe(document.body, { childList: true });
  });
  const first = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(first.results[0].cancelled, false);
  assert.equal(await page.locator(".el-dialog:visible").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.cancelled), []);
  await page.evaluate(() => window.cancelObserver.disconnect());
  const second = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(second.results[0].cancelled, true);
});

test("silent cancellation is verified across historical-order pages", async () => {
  await page.reload();
  await page.evaluate(() => {
    window.silentCancellation = true;
    const history = document.querySelector("#history");
    history.querySelector("table").__vue__ = { pageData: { total: 1 }, isNetWrong: false };
    const pagination = document.createElement("div");
    pagination.className = "el-pagination";
    pagination.innerHTML = '<button class="btn-prev" disabled>previous</button><ul class="el-pager"><li class="number active">1</li><li class="number">2</li></ul><button class="btn-next">next</button>';
    history.append(pagination);
    const storage = document.createElement("tbody");
    let current = 1;
    const render = () => {
      if (current === 1) storage.append(...history.querySelectorAll("tbody tr"));
      else history.querySelector("tbody").append(...storage.children);
      pagination.querySelector(".btn-prev").disabled = current === 1;
      pagination.querySelector(".btn-next").disabled = current === 2;
      [...pagination.querySelectorAll("li")].forEach((node, index) => node.classList.toggle("active", index === current - 1));
    };
    new MutationObserver(() => { if (current === 1 && history.querySelector("tbody tr")) render(); }).observe(history.querySelector("tbody"), { childList: true });
    pagination.querySelector(".btn-next").onclick = () => { current = 2; render(); };
    pagination.querySelector(".btn-prev").onclick = () => { current = 1; render(); };
  });
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(result.results[0].code, "ORDER_CANCELLED", JSON.stringify(result));
});

test("historical-order verification waits for the query after its empty table mounts", async () => {
  await page.reload();
  await page.evaluate(() => {
    window.silentCancellation = true;
    const table = document.querySelector("#history table");
    table.__vue__ = { pageData: { total: null }, isNetWrong: false };
    const tab = [...document.querySelectorAll(".head_l_btns")].find((node) => node.textContent === "历史委托");
    tab.onclick = () => {
      orderPane("history");
      const rows = [...table.querySelector("tbody").children];
      table.querySelector("tbody").replaceChildren();
      setTimeout(() => {
        table.querySelector("tbody").append(...rows);
        table.__vue__.pageData.total = rows.length;
      }, 600);
    };
  });
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(result.results[0].code, "ORDER_CANCELLED", JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-1", remaining: 2 }]);
});

test("cancellation history queries today when the website initially excludes today's orders", async () => {
  await page.reload();
  const dates = await page.evaluate(() => {
    window.silentCancellation = true;
    window.historyQueries = [];
    const dateString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const today = dateString(new Date());
    const previousDay = new Date();
    previousDay.setDate(previousDay.getDate() - 1);
    const yesterday = dateString(previousDay);
    const section = document.querySelector("#history");
    const table = section.querySelector("table");
    const root = document.createElement("div");
    root.id = "hisPage";
    root.innerHTML = '<div class="el-date-editor--daterange"><input placeholder="开始日期"><input placeholder="结束日期"></div><button>查询</button>';
    section.append(root);
    root.append(table);
    for (const input of root.querySelectorAll("input")) input.value = yesterday;
    table.__vue__ = { pageData: { total: 0 }, tableData: [], isNetWrong: false };
    let rows = [];
    const tab = [...document.querySelectorAll(".head_l_btns")].find((node) => node.textContent === "历史委托");
    tab.onclick = () => {
      orderPane("history");
      rows = [...table.querySelector("tbody").children];
      table.querySelector("tbody").replaceChildren();
    };
    root.querySelector("button").onclick = () => {
      const range = [...root.querySelectorAll("input")].map((input) => input.value);
      window.historyQueries.push(range);
      setTimeout(() => {
        const matching = range[0] <= today && range[1] >= today ? rows : [];
        table.querySelector("tbody").replaceChildren(...matching);
        table.__vue__.tableData = matching;
        table.__vue__.pageData.total = matching.length;
      }, 400);
    };
    return { today, yesterday };
  });
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(result.results[0].code, "ORDER_CANCELLED", JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.historyQueries), [[dates.yesterday, dates.today]]);
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-1", remaining: 2 }]);
});

test("cancellation waits for the result when confirmation closes before the request finishes", async () => {
  await page.reload();
  await page.evaluate(() => {
    document.querySelector("#history table").__vue__ = { pageData: { total: 0 }, isNetWrong: false };
    const original = window.cancelSelected;
    window.cancelSelected = () => {
      original();
      const dialog = document.querySelector(".el-dialog");
      const confirm = dialog.querySelector("button");
      const complete = confirm.onclick;
      confirm.onclick = () => {
        dialog.remove();
        setTimeout(complete, 700);
      };
    };
  });
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
  assert.equal(result.results[0].code, "ORDER_CANCELLED", JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-1", remaining: 2 }]);
});

test("cancellation response matching accepts the production prefix and excludes other writes", () => {
  const base = "https://smyw.haohandahan.cn";
  assert.equal(isOrderCancellationResponse(`${base}/intraday-trade/trade/cancel`, "POST"), true);
  assert.equal(isOrderCancellationResponse(`${base}/qtfront_tq/intraday-trade/trade/cancel`, "POST"), true);
  assert.equal(isOrderCancellationResponse(`${base}/qtfront_tq/intraday-trade/trade/cancelAll`, "POST"), false);
  assert.equal(isOrderCancellationResponse(`${base}/qtfront_tq/intraday-trade/trade/make`, "POST"), false);
  assert.equal(isOrderCancellationResponse(`${base}/qtfront_tq/intraday-trade/trade/cancel`, "GET"), false);
  assert.equal(isOrderCancellationResponse("https://other.example/intraday-trade/trade/cancel", "POST"), false);
});

test("current-order pagination collects every page and locates cancellation by ID", async () => {
  await page.reload();
  await page.evaluate(() => {
    const root = document.querySelector("#orders");
    const rows = [...root.querySelectorAll("tbody tr")];
    const pagination = document.createElement("div");
    pagination.className = "el-pagination";
    pagination.innerHTML = '<button class="btn-prev">previous</button><ul class="el-pager"><li class="number active">1</li><li class="number">2</li><li class="number">3</li></ul><button class="btn-next">next</button>';
    root.append(pagination);
    let current = 3;
    const render = () => {
      root.querySelector("tbody").replaceChildren(rows[current - 1]);
      pagination.querySelector(".btn-prev").disabled = current === 1;
      pagination.querySelector(".btn-next").disabled = current === 3;
      [...pagination.querySelectorAll("li")].forEach((node, index) => node.classList.toggle("active", index === current - 1));
    };
    pagination.querySelector(".btn-prev").onclick = () => { current -= 1; render(); };
    pagination.querySelector(".btn-next").onclick = () => { current += 1; render(); };
    render();
  });
  const snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true });
  assert.deepEqual(parseHaohanAccount(snapshot.visibleText, snapshot.tables).openOrders.map((order) => order.orderId), ["O-10", "O-1", "O-2"]);
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-2"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-2", remaining: 1 }]);
});

test("configured quantity is filled and submitted as entered", async () => {
  await page.reload();
  await fillSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 20, quantity: 3 });
  assert.deepEqual(await page.evaluate(() => window.entries), []);
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 20, quantity: 3 });
  assert.equal(result.ok, true);
  assert.equal((await page.evaluate(() => window.entries))[0].quantity, "3");
});

test("visible input buttons and position span controls are collected", async () => {
  await page.reload();
  const controls = await readTradeControls({ sessionId: "trade-fixture", targetPositionIds: ["P-1"] });
  assert.ok(controls.buttons.some((item) => item.label === "买入订立"));
  assert.ok(controls.rowActions.some((item) => item.label === "转让"));
});

test("manual entry needs exactly one user click; Agent completes website confirmation", async () => {
  await page.reload();
  await fillSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 20, quantity: 1 });
  assert.equal((await continueManualEntry({ sessionId: "trade-fixture", action: "BUY" })).continued, false);
  assert.deepEqual(await page.evaluate(() => window.entries), []);
  await page.locator('input[type="button"][value="买入订立"]').click();
  await page.locator(".el-message-box").waitFor();
  assert.equal((await continueManualEntry({ sessionId: "trade-fixture", action: "BUY" })).continued, true);
  assert.deepEqual(await page.evaluate(() => window.entries), [{ side: "BUY", price: "20", quantity: "1" }]);
});

for (const manual of [true, false]) {
  test(`closing deadline cancels ${manual ? "manual" : "automatic"} entry confirmation before it can submit`, async () => {
    await page.reload();
    const input = { sessionId: "trade-fixture", action: "BUY", price: 20, quantity: 1 };
    let result;
    if (manual) {
      await fillSuggestionForm(input);
      await page.locator('input[type="button"][value="买入订立"]').click();
      await page.locator(".el-message-box").waitFor();
      result = await continueManualEntry({ ...input, entryDeadlineAt: Date.now() - 1 });
    } else {
      result = await submitSuggestionForm({ ...input, entryDeadlineAt: Date.now() + 200 });
    }
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, "SESSION_CLOSING_NO_ENTRY");
    assert.deepEqual(await page.evaluate(() => window.entries), []);
    assert.equal(await page.locator(".el-message-box:visible").count(), 0);
  });
}

for (const action of ["BUY", "SELL"]) {
  test(`${action}: manual fill never submits; automatic click completes delayed confirmation`, async () => {
    await page.reload();
    const input = { sessionId: "trade-fixture", action, price: 20, quantity: 1 };
    const filled = await fillSuggestionForm(input);
    assert.equal(filled.filled, true, JSON.stringify(filled));
    assert.equal(filled.fields.length, 2);
    assert.deepEqual(await page.evaluate(() => window.entries), []);
    const result = await submitSuggestionForm(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.entries), [{ side: action, price: "20", quantity: "1" }]);
    assert.equal(await page.evaluate(() => window.agreementChanges), 1);
  });
}

for (const exitType of ["TAKE_PROFIT", "STOP_LOSS"]) {
  test(`${exitType}: exact row transfer fills delayed dialog, not stop-condition settings`, async () => {
    await page.reload();
    await page.locator("#positions").evaluate((node) => { node.style.display = "none"; });
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType, orderType: "LIMIT", price: 21, quantity: 2, targetPositionIds: ["P-1"], symbolName: "测试商品" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
    assert.equal(await page.evaluate(() => window.wrongStopDialog + window.wrongGlobalExit), 0);
  });
}

test("market exit uses the site's current counterparty price for each target row", async () => {
  await page.reload();
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType: "TAKE_PROFIT", price: 100, quantity: 3, targetPositionIds: ["P-1", "P-2"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "19.5", quantity: "2" }, { id: "P-2", price: "19.5", quantity: "1" }]);
});

test("short positions close through their own row without touching long positions", async () => {
  await page.reload();
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "BUY", exitType: "TAKE_PROFIT", orderType: "LIMIT", price: 19, quantity: 1, targetPositionIds: ["P-10"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-10", price: "19", quantity: "1" }]);
});

test("remaining exits locate position IDs again after a completed row disappears", async () => {
  await page.reload();
  await page.evaluate(() => {
    const originalNotice = window.notice;
    window.notice = (text) => {
      originalNotice(text);
      const completedId = text.replace("转让成功 ", "");
      for (const row of document.querySelectorAll("#positions tbody tr")) {
        if (row.cells[3].textContent === completedId) row.remove();
      }
    };
  });
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType: "STOP_LOSS", quantity: 3, targetPositionIds: ["P-1", "P-2"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await page.evaluate(() => window.exits)).map((item) => item.id), ["P-1", "P-2"]);
});

test("Element UI split header/body tables still identify side, quantity and exact ID", async () => {
  await page.reload();
  await page.locator("#positions").evaluate((table) => {
    const wrapper = document.createElement("div");
    wrapper.className = "el-table";
    table.before(wrapper);
    const header = document.createElement("table");
    header.className = "el-table__header";
    header.append(table.querySelector("thead"));
    wrapper.append(header, table);
  });
  const snapshot = await readVisiblePage("trade-fixture");
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.deepEqual(account.positions.map((item) => item.positionOrderId), ["P-10", "P-1", "P-2"]);
  assert.equal(account.positionsVerified, true);
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType: "STOP_LOSS", quantity: 3, symbolName: "测试商品" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submittedQuantity, 3);
  assert.deepEqual((await page.evaluate(() => window.exits)).map((item) => item.id), ["P-1", "P-2"]);
});

test("another empty table cannot masquerade as empty holdings", async () => {
  await page.reload();
  await page.locator("#positions").evaluate((table) => { table.style.display = "none"; });
  await page.evaluate(() => {
    const empty = document.createElement("table");
    empty.innerHTML = "<tr><th>历史委托</th></tr><tr><td>暂无数据</td></tr>";
    document.body.append(empty);
  });
  const snapshot = await readVisiblePage("trade-fixture");
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positionsVerified, false);
  assert.equal(account.positionEmpty, false);
});

test("a partially unreadable position row cannot verify the holdings snapshot", async () => {
  await page.reload();
  await page.locator("#positions tbody tr").first().locator("td").nth(2).evaluate((cell) => { cell.textContent = "--"; });
  const snapshot = await readVisiblePage("trade-fixture");
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positionsVerified, false);
  assert.equal(account.positionEmpty, false);
});

test("consecutive entries recognize identical new success notices", async () => {
  await page.reload();
  for (const action of ["BUY", "SELL"]) {
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action, price: 20, quantity: 1 });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(await page.evaluate(() => window.entries.length), 2);
});

test("missing position ID does not close a same-symbol position", async () => {
  await page.reload();
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType: "STOP_LOSS", price: 19, quantity: 1, targetPositionIds: ["P-missing"], symbolName: "测试商品" });
  assert.equal(result.ok, false);
  assert.deepEqual(await page.evaluate(() => window.exits), []);
});

test("holdings pagination reads every position and transfers only an exact later-page ID", async () => {
  await page.reload();
  await page.evaluate(() => {
    const root = document.querySelector("#positions"), rows = [...root.querySelectorAll("tbody tr")];
    const pagination = document.createElement("div");
    pagination.className = "el-pagination";
    pagination.innerHTML = '<button class="btn-prev">previous</button><ul class="el-pager"><li class="number">1</li><li class="number">2</li><li class="number active">3</li></ul><button class="btn-next">next</button>';
    root.append(pagination);
    let current = 3;
    const render = () => {
      root.querySelector("tbody").replaceChildren(rows[current - 1]);
      pagination.querySelector(".btn-prev").disabled = current === 1;
      pagination.querySelector(".btn-next").disabled = current === 3;
      [...pagination.querySelectorAll("li")].forEach((node, index) => node.classList.toggle("active", index === current - 1));
    };
    pagination.querySelector(".btn-prev").onclick = () => { current--; render(); };
    pagination.querySelector(".btn-next").onclick = () => { current++; render(); };
    render();
  });
  const snapshot = await readVisiblePage("trade-fixture", { inspectPositions: true, quick: true });
  const account = parseHaohanAccount(snapshot.visibleText, snapshot.tables);
  assert.equal(account.positionsVerified, true);
  assert.deepEqual(account.positions.map(p => p.positionOrderId), ["P-10", "P-1", "P-2"]);
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", exitType: "SCHEDULED_CLOSE", targetPositionIds: ["P-2"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await page.evaluate(() => window.exits)).map(p => p.id), ["P-2"]);
});

test("fast observations rotate held instruments without collecting stale quotes for every board", async () => {
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture.replace('<body>', '<body><div id="instrument">DGKZ | 测试商品</div><div>最新价 100</div><ul><li role="option" onclick="document.querySelector(\'#instrument\').textContent=\'DGKZ | 测试商品\'">测试商品</li><li role="option" onclick="document.querySelector(\'#instrument\').textContent=\'DGJJ | 第二商品\'">第二商品</li></ul>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  await page.evaluate(() => { document.querySelector("#positions tbody tr:last-child td").textContent = "第二商品"; });
  const connector = { adapterId: "haohan-readonly", reviewStatus: "APPROVED", capabilities: ["read_visible_market"] };
  const task = { target: { browserSessionId: "trade-fixture" } };
  for (const [index, symbol] of [[0, "DGKZ"], [1, "DGJJ"], [2, "DGKZ"]]) {
    const observed = await observeExecutionMarket({ ...task, exitObservationIndex: index }, connector);
    assert.equal(observed.ok, true);
    assert.equal(observed.account.positions.length, 3);
    assert.equal(observed.books.length, 1);
    assert.equal(observed.books[0].symbol, symbol);
    assert.ok(Date.now() - Date.parse(observed.books[0].observedAt) < 5000);
  }
  const targeted = await observeExecutionMarket({ ...task, exitObservationIndex: 0 }, connector, { accountScope: "positions", target: { symbol: "DGJJ", symbolName: "第二商品" } });
  assert.equal(targeted.books[0].symbol, "DGJJ", "an immediate AI exit must read its own target, not the rotation's next board");
});

for (const scenario of ["valid", "reversed-quote", "reversed-dialog", "expired", "realtime-valid", "realtime-reversed", "realtime-missing"]) {
  test(`conditional exit verifies ${scenario} at final confirmation without unintended orders`, async () => {
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture.replace('<body>', `<body><div>DGKZ | 测试商品</div><div>最新价 100</div><div id="realtime">${scenario === "realtime-missing" ? "" : "实时货值变化 +2.5元"}</div>`) }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    const startedAt = Date.now();
    const observed = await observeExecutionMarket({ target: { browserSessionId: "trade-fixture" } }, { adapterId: "haohan-readonly", reviewStatus: "APPROVED", capabilities: ["read_visible_market"] });
    assert.equal(observed.account.positions.length, 3);
    assert.equal(observed.account.positionsVerified, true);
    assert.ok(Date.now() - startedAt < 5000, "quick reads must omit slow chart history sampling");
    if (scenario !== "valid") await page.evaluate(name => {
      const original = window.transfer;
      window.transfer = (...args) => {
        original(...args);
        if (name === "realtime-reversed") document.querySelector('#realtime').textContent = '实时货值变化 -1元';
        if (name === "reversed-quote") setTimeout(() => { document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = '18'; }, 350);
        if (name === "reversed-dialog") {
          new MutationObserver(() => {
            const input = document.querySelector('.el-dialog input');
            if (input) { input.value = '18'; setInterval(() => { input.value = '18'; }, 20); }
          }).observe(document.body, { childList: true });
        }
      };
    }, scenario);
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2, exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"], exitGuard: { positionId: "P-1", heldSide: "LONG", quantity: 2, triggerPrice: 19, comparison: "GTE", expiresAt: new Date(Date.now() + (scenario === "expired" ? 600 : 10000)).toISOString(), ...(scenario.startsWith("realtime-") ? { realtimeValueAbove: 1 } : {}) } });
    const valid = ["valid", "realtime-valid"].includes(scenario);
    assert.equal(result.ok, valid, JSON.stringify(result));
    assert.equal((await page.evaluate(() => window.exits)).length, valid ? 1 : 0);
    if (!valid) {
      assert.equal(result.code, "EXIT_CONDITION_CHANGED");
      assert.equal(await page.locator(".el-dialog:visible").count(), 0);
    }
  });
}

for (const scenario of ["position-exact-2", "account-exact-2", "account-reversed", "position-reversed", "cost-changed"]) {
  test(`legacy profit fallback is rejected by final browser confirmation: ${scenario}`, async () => {
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div><div id="realtime">实时货值变化 +2元</div>')
      .replace('value="19"', 'value="100"').replace("value='19.5'", "value='100'") }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    const accountRule = scenario.startsWith("account-");
    const entryPrice = accountRule ? 99.5 : 98;
    await page.evaluate(({ scenario, entryPrice }) => {
      const head = document.createElement("th"); head.textContent = "订单价格";
      document.querySelector("#positions thead tr").append(head);
      for (const row of document.querySelectorAll("#positions tbody tr")) {
        const cell = document.createElement("td"); cell.textContent = String(entryPrice); row.append(cell);
      }
      const original = window.transfer;
      window.transfer = (...args) => {
        original(...args);
        if (scenario === "account-reversed") document.querySelector("#realtime").textContent = "实时货值变化 +1.99元";
        if (scenario === "position-reversed") document.querySelector("body > table tr:nth-child(2) td:nth-child(2)").textContent = "99";
        if (scenario === "cost-changed") document.querySelectorAll("#positions tbody tr")[1].lastChild.textContent = "110";
      };
    }, { scenario, entryPrice });
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2,
      exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"], exitGuard: {
        positionId: "P-1", heldSide: "LONG", quantity: 2, comparison: "GTE", triggerPrice: accountRule ? 99.75 : 100,
        expiresAt: new Date(Date.now() + 10000).toISOString(), profitFallback: { entryPrice, fees: accountRule ? 0.5 : 2, minProfit: accountRule ? 0 : 2 },
        ...(accountRule ? { realtimeValueAtLeast: 2 } : {}),
      } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((await page.evaluate(() => window.exits)).length, 0);
    assert.equal(result.code, "EXIT_CONDITION_CHANGED");
  });
}

for (const scenario of ["valid", "quote-changed", "cost-changed", "side-changed", "dialog-changed"]) {
  test(`explicit AI exit verifies exact holdings and final price: ${scenario}`, async () => {
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>')
      .replace('value="19"', 'value="100"').replace("value='19.5'", "value='100'") }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    await page.evaluate(name => {
      const head = document.createElement("th"); head.textContent = "订单价格";
      document.querySelector("#positions thead tr").append(head);
      for (const row of document.querySelectorAll("#positions tbody tr")) {
        const cell = document.createElement("td"); cell.textContent = "98"; row.append(cell);
      }
      const original = window.transfer;
      window.transfer = (...args) => {
        original(...args);
        if (name === "quote-changed") document.querySelector("body > table tr:nth-child(2) td:nth-child(2)").textContent = "99";
        if (name === "cost-changed") document.querySelectorAll("#positions tbody tr")[1].lastChild.textContent = "99";
        if (name === "side-changed") document.querySelectorAll("#positions tbody tr")[1].children[1].textContent = "卖出";
        if (name === "dialog-changed") new MutationObserver(() => {
          const input = document.querySelector(".el-dialog input");
          if (input) { input.value = "99"; setInterval(() => { input.value = "99"; }, 20); }
        }).observe(document.body, { childList: true });
      };
    }, scenario);
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2,
      exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"], exitGuard: { positions: [{
        positionId: "P-1", heldSide: "LONG", quantity: 2, entryPrice: 98, exitType: "TAKE_PROFIT",
        comparison: "EQ", triggerPrice: 100, expiresAt: new Date(Date.now() + 10000).toISOString(),
      }] } });
    assert.equal(result.ok, scenario === "valid", JSON.stringify(result));
    assert.equal((await page.evaluate(() => window.exits)).length, scenario === "valid" ? 1 : 0);
  });
}

test("fast observations collect chart evidence and confirm a stable K without a page reload", async t => {
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  const minute = Math.floor(Date.now() / 60000) * 60000 + 120000;
  let now = minute + 50000;
  t.mock.method(Date, "now", () => now);
  await page.evaluate(timestamp => {
    const chart = document.createElement("div"); chart.id = "hqchart_kline";
    const row = at => ({ Date: 20261019, timestamp: at, Open: 100, High: 100, Low: 100, Close: 100, Vol: 10 });
    chart.JSChart = { JSChartContainer: { Symbol: "DGKZ", Period: 4, SourceData: { Data: [row(timestamp - 60000), row(timestamp)] } } };
    document.body.append(chart);
  }, minute);
  const task = { timeframe: "1m", target: { browserSessionId: "trade-fixture" } };
  const connector = { adapterId: "haohan-readonly", reviewStatus: "APPROVED", capabilities: ["read_visible_market"] };
  for (const second of [50, 52, 54, 56]) {
    now = minute + second * 1000;
    const market = await observeExecutionMarket(task, connector, { target: { symbol: "DGKZ", symbolName: "测试商品" } });
    assert.equal(market.history.at(-1).confirmation.status, second === 56 ? "CONFIRMED" : "PROVISIONAL");
  }
});
