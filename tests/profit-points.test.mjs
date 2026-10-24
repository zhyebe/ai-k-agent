import assert from "node:assert/strict";
import test from "node:test";
import { exitNetPnl, exitGuardAllowsPrice, isNonLosingExit, positionAmountGuardAllowsPrice, positionProfitExit, validateExitPlans } from "../server/exit-policy.mjs";

const now = Date.parse("2026-10-20T10:00:00+08:00");
for (const side of ["LONG", "SHORT"]) {
  const sign = side === "LONG" ? 1 : -1;
  const price = points => 100 + sign * points;
  const position = { positionOrderId: "P1", symbol: "DGKZ", side, orderPrice: 100, quantity: 10, roundTripFee: 1 };
  const market = points => ({ symbol: "DGKZ", observedAt: new Date(now).toISOString(),
    account: { positionsVerified: true, positions: [position], realtimeValueChange: -100 },
    orderBook: { bids: [{ price: price(points), volume: 100 }], asks: [{ price: price(points), volume: 100 }] } });

  test(`${side}: AI owns 1-3 points and the host only enforces the 4-point ceiling`, () => {
    for (const points of [0, 0.5, 0.99999, 1, 2, 3]) {
      assert.equal(positionProfitExit(position, market(points), now), null);
      if (points < 1) assert.equal(isNonLosingExit(position, price(points)), false);
    }
    for (const points of [4, 6]) {
      const result = positionProfitExit(position, market(points), now);
      assert.equal(result.decision.exitType, "TAKE_PROFIT");
      assert.equal(result.decision.action, side === "LONG" ? "SELL" : "BUY");
      assert.equal(result.decision.exitGuard.positionPoints.threshold, 4);
      assert.equal(result.decision.exitGuard.positionPoints.programCeiling, true);
      assert.equal(positionAmountGuardAllowsPrice(result.decision.exitGuard, position, price(3.99999)), false);
      assert.equal(exitGuardAllowsPrice(result.decision.exitGuard, price(3.99999), now), false);
      assert.equal(positionAmountGuardAllowsPrice(result.decision.exitGuard, position, price(4)), true);
    }
  });

  test(`${side}: quantity scales whole-position exit amounts while the ceiling remains per unit`, () => {
    for (const quantity of [1, 2, 3, 10]) {
      const holding = { ...position, quantity, roundTripFee: 0 };
      assert.equal(positionProfitExit(holding, market(0.5), now), null);
      const result = positionProfitExit(holding, market(4), now);
      assert.equal(result.grossPnl, quantity * 4);
      assert.equal(result.netPnl, quantity * 4);
      assert.equal(result.decision.exitGuard.positionPoints.threshold, 4);
      assert.equal(exitNetPnl(holding, price(4)).grossPnl, quantity * 4);
      assert.equal(positionAmountGuardAllowsPrice(result.decision.exitGuard, holding, price(3.5)), false);
      assert.equal(positionAmountGuardAllowsPrice(result.decision.exitGuard, holding, price(4)), true);
    }
  });

  test(`${side}: costs remain separate and a fee loss still exits at the hard ceiling`, () => {
    const costly = { ...position, quantity: 1, roundTripFee: 3 };
    assert.equal(positionProfitExit(costly, market(2), now), null);
    const result = positionProfitExit(costly, market(4), now);
    assert.equal(result.netPnl, 1);
    assert.equal(positionAmountGuardAllowsPrice(result.decision.exitGuard, { ...costly, roundTripFee: 3.5 }, price(4)), true);
    assert.equal(positionProfitExit({ ...position, roundTripFee: null }, market(2), now), null);
    const ceiling = positionProfitExit({ ...costly, roundTripFee: 10 }, market(4), now);
    assert.equal(ceiling.decision.exitType, "STOP_LOSS", "do not wait beyond 4 points or call a fee loss profit");
    assert.equal(positionAmountGuardAllowsPrice(ceiling.decision.exitGuard, { ...costly, roundTripFee: 10 }, price(3.99)), false);
  });

  test(`${side}: final confirmation preserves verified fees and rejects changed holdings or stale quotes`, () => {
    const p = { ...position, quantity: 1, roundTripFee: 2.5 };
    const guard = positionProfitExit(p, market(4), now).decision.exitGuard;
    assert.equal(positionAmountGuardAllowsPrice(guard, { ...p, roundTripFee: undefined }, price(4)), true);
    assert.equal(positionAmountGuardAllowsPrice(guard, { ...p, roundTripFee: 5 }, price(4)), false);
    assert.equal(positionAmountGuardAllowsPrice(guard, p, price(3.99)), false);
    for (const change of [{ positionOrderId: "other" }, { quantity: 2 }, { frozenQuantity: 1 }, { orderPrice: 101 }, { side: side === "LONG" ? "SHORT" : "LONG" }])
      assert.equal(positionAmountGuardAllowsPrice(guard, { ...p, ...change }, price(4)), false);
    for (const oldThreshold of [0, 5]) assert.equal(positionAmountGuardAllowsPrice({ ...guard, positionPoints: undefined,
      positionAmount: { threshold: oldThreshold, fees: 2.5 } }, p, price(4)), false);
    assert.equal(exitGuardAllowsPrice(guard, price(4), now + 10000), false);
    assert.equal(positionProfitExit(p, market(4), now + 5001), null);
    assert.equal(positionProfitExit(p, { ...market(4), account: { positionsVerified: false } }, now), null);
    assert.equal(positionProfitExit({ ...p, frozenQuantity: 1 }, market(4), now), null);
    assert.equal(positionProfitExit(p, { ...market(4), orderBook: {} }, now), null);
    assert.equal(positionProfitExit(p, { ...market(4), symbol: "OTHER" }, now), null);
  });

  test(`${side}: AI targets outside 1-4 points are rejected; protective stops survive`, () => {
    for (const points of [0.5, 0.99, 4.01, 5, 10]) {
      const result = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: side, quantity: 10, validForSec: 60,
        takeProfitPrice: price(points), stopLossPrice: price(-1) }] }, market(0), {}, now);
      assert.equal(result.plans[0].takeProfitPrice, null);
      assert.equal(result.plans[0].stopLossPrice, price(-1));
      assert.ok(result.rejected.length);
      const realtime = validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: side, quantity: 10, validForSec: 60,
        realtime_take_profit: { value_above: 1, take_profit_price: price(points) } }] }, market(0), {}, now);
      assert.equal(realtime.plans.length, 0);
    }
    for (const points of [1, 2, 4]) assert.equal(validateExitPlans({ exitPlans: [{ positionId: "P1", heldSide: side, quantity: 10,
      validForSec: 60, takeProfitPrice: price(points) }] }, market(0), {}, now).plans.length, 1);
  });
}
