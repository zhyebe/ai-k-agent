import assert from "node:assert/strict";
import http from "node:http";
import test, { after, afterEach, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, readVisiblePage, resolveSnapshotControl, scanBrowserPage, setBrowserSessionFactory } from "../server/browser.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { browserExtract, cancelOpenOrders, continueManualEntry as submitManualEntry, fillSuggestionForm, isOrderCancellationResponse, readTradeControls, submitSuggestionForm as submitNativeEntry } from "../server/tools.mjs";
import { createProvider } from "../server/provider.mjs";

import { positionProfitExit } from "../server/exit-policy.mjs";

import { tradeFixture, refreshingTradeFixture, redrawNextControl, clearTradingAccount } from "./fixtures/trade-page.mjs";
import { observeExecutionMarket } from "../server/market.mjs";
import { activateTradeControl, completeTradeDialogs, fillTradeFields, findPositionRows } from "../server/trade-controls.mjs";

async function submitSuggestionForm(input) { await clearTradingAccount(page); return submitNativeEntry(input); }
async function continueManualEntry(input) { await clearTradingAccount(page); return submitManualEntry(input); }

let browser;
let page;
before(async () => {
  browser = await chromium.launch({ ...(process.platform === "darwin" ? { channel: "chrome" } : {}), headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route("https://smyw.haohandahan.cn/client/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture }));
  setBrowserSessionFactory(async () => ({ browser, context, page, ownsBrowser: false, mode: "test" }));
  await openBrowserPage({ sessionId: "trade-fixture", url: "https://smyw.haohandahan.cn/client/#/transcc", waitMs: 0 });
});
after(async () => {
  await closeAllBrowserSessions();
  setBrowserSessionFactory(null);
  await browser?.close();
});
afterEach(async () => {
  assert.equal(await page.evaluate(() => window.historyVisits), 0, "automation must never open historical orders");
});

test("confirmation replaced during quote verification is rescanned and verified again before one click", async () => {
  await page.reload();
  await page.evaluate(() => transfer("P-1", 2));
  let checks = 0;
  const result = await completeTradeDialogs(page, { exitType: "TAKE_PROFIT", orderType: "LIMIT", price: 21,
    canConfirm: async () => {
      checks++;
      if (checks === 1) await page.locator(".el-dialog button").first().evaluate(node => {
        const replacement = node.cloneNode(true);
        replacement.removeAttribute("data-axiom-control");
        replacement.onclick = node.onclick;
        node.replaceWith(replacement);
      });
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(checks, 2);
  assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
});

test("a reordered holding keeps its exact identity instead of clicking the old row index", async () => {
  await page.reload();
  const [target] = await findPositionRows(page, { targetPositionIds: ["P-1"], action: "SELL" });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("#positions tbody tr")].find(row => row.cells[3].textContent === "P-1");
    row.parentElement.prepend(row);
    window.transfer = id => { window.openedPosition = id; };
  });
  await target.row.locator("span").first().click();
  assert.equal(await page.evaluate(() => window.openedPosition), "P-1");
});

for (const action of ["BUY", "SELL"]) {
  test(`live ${action} entry does not wait for another AI request when controls are verified`, async () => {
    await page.reload();
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests++;
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"message":"browser planner unavailable"}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = createProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture", apiKey: "key" });
    try {
      const result = await submitSuggestionForm({ sessionId: "trade-fixture", action, price: 101, quantity: 2, browserProvider: provider });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(await page.evaluate(() => window.entries), [{ side: action, price: "101", quantity: "2" }]);
      assert.equal(requests, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test("delayed entry fields on a Page wait for rendering without calling Locator.page", async () => {
  await page.reload();
  await page.evaluate(() => {
    const buy = document.querySelector("#buy");
    const fields = [...buy.querySelectorAll("li")];
    fields.forEach(field => field.remove());
    setTimeout(() => fields.reverse().forEach(field => buy.prepend(field)), 650);
  });
  const result = await fillSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 101, quantity: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await page.locator("#buy-price").inputValue(), "101");
  assert.equal(await page.locator("#buy-qty").inputValue(), "2");
  assert.deepEqual(await page.evaluate(() => window.entries), []);
});

test("nested page wrappers do not intercept side and entry tab selection", async () => {
  await page.reload();
  await page.evaluate(() => {
    const wrapper = document.createElement("div");
    for (const node of [...document.body.children]) wrapper.append(node);
    document.body.append(wrapper);
    pane("transfer");
  });
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", price: 100, quantity: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.entries), [{ side: "SELL", price: "100", quantity: "1" }]);
});

test("missing entry fields return a field diagnostic without a page interface crash", async () => {
  await page.reload();
  await page.locator("#buy-qty").evaluate(node => node.remove());
  const result = await fillSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 101, quantity: 2 });
  assert.equal(result.code, "FORM_FIELDS_NOT_FOUND", JSON.stringify(result));
  assert.equal(result.submitted, false);
});

test("AI snapshot fills updated trade fields after old classes and labels disappear", async () => {
  await page.reload();
  await page.evaluate(() => {
    document.querySelectorAll(".trade_btn, .tab_btn").forEach((node) => node.remove());
    document.querySelector("#buy").innerHTML = '<label>限价<input name="limit_price" placeholder="当前价格" type="number"></label><label>手数<input name="lots" placeholder="下单数量" type="number"></label><label><input type="checkbox">接受交易协议</label>';
  });
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const context = JSON.parse(payload.messages.at(-1).content).context;
    const controls = context.page.controls;
    const priceControl = controls.find((control) => control.placeholder === "当前价格");
    const quantityControl = controls.find((control) => control.placeholder === "下单数量");
    const consent = controls.find((control) => control.role === "checkbox");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ goal: context.goal, actions: [
      { type: "fill", field: "price", controlId: priceControl.id, label: priceControl.label },
      { type: "fill", field: "quantity", controlId: quantityControl.id, label: quantityControl.label },
      { type: "accept_agreement", field: "consent", controlId: consent.id, label: consent.label },
    ] }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const provider = createProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fixture", apiKey: "key" });
  try {
    const result = await fillSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 101, quantity: 2, browserProvider: provider });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await page.locator('input[name="limit_price"]').inputValue(), "101");
    assert.equal(await page.locator('input[name="lots"]').inputValue(), "2");
    assert.equal(await page.locator('input[name="lots"]').evaluate(() => document.querySelector('#buy input[type="checkbox"]').checked), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("missing side tab never clicks a submit button with a partially matching label", async () => {
  await page.reload();
  await page.evaluate(() => {
    document.querySelectorAll(".trade_btn, .tab_btn").forEach(node => node.remove());
    const button = document.createElement("button");
    button.textContent = "买入订立";
    button.onclick = () => { window.unexpectedSubmit = true; };
    document.body.prepend(button);
  });
  assert.equal(await activateTradeControl(page, "买入"), false);
  assert.equal(await page.evaluate(() => Boolean(window.unexpectedSubmit)), false);
});

test("dialog scope waits for delayed fields using its explicit Page", async () => {
  await page.reload();
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.id = "delayed-dialog";
    document.body.append(box);
    setTimeout(() => { box.innerHTML = '<label>转让价格<input type="number"></label>'; }, 650);
  });
  const fields = await fillTradeFields(page, [{ labels: ["转让价格"], value: 102 }], page.locator("#delayed-dialog"));
  assert.deepEqual(fields, ["转让价格"]);
  assert.equal(await page.locator("#delayed-dialog input").inputValue(), "102");
  assert.equal(await page.locator("#buy-price").inputValue(), "");
});

test("shared field containers keep explicit labels bound to their own inputs", async () => {
  await page.reload();
  await page.evaluate(() => {
    document.querySelector("#buy").innerHTML = '<div><label for="price">买价</label><input id="price"><label for="quantity">买量</label><input id="quantity"></div>';
  });
  const fields = await fillTradeFields(page, [{ labels: ["买价"], value: 101 }, { labels: ["买量"], value: 2 }]);
  assert.deepEqual(fields, ["买价", "买量"]);
  assert.equal(await page.locator("#price").inputValue(), "101");
  assert.equal(await page.locator("#quantity").inputValue(), "2");
});

test("replaced fields are resolved again without filling another input by stale index", async () => {
  await page.reload();
  await page.evaluate(() => {
    const field = document.querySelector("#buy-price");
    const observer = new MutationObserver(() => {
      observer.disconnect();
      const replacement = field.cloneNode(true);
      delete replacement.dataset.axiomControl;
      field.replaceWith(replacement);
      const unrelated = document.createElement("input");
      unrelated.id = "unrelated-field";
      unrelated.value = "unchanged";
      document.body.prepend(unrelated);
    });
    observer.observe(field, { attributes: true, attributeFilter: ["data-axiom-control"] });
  });
  const fields = await fillTradeFields(page, [{ labels: ["买价"], value: 102 }]);
  assert.deepEqual(fields, ["买价"]);
  assert.equal(await page.locator("#buy-price").inputValue(), "102");
  assert.equal(await page.locator("#unrelated-field").inputValue(), "unchanged");
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

test("Element UI row redraw and hidden checkbox still cancel only the exact selected order", async () => {
  await page.setContent(refreshingTradeFixture);
  page.setDefaultTimeout(2000);
  try {
    const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "O-1", remaining: 2 }]);
    assert.ok(await page.evaluate(() => window.selectionRefreshes) >= 2);
    assert.ok(await page.evaluate(() => window.trustedSelections) >= 2);
    assert.equal(await page.evaluate(() => window.emptySelectionRefreshes), 0, "select the target before clearing other rows");
    assert.equal(await page.evaluate(() => window.wrongCancelAll), 0);
  } finally { page.setDefaultTimeout(30000); }
});

test("a numeric order ID matching another column still selects the exact ID column", async () => {
  await page.reload();
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#orders tbody tr");
    rows[0].cells[4].textContent = "123456";
    rows[1].cells[1].textContent = "123456";
  });
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["123456"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.cancelled), [{ id: "123456", remaining: 2 }]);
});

