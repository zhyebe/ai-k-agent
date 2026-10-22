import assert from "node:assert/strict";
import test from "node:test";
import { activeRescuePositionIds, automaticRescueCandidates, observeRescueFill, observeStartupRescue, rescueEntryIntent, rescueEntryLocked, rescueExitCandidates, rescueTriggerAllowsQuote, validateRescueEntry } from "../server/rescue-policy.mjs";
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
const secondRescue = position("hedge-2", "SHORT", 100);
function assemble(task, market) {
  observeRescueFill(task, { ...market, account: { ...market.account, positions: market.account.positions.filter(p => p.positionOrderId !== "hedge-2") } }, pending);
  observeRescueFill(task, market, { ...pending, id: "second-rescue-order", baselinePositions: { hedge: 1 } });
}

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

test("partial-fill reobservations and restart consume only one rescue slot, and the second needs no new loss threshold", () => {
  const task = {}, market = snapshot([original, { ...rescue, quantity: 0.5 }]);
  observeRescueFill(task, market, pending);
  observeRescueFill(task, market, pending);
  market.account.positions[1].quantity = 1;
  observeRescueFill(task, market, pending);
  const restored = JSON.parse(JSON.stringify(compactTaskRuntime(task)));
  assert.equal(restored.rescueSession.groups[0].rescueOrders.length, 1);
  assert.deepEqual(rescueExitCandidates(restored, market, now), [], "the first hedge alone cannot close the group");
  market.orderBook.bids[0].price = 102;
  market.orderBook.asks[0].price = 102;
  const candidate = automaticRescueCandidates(restored, market, now)[0];
  assert.equal(candidate.decision.rescueTrigger.rescueOrderNumber, 2);
  assert.equal(candidate.decision.rescueTrigger.lossPoints, 1);
  assert.equal(rescueTriggerAllowsQuote(candidate.decision.rescueTrigger, 102.5), true);
  assert.equal(rescueTriggerAllowsQuote({ ...candidate.decision.rescueTrigger, completesRescueGroup: false }, 102.5), false);
  market.account.positions.push(secondRescue);
  observeRescueFill(restored, market, { ...pending, id: "second-order", baselinePositions: { hedge: 1 } });
  assert.deepEqual(automaticRescueCandidates(restored, market, now), []);
  assert.equal(restored.rescueSession.groups[0].rescueOrders.length, 2);
  assert.deepEqual([...activeRescuePositionIds(restored)].sort(), ["hedge", "hedge-2", "loss"]);
});

