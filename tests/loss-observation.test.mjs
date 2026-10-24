import assert from "node:assert/strict";
import test from "node:test";
import { observePositionLosses, positionLossReview, recoveryExitAllowed, observedLossGuardAllowsPrice, observedLossStopCandidate } from "../server/loss-observation.mjs";
import { validateExitPlans, evaluateExitPlan } from "../server/exit-policy.mjs";

const base = Date.parse("2026-10-24T10:00:00+08:00");
function fixture(side = "LONG", fee = 0) {
  const position = { positionOrderId: "p", symbol: "DGKZ", side, quantity: 2, orderPrice: 100, roundTripFee: fee, frozenQuantity: 0 };
  const task = {};
  let market;
  function sample(sec, points, extra = {}) {
    const price = 100 + (side === "LONG" ? points : -points);
    market = { symbol: "DGKZ", observedAt: new Date(base + sec * 1000).toISOString(),
      account: { positionsVerified: true, positions: [position] },
      orderBook: { bids: [{ price, volume: 10 }], asks: [{ price, volume: 10 }] }, ...extra };
    observePositionLosses(task, market, base + sec * 1000);
    return task.lossObservations.p;
  }
  return { position, task, sample, get market() { return market; },
    review(sec) { return positionLossReview(task.lossObservations.p, position, base + sec * 1000); } };
}

for (const side of ["LONG", "SHORT"]) {
  test(`${side}: waits one minute, lets AI stop in minute two, forces only continuing expansion at two minutes`, () => {
    const f = fixture(side);
    for (let s = 0; s <= 120; s += 10) {
      const record = f.sample(s, -0.1 - s / 100);
      const review = f.review(s);
      assert.equal(review.stopAllowed, s >= 60);
      assert.equal(Boolean(review.forceStop), s >= 120);
      assert.equal(Boolean(observedLossStopCandidate(f.position, f.market, record, base + s * 1000)), s >= 120);
    }
    const guard = observedLossStopCandidate(f.position, f.market, f.task.lossObservations.p, base + 120000).decision.exitGuard;
    assert.equal(observedLossGuardAllowsPrice(guard, f.position, side === "LONG" ? 98.7 : 101.3, f.market, base + 120000), true);
    assert.equal(observedLossGuardAllowsPrice(guard, f.position, side === "LONG" ? 99.5 : 100.5, f.market, base + 120000), false, "recovery invalidates stale stop");
    assert.equal(observedLossGuardAllowsPrice({ exitType: "STOP_LOSS" }, f.position, side === "LONG" ? 99 : 101, f.market, base + 120000), false);
  });

  for (const mode of ["flat", "narrowing", "single-spike"]) test(`${side}: ${mode} loss does not force a timed exit`, () => {
    const f = fixture(side);
    for (let s = 0; s <= 180; s += 10) f.sample(s, mode === "narrowing" ? -2 + s / 100 : mode === "single-spike" && s === 180 ? -2.5 : -1);
    assert.equal(f.review(180).stopAllowed, false);
    assert.equal(Boolean(f.review(180).forceStop), false);
  });

  test(`${side}: recovery uses known net PnL, allows AI break-even below one point and rechecks modal price`, () => {
    const f = fixture(side, 1);
    for (let s = 0; s < 60; s += 10) f.sample(s, -1);
    f.sample(60, 0.5);
    assert.equal(f.review(60).status, "RECOVERED");
    const price = side === "LONG" ? 100.5 : 99.5;
    assert.equal(recoveryExitAllowed(f.task.lossObservations.p, f.position, price, base + 60000), true);
    assert.equal(recoveryExitAllowed(f.task.lossObservations.p, f.position, 100, base + 60000), false);
    const { plans, rejected } = validateExitPlans({ exitPlans: [{ positionId: "p", heldSide: side, quantity: 2, validForSec: 120,
      takeProfitPrice: price, stopLossPrice: null }] }, f.market, f.task, base + 60000);
    assert.deepEqual(rejected, []);
    const result = evaluateExitPlan(plans[0], f.market, base + 60000);
    assert.equal(result.status, "TRIGGERED");
    assert.equal(result.decision.exitGuard.lossRecovery, true);
    assert.equal(observedLossGuardAllowsPrice(result.decision.exitGuard, f.position, price, f.market, base + 60000), true);
    assert.equal(observedLossGuardAllowsPrice(result.decision.exitGuard, f.position, 100, f.market, base + 60000), false);
  });
}