for (const scenario of ["cancelRejected", "fillDuringCancel", "silentCancellation"]) {
  test(`cancellation truthfully verifies ${scenario}`, async () => {
    await page.reload();
    await page.evaluate((name) => { window[name] = true; }, scenario);
    const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
    assert.equal(result.results[0].code, scenario === "cancelRejected" ? "ORDER_CANCEL_REJECTED" : scenario === "fillDuringCancel" ? "ORDER_ALREADY_FILLED" : "ORDER_CANCEL_UNVERIFIED", JSON.stringify(result));
    assert.equal(result.results[0].cancelled, false);
  });
}

for (const [name, responseId, code, expected] of [
  ["silent success", "O-1", "0", "ORDER_CANCELLED"],
  ["silent rejection", "O-1", "12", "ORDER_CANCEL_REJECTED"],
  ["another order response", "O-10", "0", "ORDER_CANCEL_UNVERIFIED"],
]) test(`cancellation verifies the exact browser request: ${name}`, async () => {
  await page.reload();
  const url = "https://smyw.haohandahan.cn/qtfront_tq/intraday-trade/trade/cancel";
  await page.route(url, route => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code, message: "fixture result" }) }));
  await page.evaluate(({ url, responseId }) => {
    window.cancelSelected = () => {
      const box = document.createElement("div"); box.className = "el-dialog";
      box.innerHTML = "您确定要撤单吗?<button>确认</button><button>取消</button>";
      box.querySelector("button").onclick = () => {
        box.remove();
        fetch(url, { method: "POST", body: JSON.stringify({ orderId: responseId }) }).then(response => response.json()).then(body => {
          if (String(body.code) === "0") {
            [...document.querySelectorAll("#orders tbody tr")].find(row => row.cells[1].textContent === responseId)?.remove();
          }
        });
      };
      document.body.append(box);
    };
  }, { url, responseId });
  try {
    const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
    assert.equal(result.results[0].code, expected, JSON.stringify(result));
    assert.equal(result.results[0].cancelled, expected === "ORDER_CANCELLED");
    if (responseId === "O-1") assert.equal(result.results[0].source, "browser_response");
  } finally { await page.unroute(url); }
});

