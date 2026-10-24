import assert from "node:assert/strict";
import http from "node:http";
import test, { after, afterEach, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, readVisiblePage, resolveSnapshotControl, scanBrowserPage, setBrowserSessionFactory } from "../server/browser.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { browserExtract, cancelOpenOrders, continueManualEntry, fillSuggestionForm, isOrderCancellationResponse, readTradeControls, submitSuggestionForm } from "../server/tools.mjs";
import { createProvider } from "../server/provider.mjs";

import { positionProfitExit } from "../server/exit-policy.mjs";

import { tradeFixture, refreshingTradeFixture, redrawNextControl } from "./fixtures/trade-page.mjs";
import { observeExecutionMarket } from "../server/market.mjs";
import { activateTradeControl, completeTradeDialogs, fillTradeFields, findPositionRows } from "../server/trade-controls.mjs";

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
afterEach(async () => {
  assert.equal(await page.evaluate(() => window.historyVisits), 0, "automation must never open historical orders");
});

test("a confirmation redrawn after discovery is reacquired without waiting on its detached token", async t => {
  await page.reload();
  page.setDefaultTimeout(600);
  t.after(() => page.setDefaultTimeout(30000));
  await page.evaluate(redrawNextControl, ".el-dialog button");
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", price: 21, quantity: 2,
    exitType: "TAKE_PROFIT", orderType: "LIMIT", targetPositionIds: ["P-1"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
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

test("native order confirmation is accepted automatically even when it appears after the click", async () => {
  await page.reload();
  await page.evaluate(() => {
    const original = window.enter;
    window.enter = side => {
      setTimeout(() => {
        if (window.confirm("是否确认下单")) original(side);
      }, 150);
    };
  });
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "BUY", price: 101, quantity: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.entries), [{ side: "BUY", price: "101", quantity: "2" }]);
});

test("verified row transfer completes with AI offline and retains the requested limit price", async () => {
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
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", price: 21, quantity: 2,
      exitType: "TAKE_PROFIT", orderType: "LIMIT", targetPositionIds: ["P-1"], browserProvider: provider });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
    assert.equal(requests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const scenario of ["valid", "missing-quote", "disabled-confirm"]) {
  test(`empty transfer price after the site's one-shot initialization: ${scenario}`, async t => {
    t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    await page.evaluate(scenario => {
      window.transfer = (id, quantity) => {
        const box = document.createElement("div");
        box.className = "el-dialog";
        box.style.cssText = "position:fixed;inset:0;background:white;z-index:9999";
        // The site initializes price once, before the websocket quote may arrive.
        // Editable quantity must never be mistaken for a price.
        box.innerHTML = '<div>转让 测试商品</div><label>转让数量<input value="' + quantity + '"></label><label>转让价格<input type="number" value=""></label><button>确 定</button><button>取 消</button>';
        box.querySelector("button").disabled = scenario === "disabled-confirm";
        box.querySelector("button").onclick = () => {
          window.exits.push({ id, price: box.querySelector('[type="number"]').value, quantity });
          box.remove(); notice("转让成功");
        };
        box.querySelectorAll("button")[1].onclick = () => box.remove();
        document.body.append(box);
        if (scenario === "missing-quote") document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = "--";
      };
    }, scenario);
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2,
      exitType: "STOP_LOSS", targetPositionIds: ["P-1"], exitGuard: {
        positionId: "P-1", heldSide: "LONG", quantity: 2, triggerPrice: 101, comparison: "LTE", expiresAt: new Date(Date.now() + 30000).toISOString(),
        rescueRecovery: true,
      } });
    assert.equal(result.ok, scenario === "valid", JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.exits), scenario === "valid" ? [{ id: "P-1", price: "100", quantity: 2 }] : []);
    assert.equal(await page.locator(".el-dialog:visible").count(), 0, "failed dialog must not obstruct the next read or exact-row exit");
    if (scenario !== "valid") {
      assert.ok(result.message.includes(result.code), "report the actual failure instead of generic dialog retries");
      await page.evaluate(() => {
        const original = window.transfer;
        window.transfer = (...args) => { original(...args); document.querySelector(".el-dialog button").disabled = false; };
      });
      // A different exact holding remains operable after cleanup, without a reload.
      const next = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", quantity: 1, price: 100,
        exitType: "STOP_LOSS", orderType: "LIMIT", targetPositionIds: ["P-2"] });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.deepEqual((await page.evaluate(() => window.exits)).map(exit => exit.id), ["P-2"]);
    }
  });
}