test("fresh recovery, unknown fees and a new loss are distinct", () => {
  const f = fixture("LONG", null);
  f.sample(0, -1);
  f.sample(10, 0);
  assert.notEqual(f.review(10).status, "RECOVERED");
  assert.equal(recoveryExitAllowed(f.task.lossObservations.p, f.position, 100, base + 10000), false);
  const g = fixture();
  g.sample(0, 0.5);
  assert.notEqual(g.review(0).status, "RECOVERED", "profit without a prior loss cannot bypass the ordinary one-point floor");
  g.sample(10, -1);
  g.sample(20, 0);
  assert.equal(g.review(20).status, "RECOVERED");
  g.sample(30, -1);
  assert.equal(g.task.lossObservations.p.startedAt, base + 30000);
});

test("flash requires fresh settled quotes before recovery or loss decisions; continuing loss needs new trend evidence", () => {
  const f = fixture();
  for (let s = 0; s < 120; s += 10) f.sample(s, -0.1 - s / 100);
  f.sample(120, -2, { flashK: { suspected: true } });
  assert.equal(f.review(120).status, "FLASH_WAIT");
  assert.equal(f.review(126).status, "FLASH_WAIT", "elapsed wall clock alone does not prove a flash finished");
  f.sample(130, -2.1);
  assert.equal(f.review(130).stopAllowed, false);
  f.sample(140, -2.2);
  f.sample(150, -2.3);
  assert.equal(f.review(150).forceStop, true);
  f.sample(160, 0, { flashK: { suspected: true } });
  assert.equal(recoveryExitAllowed(f.task.lossObservations.p, f.position, 100, base + 160000), false);
  f.sample(166, 0);
  assert.equal(f.review(166).status, "RECOVERED");
});

for (const reset of ["gap", "quantity", "cost", "fees", "unverified", "restart", "stale"]) test(`${reset} cannot reuse loss evidence`, () => {
  const f = fixture();
  for (let s = 0; s <= 120; s += 10) f.sample(s, -0.1 - s / 100);
  assert.equal(f.review(120).forceStop, true);
  if (reset === "quantity") f.position.quantity++;
  if (reset === "cost") f.position.orderPrice++;
  if (reset === "fees") f.position.roundTripFee++;
  if (reset === "restart") delete f.task.lossObservations;
  if (reset === "unverified") observePositionLosses(f.task, { ...f.market, account: { positionsVerified: false } }, base + 121000);
  if (reset === "stale") { assert.equal(f.review(136).stopAllowed, false); return; }
  f.sample(reset === "gap" ? 150 : 130, -2);
  assert.equal(f.review(reset === "gap" ? 150 : 130).stopAllowed, false);
});

test("duplicate and out-of-order snapshots never add elapsed evidence", () => {
  const f = fixture();
  f.sample(0, -1);
  observePositionLosses(f.task, f.market, base + 4000);
  assert.equal(f.task.lossObservations.p.samples.length, 1);
  f.sample(10, -1.1);
  f.sample(5, -1.2);
  assert.equal(f.review(10).stopAllowed, false);
});

test("rescue and four-point ceiling guards keep precedence", () => {
  const f = fixture();
  f.sample(0, -2, { flashK: { suspected: true } });
  for (const guard of [{ rescueRecovery: true }, { positionPoints: { programCeiling: true } }, { exitType: "SCHEDULED_CLOSE" }]) {
    assert.equal(observedLossGuardAllowsPrice(guard, f.position, 98, f.market, base), true);
  }
});