test("missing exact order never cancels an order with a similar ID", async () => {
  await page.reload();
  const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-100"] });
  assert.equal(result.results[0].code, "ORDER_NO_LONGER_OPEN");
  assert.deepEqual(await page.evaluate(() => window.cancelled), []);
});

test("unfinished cancellation dialog is dismissed automatically and a later attempt can complete", async () => {
  await page.reload();
  await page.evaluate(() => {
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

test("historical-order controls are excluded from AI snapshots and rejected at execution", async () => {
  await page.reload();
  const snapshot = await scanBrowserPage(page);
  assert.equal(snapshot.controls.some(control => /历史委托/.test(control.label)), false);
  assert.equal(await activateTradeControl(page, "历史委托"), false);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".head_l_btns")].find(node => node.textContent === "历史委托");
    tab.dataset.axiomControl = "stale-history-control";
  });
  assert.equal(await resolveSnapshotControl(page, "stale-history-control"), null);
});

for (const scan of ["visible", "controls"]) for (const currentAvailable of [true, false]) {
  test(`${scan} scan ${currentAvailable ? "leaves" : "rejects"} an already-open history pane before reading account data`, async () => {
    await page.reload();
    await page.evaluate(() => {
      document.querySelector("#positions").style.display = "none";
      const history = document.querySelector("#history");
      history.style.display = "";
      const root = document.createElement("div");
      root.id = "hisPage";
      root.append(...history.childNodes);
      history.append(root);
      root.querySelector("tbody").innerHTML = '<tr><td>HISTORICAL-ORDER-SECRET</td></tr>';
    });
    if (!currentAvailable) await page.getByText("当前委托", { exact: true }).evaluate(node => node.remove());
    const snapshot = scan === "visible" ? await readVisiblePage("trade-fixture", { quick: true }) : await scanBrowserPage(page);
    assert.equal(snapshot.ok, currentAvailable, JSON.stringify(snapshot));
    assert.equal(JSON.stringify(snapshot).includes("HISTORICAL-ORDER-SECRET"), false);
    assert.equal(await page.locator("#orders").isVisible(), currentAvailable);
  });
}

