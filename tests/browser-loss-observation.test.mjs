import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { chromium } from "playwright";
import { setBrowserSessionFactory, openBrowserPage, closeAllBrowserSessions } from "../server/browser.mjs";
import { submitSuggestionForm } from "../server/tools.mjs";
import { clickPositionTransfer } from "../server/trade-controls.mjs";
import { observePositionLosses } from "../server/loss-observation.mjs";
import { tradeFixture } from "./fixtures/trade-page.mjs";

let browser, page;
before(async () => {
  browser = await chromium.launch({ ...(process.platform === "darwin" ? { channel: "chrome" } : {}), headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route("https://smyw.haohandahan.cn/client/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: tradeFixture.replace("<body>", '<body><div>DGKZ | 测试商品</div><div>最新价 100</div>')
      .replace('value="19"', 'value="100"').replace(".value='19.5'", ".value='100'") }));
  setBrowserSessionFactory(async () => ({ browser, context, page, ownsBrowser: false, mode: "test" }));
  await openBrowserPage({ sessionId: "loss-fixture", url: "https://smyw.haohandahan.cn/client/#/transcc", waitMs: 0 });
});
after(async () => { await closeAllBrowserSessions(); setBrowserSessionFactory(null); await browser?.close(); });
afterEach(async () => assert.equal(await page.evaluate(() => window.historyVisits), 0));

for (const scenario of ["unobserved", "observed", "recovered", "recovered-price-falls"]) test(`loss/recovery guard rechecks real trade dialogs: ${scenario}`, async () => {
  await page.reload();
  const recovery = scenario.startsWith("recovered");
  const entryPrice = recovery ? 99.5 : 101;
  await page.evaluate(({ entryPrice, scenario }) => {
    for (const title of ["订单价格", "冻结数量"]) {
      const th = document.createElement("th"); th.textContent = title;
      document.querySelector("#positions thead tr").append(th);
    }
    for (const row of document.querySelectorAll("#positions tbody tr")) for (const value of [entryPrice, 0]) {
      const td = document.createElement("td"); td.textContent = String(value); row.append(td);
    }
    const original = window.transfer;
    window.transfer = (...args) => {
      original(...args);
      if (scenario === "recovered-price-falls") document.querySelector("body > table tr:nth-child(2) td:nth-child(2)").textContent = "99";
    };
  }, { entryPrice, scenario });
  const now = Date.now();
  const position = { positionOrderId: "P-1", symbol: "DGKZ", side: "LONG", quantity: 2, orderPrice: entryPrice, roundTripFee: recovery ? 1 : 0 };
  const task = {};
  for (let ago = 90; ago >= 0; ago -= 10) {
    const price = recovery ? ago ? 99.4 : 100 : 100 + ago * 0.005;
    observePositionLosses(task, { symbol: "DGKZ", observedAt: new Date(now - ago * 1000).toISOString(),
      account: { positionsVerified: true, positions: [position] },
      orderBook: { bids: [{ price, volume: 10 }], asks: [{ price: 101, volume: 10 }] } }, now - ago * 1000);
  }
  const exitType = recovery ? "TAKE_PROFIT" : "STOP_LOSS";
  const result = await submitSuggestionForm({ sessionId: "loss-fixture", action: "SELL", exitType, quantity: 2,
    targetPositionIds: ["P-1"], symbol: "DGKZ", symbolName: "测试商品", exitGuard: {
      positionId: "P-1", heldSide: "LONG", quantity: 2, entryPrice, exitType, triggerPrice: 100,
      comparison: recovery ? "GTE" : "LTE", expiresAt: new Date(now + 10000).toISOString(),
      lossRecovery: recovery, lossObservation: scenario === "unobserved" ? undefined : task.lossObservations["P-1"],
    } });
  const allowed = scenario === "observed" || scenario === "recovered";
  assert.equal(result.ok, allowed, JSON.stringify(result));
  assert.equal((await page.evaluate(() => window.exits)).length, allowed ? 1 : 0);
});

test("delayed native transfer confirmation cannot bypass a rejected latest check", async () => {
  await page.reload();
  await page.evaluate(() => {
    window.nativeAccepted = false;
    window.nativeSeen = false;
    window.transfer = () => setTimeout(() => {
      window.nativeAccepted = window.confirm("是否确认交易");
      window.nativeSeen = true;
    }, 150);
  });
  const clicked = await clickPositionTransfer(page, { action: "SELL", targetPositionIds: ["P-1"] },
    { persistNativeDialog: true, canAcceptNative: () => false });
  try {
    await page.waitForFunction(() => window.nativeSeen);
    assert.equal(await page.evaluate(() => window.nativeAccepted), false);
    assert.equal(clicked.nativeConfirmationState.confirmed, false);
  } finally { clicked.nativeDialogCleanup?.(); }
});

for (const confirmed of [false, true]) test(`ordinary four-point transfer modal respects flash state, confirmed=${confirmed}`, async () => {
  await page.reload();
  await page.evaluate(() => {
    for (const title of ["订单价格", "冻结数量"]) {
      const th = document.createElement("th"); th.textContent = title;
      document.querySelector("#positions thead tr").append(th);
    }
    for (const row of document.querySelectorAll("#positions tbody tr")) for (const value of [96, 0]) {
      const td = document.createElement("td"); td.textContent = String(value); row.append(td);
    }
  });
  const now = Date.now();
  const result = await submitSuggestionForm({ sessionId: "loss-fixture", action: "SELL", exitType: "TAKE_PROFIT", quantity: 2,
    targetPositionIds: ["P-1"], symbol: "DGKZ", symbolName: "测试商品", exitGuard: {
      positionId: "P-1", heldSide: "LONG", quantity: 2, entryPrice: 96, exitType: "TAKE_PROFIT", triggerPrice: 100,
      comparison: "GTE", expiresAt: new Date(now + 15000).toISOString(),
      positionPoints: { programCeiling: true, threshold: 4 },
      exitFlash: { observedAt: now - 40000, waitUntil: now - 10000, candleAt: Math.floor((now - 40000) / 60000) * 60000,
        confirmedAt: confirmed ? now - 1000 : null, readyAt: confirmed ? now - 1000 : null, pending: !confirmed },
    } });
  assert.equal(result.ok, confirmed, JSON.stringify(result));
  assert.equal((await page.evaluate(() => window.exits)).length, confirmed ? 1 : 0);
});
