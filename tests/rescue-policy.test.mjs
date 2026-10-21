import assert from "node:assert/strict";
import test from "node:test";
import { observeRescueFill, rescueEntryIntent, rescueExitCandidates } from "../server/rescue-policy.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";

const now = Date.parse("2026-10-21T10:00:00+08:00");
const position = (id, side, orderPrice, extra = {}) => ({ positionOrderId: id, symbol: "A", side, orderPrice, quantity: 1, roundTripFee: 0, ...extra });
const snapshot = positions => ({ symbol: "A", observedAt: new Date(now).toISOString(),
  account: { positionsVerified: true, positions, openOrdersVerified: true, openOrders: [] },
  orderBook: { bids: [{ price: 100, volume: 100 }], asks: [{ price: 100, volume: 100 }] } });
const original = position("loss", "LONG", 103);
const rescue = position("hedge", "SHORT", 104);
const pending = { id: "rescue-order", action: "SELL", entryPurpose: "RESCUE", rescuePositionIds: ["loss"],
  targetSymbol: "A", status: "AWAITING_FILL", source: "auto_timeout", baselinePositionsVerified: true, baselinePositions: {} };

test("only an explicitly tagged opposite entry against an actual losing position is a rescue", () => {
  const decision = { action: "SELL", targetSymbol: "A", entryPurpose: "RESCUE", rescuePositionIds: ["loss"] };
  assert.deepEqual(rescueEntryIntent(decision, snapshot([original]), now).rescuePositionIds, ["loss"]);
  assert.equal(rescueEntryIntent({ action: "SELL" }, snapshot([original]), now).entryPurpose, "NORMAL");
  for (const change of [{ action: "BUY" }, { targetSymbol: "B" }, { rescuePositionIds: ["missing"] }, { exitType: "STOP_LOSS" }])
    assert.throws(() => rescueEntryIntent({ ...decision, ...change }, snapshot([original]), now), /INVALID_RESCUE_TARGET/);
  assert.throws(() => rescueEntryIntent(decision, snapshot([{ ...original, orderPrice: 99 }]), now), /INVALID_RESCUE_TARGET/);
});

test("ordinary opposite positions or an unfilled rescue never activate account break-even exit", () => {
  const task = {};
  observeRescueFill(task, snapshot([original]), pending);
  assert.equal(task.rescueSession, undefined);
  observeRescueFill(task, snapshot([original, rescue]), { ...pending, entryPurpose: "NORMAL" });
  assert.equal(task.rescueSession, undefined);
  assert.deepEqual(rescueExitCandidates(task, snapshot([original, rescue]), now), []);
  observeRescueFill(task, snapshot([original, rescue]), { ...pending, baselinePositionsVerified: false });
  assert.equal(task.rescueSession, undefined);
});

test("verified partial rescue fills activate tracking, which survives restart", () => {
  const task = {};
  observeRescueFill(task, snapshot([original, { ...rescue, quantity: 0.5 }]), pending);
  const restored = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime(task))));
  assert.equal(restored.rescueSession.status, "ACTIVE");
  assert.deepEqual(restored.rescueSession.originalPositionIds, ["loss"]);
  assert.deepEqual(restored.rescueSession.rescuePositionIds, ["hedge"]);
});

for (const accountNet of [-0.01, 0, 0.01]) test(`rescue closes all account positions at net ${accountNet}, including other instruments`, () => {
  const task = {};
  const market = snapshot([original, rescue, position("other", "LONG", 100, { symbol: "B", roundTripFee: 1 - accountNet })]);
  market.books = [{ ...market, symbol: "B" }];
  observeRescueFill(task, market, pending);
  const candidates = rescueExitCandidates(task, market, now);
  assert.equal(candidates.length, accountNet >= 0 ? 3 : 0);
  if (accountNet >= 0) {
    assert.equal(task.rescueSession.status, "EXITING");
    assert.deepEqual(candidates.map(c => c.position.positionOrderId), ["loss", "hedge", "other"]);
    assert.equal(candidates[0].decision.exitType, "STOP_LOSS");
    assert.equal(candidates[1].decision.exitType, "TAKE_PROFIT");
    market.account.positions = [original]; // Profitable leg fills first.
    assert.equal(rescueExitCandidates(task, market, now).length, 1);
    market.account.positions = [];
    market.account.openOrders = [{ orderId: "unsettled", remainingQuantity: 1 }];
    rescueExitCandidates(task, market, now);
    assert.equal(task.rescueSession.status, "EXITING");
    market.account.openOrders = [];
    rescueExitCandidates(task, market, now);
    assert.equal(task.rescueSession.status, "COMPLETE");
  }
});

test("rescue recovery is unknown with missing fees/quotes, stale data or inadequate executable depth", () => {
  for (const fault of ["fees", "depth", "quote", "stale", "unverified"]) {
    const task = {}, market = snapshot([original, rescue]);
    observeRescueFill(task, market, pending);
    if (fault === "fees") market.account.positions = [original, { ...rescue, roundTripFee: undefined }];
    if (fault === "depth") market.orderBook.bids[0].volume = 0.1;
    if (fault === "quote") market.orderBook = {};
    if (fault === "stale") market.observedAt = new Date(now - 6000).toISOString();
    if (fault === "unverified") market.account.positionsVerified = false;
    assert.deepEqual(rescueExitCandidates(task, market, now), []);
    assert.equal(task.rescueSession.status, "ACTIVE");
  }
});

test("unsubmitted or ambiguous opposite fills cannot mark ordinary trades as rescue", () => {
  for (const task of [{}, { unsettledActions: [{ ...pending, id: "ordinary", entryPurpose: "NORMAL" }] }]) {
    const candidate = task.unsettledActions ? pending : { ...pending, source: null, status: "WAITING" };
    observeRescueFill(task, snapshot([original, rescue]), candidate);
    assert.equal(task.rescueSession, undefined);
  }
});

test("recovery needs aggregate same-side depth and unresolved entries prevent completion", () => {
  const task = {}, market = snapshot([original, rescue, position("second", "LONG", 100)]);
  observeRescueFill(task, market, pending);
  market.orderBook.bids[0].volume = 1;
  assert.deepEqual(rescueExitCandidates(task, market, now), []);
  assert.equal(task.rescueSession.netPnl, null);
  market.orderBook.bids[0].volume = 2;
  assert.equal(rescueExitCandidates(task, market, now).length, 3);
  market.account.positions = [];
  task.pendingAction = pending;
  rescueExitCandidates(task, market, now);
  assert.equal(task.rescueSession.status, "EXITING");
});

test("closed rescue participants do not carry recovery rules into later ordinary positions", () => {
  const task = {}, market = snapshot([original, rescue]);
  observeRescueFill(task, market, pending);
  market.account.positions = [position("ordinary", "LONG", 100)];
  assert.deepEqual(rescueExitCandidates(task, market, now), []);
  assert.equal(task.rescueSession.status, "COMPLETE");
});