test("text extraction cannot read the hidden historical-order panel by selector", async () => {
  await page.reload();
  await page.evaluate(() => {
    const root = document.createElement("div");
    root.id = "hisPage";
    root.textContent = "HISTORICAL-ORDER-SECRET";
    document.querySelector("#history").append(root);
  });
  const snapshot = await browserExtract({ sessionId: "trade-fixture", selector: "#hisPage" });
  assert.equal(snapshot.code, "HISTORICAL_ORDERS_DISABLED");
  assert.equal(JSON.stringify(snapshot).includes("HISTORICAL-ORDER-SECRET"), false);
});

for (const status of ["已撤单", "部分成交后撤单", "已成交"]) {
  test(`cancellation reads terminal status ${status} only from the current order row`, async () => {
    await page.reload();
    await page.evaluate(status => {
      const original = window.cancelSelected;
      window.cancelSelected = () => {
        const row = [...document.querySelectorAll("#orders tbody tr")].find(row => row.querySelector("input").checked);
        original();
        const box = document.querySelector(".el-dialog");
        box.querySelector("button").onclick = () => {
          row.cells[9].textContent = status;
          row.cells[8].textContent = "0";
          box.remove();
        };
      };
    }, status);
    const result = await cancelOpenOrders({ sessionId: "trade-fixture", orderIds: ["O-1"] });
    assert.equal(result.results[0].code, status === "已成交" ? "ORDER_ALREADY_FILLED" : "ORDER_CANCELLED", JSON.stringify(result));
    assert.equal(result.results[0].cancelled, status !== "已成交");
  });
}

test("cancellation waits for the result when confirmation closes before the request finishes", async () => {
  await page.reload();
  await page.evaluate(() => {
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

test("snapshot budget keeps the current dialog and exact target row before other controls", async () => {
  await page.reload();
  await page.evaluate(() => {
    const navigation = document.createElement("nav");
    navigation.innerHTML = '<button>导航</button>'.repeat(150);
    document.body.prepend(navigation);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = '<button>确认转让</button>';
    document.body.append(dialog);
  });
  const snapshot = await scanBrowserPage(page, { maxControls: 3, targetPositionIds: ["P-1"] });
  assert.equal(snapshot.controls.length, 3);
  assert.equal(snapshot.controls[0].label, "确认转让");
  assert.ok(snapshot.controls.some(control => control.label === "转让" && control.rowText?.split(/\s+/).includes("P-1")));
  assert.equal(snapshot.controls.some(control => control.rowText?.split(/\s+/).includes("P-10")), false);
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

test("fast observations rotate held instruments without collecting stale quotes for every board", async () => {
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture.replace('<body>', '<body><div id="instrument">DGKZ | 测试商品</div><div>最新价 100</div><ul><li role="option" onclick="document.querySelector(\'#instrument\').textContent=\'DGKZ | 测试商品\'">测试商品</li><li role="option" onclick="document.querySelector(\'#instrument\').textContent=\'DGJJ | 第二商品\'">第二商品</li></ul>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  await page.reload();
  await page.evaluate(() => { document.querySelector("#positions tbody tr:last-child td").textContent = "第二商品"; });
  const connector = { adapterId: "haohan-readonly", reviewStatus: "APPROVED", capabilities: ["read_visible_market"] };
  const task = { target: { browserSessionId: "trade-fixture" } };
  for (const [index, symbol] of [[0, "DGKZ"], [1, "DGJJ"], [2, "DGKZ"]]) {
    const observed = await observeExecutionMarket({ ...task, exitObservationIndex: index }, connector);
    assert.equal(observed.ok, true);
    assert.equal(observed.account.positions.length, 3);
    assert.equal(observed.books.length, 1, JSON.stringify({ index, symbol: observed.symbol, symbolName: observed.symbolName, positions: observed.account.positions, summaries: observed.account.positionSummaries, instrument: await page.locator("#instrument").textContent() }));
    assert.equal(observed.books[0].symbol, symbol);
    assert.ok(Date.now() - Date.parse(observed.books[0].observedAt) < 5000);
  }
  const targeted = await observeExecutionMarket({ ...task, exitObservationIndex: 0 }, connector, { accountScope: "positions", target: { symbol: "DGJJ", symbolName: "第二商品" } });
  assert.equal(targeted.books[0].symbol, "DGJJ", "an immediate AI exit must read its own target, not the rotation's next board");
});

test("fast observations collect chart evidence and confirm a stable K without a page reload", async t => {
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  await page.reload();
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
    assert.equal(market.history.at(-1)?.confirmation?.status, second === 56 ? "CONFIRMED" : "PROVISIONAL");
  }
});
