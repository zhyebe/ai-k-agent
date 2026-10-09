import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { closeAllBrowserSessions, openBrowserPage, readVisiblePage, setBrowserSessionFactory } from "../server/browser.mjs";
import { parseHaohanAccount } from "../server/haohan.mjs";
import { continueManualEntry, fillSuggestionForm, readTradeControls, submitSuggestionForm } from "../server/tools.mjs";

import { tradeFixture } from "./fixtures/trade-page.mjs";

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