test("confirmation sent before a quote reversal stays uncertain and is never clicked twice", async t => {
  t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
    .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  await page.reload();
  await page.evaluate(() => {
    window.transfer = id => {
      const box = document.createElement("div");
      box.className = "el-dialog";
      box.innerHTML = '<div>转让 测试商品</div><label>转让价格<input value="100"></label><button>确定</button><button>取消</button>';
      box.querySelector("button").onclick = () => {
        window.exits.push(id);
        document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = "102";
        // Request may already have reached the venue; no acknowledgement yet.
      };
      box.querySelectorAll("button")[1].onclick = () => box.remove();
      document.body.append(box);
    };
  });
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2,
    exitType: "STOP_LOSS", targetPositionIds: ["P-1"], exitGuard: {
      positionId: "P-1", heldSide: "LONG", quantity: 2, triggerPrice: 101, comparison: "LTE", expiresAt: new Date(Date.now() + 30000).toISOString(),
    } });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.deepEqual(await page.evaluate(() => window.exits), ["P-1"]);
  assert.equal(await page.locator(".el-dialog:visible").count(), 0);
});

test("AI confirmation for an updated immediate dialog still fills the transfer limit", async () => {
  await page.reload();
  await page.evaluate(() => {
    window.transfer = (id, quantity) => {
      const box = document.createElement("div");
      box.className = "el-dialog";
      box.innerHTML = '<div>转让 测试商品</div><label>转让价格<input type="number" value="19"></label><button>确认转让</button>';
      box.querySelector("button").onclick = () => {
        window.exits.push({ id, price: box.querySelector("input").value, quantity: String(quantity) });
        box.remove(); notice("转让成功");
      };
      document.body.append(box);
    };
  });
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const context = JSON.parse(JSON.parse(body).messages.at(-1).content).context;
    requests++;
    const control = context.page.controls.find(control => control.label === "确认转让");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: control ? [
      { type: "click", field: "confirm", controlId: control.id, label: control.label },
    ] : [] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = createProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture", apiKey: "key" });
  try {
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", price: 21, quantity: 2,
      exitType: "TAKE_PROFIT", orderType: "LIMIT", targetPositionIds: ["P-1"], browserProvider: provider });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

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

test("AI snapshot selects the exact custom transfer after class updates and row replacement", async () => {
  await page.reload();
  await page.evaluate(() => {
    for (const node of document.querySelectorAll(".spotS")) {
      const handler = node.onclick;
      node.removeAttribute("onclick");
      node.removeAttribute("class");
      node.style.cursor = "pointer";
      node.addEventListener("click", handler);
      if (node.textContent === "转让") node.textContent = "出让此单";
    }
  });
  const snapshot = await readTradeControls({ sessionId: "trade-fixture", targetPositionIds: ["P-1"] });
  assert.ok(snapshot.snapshotControls.some(control => control.label === "出让此单" && control.rowText?.split(/\s+/).includes("P-1")));
  assert.ok(snapshot.snapshotControls.some(control => control.label === "买入" && control.role === "button"));
  let wrongTarget = true;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const context = JSON.parse(JSON.parse(body).messages.at(-1).content).context;
    const controls = context.page.controls;
    const control = context.goal === "CONFIRM_TRADE"
      ? controls.find(control => /确\s*定/.test(control.label))
      : controls.find(control => control.label === "出让此单" && control.rowText?.split(/\s+/).includes(wrongTarget ? "P-10" : "P-1"));
    if (!wrongTarget && context.goal === "EXIT_TRANSFER") await page.evaluate(() => {
      const row = [...document.querySelectorAll("#positions tbody tr")].find(row => row.cells[3].textContent === "P-1");
      const replacement = row.cloneNode(true);
      replacement.querySelectorAll("[data-axiom-control]").forEach(node => node.removeAttribute("data-axiom-control"));
      replacement.cells[4].querySelector("span").onclick = () => transfer("P-1", 2);
      row.remove(); document.querySelector("#positions tbody").prepend(replacement);
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: control ? [
      { type: "click", field: context.goal === "CONFIRM_TRADE" ? "confirm" : "submit", controlId: control.id, label: control.label },
    ] : [] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = createProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture", apiKey: "key" });
  try {
    const input = { sessionId: "trade-fixture", action: "SELL", price: 21, quantity: 2,
      exitType: "TAKE_PROFIT", orderType: "LIMIT", targetPositionIds: ["P-1"], browserProvider: provider };
    const rejected = await submitSuggestionForm(input);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.code, "EXIT_CONTROL_NOT_FOUND");
    assert.deepEqual(await page.evaluate(() => window.exits), []);
    wrongTarget = false;
    // The live trading page has more than 120 controls before the target row.
    // Navigation must not crowd that row or its confirmation out of the plan.
    await page.evaluate(() => {
      const navigation = document.createElement("nav");
      for (let index = 0; index < 150; index += 1) {
        const button = document.createElement("button");
        button.textContent = `导航 ${index}`;
        button.onclick = () => { window.unexpectedNavigation = true; };
        navigation.append(button);
      }
      document.body.prepend(navigation);
    });
    const crowded = await readTradeControls({ sessionId: "trade-fixture", targetPositionIds: ["P-1"] });
    assert.ok(crowded.snapshotControls.some(control => control.label === "出让此单" && control.rowText?.split(/\s+/).includes("P-1")));
    const result = await submitSuggestionForm(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.submittedQuantity, 2);
    assert.deepEqual(await page.evaluate(() => window.exits), [{ id: "P-1", price: "21", quantity: "2" }]);
    assert.equal(await page.evaluate(() => Boolean(window.unexpectedNavigation)), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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

for (const scenario of ["valid", "break-even", "quote-changed", "cost-changed", "side-changed", "dialog-changed"]) {
  test(`explicit AI exit verifies exact holdings and final price: ${scenario}`, async () => {
    const dialogPrice = scenario === "dialog-changed" ? 99 : 100;
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>')
      .replace('value="19"', `value="${dialogPrice}"`).replace("value='19.5'", `value='${dialogPrice}'`) }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    await page.evaluate(name => {
      const head = document.createElement("th"); head.textContent = "订单价格";
      document.querySelector("#positions thead tr").append(head);
      for (const row of document.querySelectorAll("#positions tbody tr")) {
        const cell = document.createElement("td"); cell.textContent = name === "break-even" ? "100" : "98"; row.append(cell);
      }
      const original = window.transfer;
      window.transfer = (...args) => {
        original(...args);
        if (name === "quote-changed") document.querySelector("body > table tr:nth-child(2) td:nth-child(2)").textContent = "99";
        if (name === "cost-changed") document.querySelectorAll("#positions tbody tr")[1].lastChild.textContent = "99";
        if (name === "side-changed") document.querySelectorAll("#positions tbody tr")[1].children[1].textContent = "卖出";
      };
    }, scenario);
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2,
      exitType: "TAKE_PROFIT", targetPositionIds: ["P-1"], exitGuard: { positions: [{
        positionId: "P-1", heldSide: "LONG", quantity: 2, entryPrice: scenario === "break-even" ? 100 : 98, exitType: "TAKE_PROFIT",
        comparison: "EQ", triggerPrice: 100, expiresAt: new Date(Date.now() + 10000).toISOString(),
      }] } });
    assert.equal(result.ok, scenario === "valid", JSON.stringify(result));
    assert.equal((await page.evaluate(() => window.exits)).length, scenario === "valid" ? 1 : 0);
  });
}

for (const heldSide of ["LONG", "SHORT"]) for (const threshold of [4, 4.5, -3]) for (const scenario of ["valid", "quote-changed", "dialog-changed", "cost-changed", "quantity-changed", "frozen", "expired"]) {
  test(`${heldSide} profit points / stop amount ${threshold} verifies final browser confirmation: ${scenario}`, async () => {
    const long = heldSide === "LONG";
    const entryPrice = 100 - (long ? 1 : -1) * (threshold > 0 ? threshold : (threshold + 2) / 2);
    const belowThresholdPrice = threshold > 0 ? 100 - (long ? 1 : -1) * (threshold - (threshold === 4.5 ? 4 : 1) + 0.01)
      : 100 + (long ? 1 : -1) * 0.01;
    const dialogPrice = scenario === "dialog-changed" ? belowThresholdPrice : 100;
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div><div>实时货值变化 -100元</div>')
      .replace("<td>101</td>", "<td>100</td>")
      // Change both initial and delayed prices; a polling override can briefly
      // lose to the fixture's 200 ms initialization on a busy CI runner.
      .replace('value="19"', `value="${dialogPrice}"`).replace("value='19.5'", `value='${dialogPrice}'`) }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    await page.reload();
    await page.evaluate(({ long, entryPrice, scenario, belowThresholdPrice }) => {
      for (const title of ["订单价格", "冻结数量"]) {
        const head = document.createElement("th"); head.textContent = title;
        document.querySelector("#positions thead tr").append(head);
      }
      for (const row of document.querySelectorAll("#positions tbody tr")) {
        for (const value of [entryPrice, 0]) {
          const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
        }
      }
      const target = document.querySelectorAll("#positions tbody tr")[1];
      target.children[1].textContent = long ? "买入" : "卖出";
      const original = window.transfer;
      window.transfer = (...args) => {
        original(...args);
        if (scenario === "quote-changed") document.querySelector(`body > table tr:nth-child(${long ? 2 : 1}) td:nth-child(2)`).textContent = String(belowThresholdPrice);
        if (scenario === "cost-changed") target.children[6].textContent = "100";
        if (scenario === "quantity-changed") target.children[2].textContent = "1";
        if (scenario === "frozen") target.children[7].textContent = "1";
      };
    }, { long, entryPrice, scenario, belowThresholdPrice });
    const position = { positionOrderId: "P-1", symbol: "DGKZ", symbolName: "测试商品", side: heldSide, quantity: 2, orderPrice: entryPrice, roundTripFee: threshold === 4.5 ? 11 : 2 };
    const market = { symbol: "DGKZ", observedAt: new Date().toISOString(), account: { positionsVerified: true, positions: [position] },
      orderBook: { bids: [{ price: 100, volume: 30 }], asks: [{ price: 100, volume: 20 }] } };
    const candidate = threshold > 0 ? positionProfitExit(position, market) : { netPnl: -3, decision: {
      action: long ? "SELL" : "BUY", exitType: "STOP_LOSS", targetPositionIds: ["P-1"],
      exitGuard: { positionId: "P-1", heldSide, quantity: 2, entryPrice, exitType: "STOP_LOSS",
        triggerPrice: 100, comparison: long ? "LTE" : "GTE", expiresAt: new Date(Date.now() + 10000).toISOString(),
        positionAmount: { threshold: -3, fees: 2 } } } };
    assert.equal(candidate.netPnl, threshold > 0 ? threshold * 2 - position.roundTripFee : threshold);
    if (scenario === "expired") candidate.decision.exitGuard.expiresAt = new Date(Date.now() - 1).toISOString();
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", ...candidate.decision, symbol: "DGKZ", symbolName: "测试商品", quantity: 2 });
    assert.equal(result.ok, scenario === "valid" && threshold > 0, JSON.stringify(result));
    const exits = await page.evaluate(() => window.exits);
    assert.equal(exits.length, scenario === "valid" && threshold > 0 ? 1 : 0);
    if (scenario === "valid" && threshold > 0) assert.deepEqual(exits[0], { id: "P-1", price: "100", quantity: "2" });
    else assert.equal(result.code, "EXIT_CONDITION_CHANGED");
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

for (const side of ["LONG", "SHORT"]) for (const loss of [2.99, 3]) {
  test(`${side} rescue entry rechecks executable quote at ${loss} points before click`, async t => {
    t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
    await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
      .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
    await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
    const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: side === "LONG" ? "SELL" : "BUY",
      symbol: "DGKZ", symbolName: "测试商品", quantity: 2, price: side === "LONG" ? 100 : 101,
      rescueTrigger: { type: "LOSS_POINTS", threshold: 3, heldSide: side, entryPrice: side === "LONG" ? 100 + loss : 101 - loss,
        positionId: "original", observedAt: new Date().toISOString() } });
    assert.equal(result.ok, loss >= 3, JSON.stringify(result));
    assert.equal((await page.evaluate(() => window.entries)).length, loss >= 3 ? 1 : 0);
    assert.deepEqual(await page.evaluate(() => window.exits), []);
    if (loss < 3) assert.equal(result.code, "RESCUE_CONDITION_CHANGED");
  });
}

for (const side of ["LONG", "SHORT"]) test(`${side}: the second rescue completes a started group even below three loss points`, async t => {
  t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
    .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: side === "LONG" ? "SELL" : "BUY",
    symbol: "DGKZ", symbolName: "测试商品", quantity: 1, price: side === "LONG" ? 100 : 101,
    rescueTrigger: { type: "LOSS_POINTS", threshold: 3, heldSide: side, entryPrice: side === "LONG" ? 101 : 100,
      positionId: "original", completesRescueGroup: true, rescueOrderNumber: 2 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await page.evaluate(() => window.entries)).length, 1);
  assert.deepEqual(await page.evaluate(() => window.exits), []);
});

test("rescue cancels its confirmation if the loss retreats below three points after the entry click", async t => {
  t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
    .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  await page.evaluate(() => {
    const original = window.enter;
    window.enter = side => { original(side); document.querySelector('body > table tr:nth-child(2) td:nth-child(2)').textContent = "101"; };
  });
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 1, price: 100,
    rescueTrigger: { type: "LOSS_POINTS", threshold: 3, heldSide: "LONG", entryPrice: 103, positionId: "original", observedAt: new Date().toISOString() } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESCUE_CONDITION_CHANGED");
  assert.deepEqual(await page.evaluate(() => window.entries), []);
  assert.equal(await page.locator(".el-message-box:visible").count(), 0);
});

test("rescue refreshes a stale entry price to the live executable bid before submitting", async t => {
  t.after(() => page.goto("http://127.0.0.1/trade-fixture"));
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: tradeFixture
    .replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>') }));
  await page.goto("https://smyw.haohandahan.cn/client/#/transcc");
  const result = await submitSuggestionForm({ sessionId: "trade-fixture", action: "SELL", symbol: "DGKZ", symbolName: "测试商品", quantity: 2, price: 102,
    rescueTrigger: { type: "LOSS_POINTS", threshold: 3, heldSide: "LONG", entryPrice: 105, positionId: "original", observedAt: new Date().toISOString() } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await page.evaluate(() => window.entries), [{ side: "SELL", price: "100", quantity: "2" }]);
});