for (const groupNet of [-0.01, 0, 0.01]) test(`only the three rescue group legs close at net ${groupNet}, ignoring other holdings and account totals`, () => {
  const task = {};
  const market = snapshot([original, rescue, { ...secondRescue, roundTripFee: 1 - groupNet }, position("other", "LONG", 1, { symbol: "B" })]);
  market.account.realtimeValueChange = groupNet < 0 ? 9999 : -9999;
  assemble(task, market);
  const candidates = rescueExitCandidates(task, market, now);
  assert.equal(candidates.length, groupNet >= 0 ? 3 : 0);
  if (groupNet >= 0) {
    assert.equal(task.rescueSession.status, "EXITING");
    assert.deepEqual(candidates.map(c => c.position.positionOrderId), ["loss", "hedge", "hedge-2"]);
    assert.equal(candidates[0].decision.exitType, "STOP_LOSS");
    assert.equal(candidates[1].decision.exitType, "TAKE_PROFIT");
    market.account.positions = [original, position("ordinary", "LONG", 100)]; // Profitable legs fill first.
    assert.equal(rescueExitCandidates(task, market, now).length, 1);
    market.account.positions = [position("ordinary", "LONG", 100)];
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
    const task = {}, market = snapshot([original, rescue, secondRescue]);
    assemble(task, market);
    if (fault === "fees") market.account.positions[1] = { ...rescue, roundTripFee: undefined };
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
  const task = {}, market = snapshot([original, rescue, secondRescue]);
  assemble(task, market);
  market.orderBook.asks[0].volume = 1;
  assert.deepEqual(rescueExitCandidates(task, market, now), []);
  assert.equal(task.rescueSession.netPnl, null);
  market.orderBook.asks[0].volume = 2;
  assert.equal(rescueExitCandidates(task, market, now).length, 3);
  market.account.positions = [];
  task.pendingAction = pending;
  rescueExitCandidates(task, market, now);
  assert.equal(task.rescueSession.status, "EXITING");
});

test("closed rescue participants unlock after audit without liquidating unrelated holdings", () => {
  const task = {}, market = snapshot([original, rescue]);
  observeRescueFill(task, market, pending);
  market.account.positions = [position("ordinary", "LONG", 100)];
  assert.equal(rescueExitCandidates(task, market, now).length, 0);
  rescueExitCandidates(task, market, now);
  assert.equal(task.rescueSession.status, "COMPLETE");
  assert.equal(rescueEntryLocked(task), false);
});

for (const status of ["WAITING", "SUBMITTING", "AWAITING_FILL", "UNVERIFIED"]) test(`a ${status} rescue blocks ordinary entries before fill reconciliation`, () => {
  for (const slot of ["pendingAction", "unsettledActions"]) {
    const order = { ...pending, status };
    const task = { [slot]: slot === "pendingAction" ? order : [order] };
    assert.throws(() => validateRescueEntry(task, { entryPurpose: "NORMAL" }), /RESCUE_ENTRY_LOCKED/);
  }
});

test("a cancelled rescue remains locked until its possible partial fill is audited", () => {
  const task = { pendingAction: { ...pending, status: "CANCELLED", cancellationAwaitingAudit: true } };
  assert.equal(rescueEntryLocked(task), true);
  task.pendingAction.cancellationAwaitingAudit = false;
  assert.equal(rescueEntryLocked(task), false);
});

test("startup recognizes same-instrument opposing holdings without inventing pairs across instruments", () => {
  const task = {};
  const market = snapshot([original, rescue]);
  market.account.positionsVerified = false;
  observeStartupRescue(task, market);
  assert.equal(task.rescueStartupScanned, undefined);
  market.account.positionsVerified = true;
  observeStartupRescue(task, market);
  assert.equal(task.rescueSession.source, "startup_positions");
  assert.equal(rescueEntryLocked(task), true);
  assert.deepEqual(automaticRescueCandidates(task, market, now), []);
  const other = {};
  observeStartupRescue(other, snapshot([original, { ...rescue, symbol: "B" }]));
  assert.equal(rescueEntryLocked(other), false);
  observeStartupRescue(other, market);
  assert.equal(rescueEntryLocked(other), false, "ordinary opposing fills after startup do not reclassify the task");
});

test("the initial batch allows two distinct rescues per original and never adds late originals", () => {
  const task = {};
  const market = snapshot([original, position("second", "LONG", 105), rescue]);
  observeRescueFill(task, market, { ...pending, rescueBatchPositionIds: ["loss", "second"] });
  assert.deepEqual(automaticRescueCandidates(task, market, now).map(c => c.position.positionOrderId), ["loss", "second"]);
  market.account.positions.push(position("late", "LONG", 110));
  assert.deepEqual(automaticRescueCandidates(task, market, now).map(c => c.position.positionOrderId), ["loss", "second"]);
  market.account.positions.push(secondRescue);
  observeRescueFill(task, market, { ...pending, id: "second-rescue-order", baselinePositions: { hedge: 1 } });
  assert.deepEqual(automaticRescueCandidates(task, market, now).map(c => c.position.positionOrderId), ["second"]);
  assert.throws(() => validateRescueEntry(task, rescueEntryIntent({ action: "SELL", targetSymbol: "A", entryPurpose: "RESCUE", rescuePositionIds: ["loss"] }, market, now)), /RESCUE_ENTRY_LOCKED/);
  assert.throws(() => validateRescueEntry(task, { entryPurpose: "NORMAL" }), /RESCUE_ENTRY_LOCKED/);
});

test("restored partial rescue locks survive incomplete position and current-order observations", () => {
  const task = {};
  observeRescueFill(task, snapshot([original, { ...rescue, quantity: 0.5 }]), pending);
  const restored = JSON.parse(JSON.stringify(compactTaskRuntime(task)));
  const market = snapshot([]);
  market.account.positionsVerified = false;
  rescueExitCandidates(restored, market, now);
  assert.equal(rescueEntryLocked(restored), true);
  market.account.positionsVerified = true;
  market.account.openOrdersVerified = false;
  rescueExitCandidates(restored, market, now);
  assert.equal(rescueEntryLocked(restored), true);
  market.account.openOrdersVerified = true;
  market.account.openOrders = [{ orderId: "remaining" }];
  rescueExitCandidates(restored, market, now);
  assert.equal(rescueEntryLocked(restored), true);
  market.account.openOrders = [];
  rescueExitCandidates(restored, market, now);
  assert.doesNotThrow(() => validateRescueEntry(restored, { entryPurpose: "NORMAL" }));
});
