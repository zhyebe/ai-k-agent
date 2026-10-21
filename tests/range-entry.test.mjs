import assert from "node:assert/strict";
import test from "node:test";
import { applyEntryBoundary, bindDecisionToMarket, buildDecisionContext } from "../server/engine.mjs";

const market = { symbol: "A", books: [{ symbol: "A", trend: "range" }, { symbol: "B", trend: "up" }] };
const bind = decision => applyEntryBoundary(bindDecisionToMarket(decision, market), market);

for (const action of ["BUY", "SELL"]) {
  for (const orderType of ["MARKET", "LIMIT"]) {
    test(`${action} ${orderType}: sideways forbids ordinary new entries, preserving exits and cancellations`, () => {
      const decision = { action, orderType, marketRegime: "RANGE", targetSymbol: "A", targetPrice: 100,
        bullishProfitProbability: 0.9, bearishProfitProbability: 0.9, targetPositionPct: 10, maxOrderValuePct: 4,
        exitPlans: [{ positionId: "old", heldSide: "LONG", quantity: 2, stopLossPrice: 98 }], cancelOrderIds: ["O1"] };
      const result = bind(decision);
      assert.equal(result.action, "HOLD");
      assert.equal(result.targetPositionPct, 0);
      assert.equal(result.maxOrderValuePct, 0);
      assert.ok(result.riskFlags.includes("RANGE_MARKET_NO_ENTRY"));
      assert.deepEqual(result.exitPlans, decision.exitPlans);
      assert.deepEqual(result.cancelOrderIds, ["O1"]);
      assert.equal(decision.action, action);
    });
  }
}

test("only the selected board's current AI regime controls entry; historical range and other boards do not", () => {
  const decision = { action: "BUY", targetSymbol: "A", marketRegime: "UP", boardAssessments: [
    { symbol: "A", action: "BUY", marketRegime: "UP" },
    { symbol: "B", action: "HOLD", marketRegime: "RANGE" },
  ] };
  assert.equal(bind(decision).action, "BUY", "historical trend=range cannot replace current AI evidence");
  const opposite = { ...decision, marketRegime: "UP", targetSymbol: "B" };
  assert.equal(bind(opposite).action, "HOLD", "the selected board's RANGE cannot be overridden by a top-level UP");
  const inferred = bind({ ...decision, targetSymbol: "", boardAssessments: decision.boardAssessments });
  assert.equal(inferred.targetSymbol, "A");
  assert.equal(inferred.action, "BUY");
  const duplicates = bind({ ...decision, boardAssessments: [
    { symbol: "A", marketRegime: "RANGE", action: "HOLD", confidence: 0.1 },
    { symbol: "A", marketRegime: "UP", action: "BUY", confidence: 0.9 },
  ] });
  assert.equal(duplicates.action, "HOLD", "conflicting duplicate assessments cannot drop RANGE");
});

test("missing/invalid current regime cannot authorize entry or be inferred from free text/history", () => {
  assert.equal(bind({ action: "BUY", targetSymbol: "A" }).action, "HOLD");
  for (const marketRegime of [undefined, "UNKNOWN", "bogus"]) {
    const result = bind({ action: "BUY", targetSymbol: "A", marketRegime, analysisSummary: "主判断：偏涨" });
    assert.equal(result.action, "HOLD");
    assert.ok(result.riskFlags.includes("ENTRY_MARKET_REGIME_UNKNOWN"));
  }
});

test("an incomplete board assessment does not erase an explicit target regime", () => {
  for (const [action, marketRegime] of [["BUY", "UP"], ["SELL", "DOWN"]]) {
    for (const boardRegime of [undefined, "UNKNOWN"]) {
      const result = bind({ action, targetSymbol: "A", marketRegime,
        boardAssessments: [{ symbol: "A", action, marketRegime: boardRegime }] });
      assert.equal(result.action, action);
      assert.equal(result.marketRegime, marketRegime);
    }
  }
  const blocked = bind({ action: "BUY", targetSymbol: "A", marketRegime: "RANGE",
    boardAssessments: [{ symbol: "A", marketRegime: "UP" }] });
  assert.equal(blocked.action, "HOLD", "explicit RANGE at either target level still blocks entry");
  assert.equal(blocked.entryBlock.requestedAction, "BUY");
  assert.equal(blocked.entryBlock.reason, "RANGE_MARKET_NO_ENTRY");
});

test("sideways does not block explicit profit, protective or scheduled exits", () => {
  const positions = [{ positionOrderId: "P1", symbol: "A", side: "LONG", quantity: 2 }];
  for (const exitType of ["TAKE_PROFIT", "STOP_LOSS", "SCHEDULED_CLOSE"]) {
    const decision = { action: "SELL", marketRegime: "RANGE", exitType, targetPositionIds: ["P1"] };
    const snapshot = { ...market, account: { positionsVerified: true, positions } };
    assert.equal(applyEntryBoundary(bindDecisionToMarket(decision, snapshot), snapshot).action, "SELL");
  }
});

for (const side of ["LONG", "SHORT"]) {
  test(`${side}: AI context separates one per-unit point, quantity-scaled gross and net costs`, () => {
    const position = { positionOrderId: "P1", symbol: "A", side, orderPrice: 100, quantity: 2, roundTripFee: 0.5 };
    const price = side === "LONG" ? 101 : 99;
    const snapshot = { symbol: "A", latest: { price: 800 }, orderBook: { bids: [{ price, volume: 10 }], asks: [{ price, volume: 10 }] },
      account: { positionsVerified: true, positions: [position] }, analysisLayers: { layers: [] } };
    const task = { market: snapshot, metrics: {}, rules: [], decision: { action: "HOLD" } };
    const context = () => buildDecisionContext(task, snapshot, [], "monitor", snapshot).account.positionContext[0];
    const result = context();
    assert.equal(result.quantity, 2);
    assert.equal(result.exitQuotePnlPoints, 1);
    assert.equal(result.exitQuoteGrossPnl, 2);
    assert.equal(result.exitQuoteFees, 0.5);
    assert.equal(result.exitQuoteNetPnl, 1.5);
    delete position.roundTripFee;
    assert.equal(context().exitQuoteGrossPnl, 2);
    assert.equal(context().exitQuoteNetPnl, null);
    snapshot.orderBook = {};
    assert.equal(context().exitQuoteGrossPnl, null, "the last mark is not an exit quote");
  });
}

for (const action of ["BUY", "SELL"]) for (const orderType of ["MARKET", "LIMIT"]) {
  test(`${action} ${orderType}: tagged rescue can be evaluated in RANGE but not UNKNOWN`, () => {
    const decision = { action, orderType, targetSymbol: "A", marketRegime: "RANGE", entryPurpose: "RESCUE", rescuePositionIds: ["original"] };
    assert.equal(bind(decision).action, action);
    assert.equal(bind({ ...decision, rescuePositionIds: [] }).action, "HOLD");
    assert.equal(bind({ ...decision, entryPurpose: "NORMAL" }).action, "HOLD");
    assert.equal(bind({ ...decision, marketRegime: "UNKNOWN" }).action, "HOLD");
  });
}
