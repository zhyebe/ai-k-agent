import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExitPlan, exitGuardAllowsPrice, exitNetPnl, isNonLosingExit, parseSessionClose, positionAmountExit, positionProfitExit, positionAmountGuardAllowsPrice, sessionCloseWindow, validateExitPlans } from "../server/exit-policy.mjs";

const observed = Date.parse("2026-10-13T10:00:00+08:00");
const position = { positionOrderId: "P-1", symbol: "DGKZ", side: "买入", quantity: 2, orderPrice: 102 };
const market = { symbol: "DGKZ", observedAt: new Date(observed).toISOString(), account: { positionsVerified: true, positions: [position] }, orderBook: { bids: [{ price: 104, volume: 20 }], asks: [{ price: 106, volume: 20 }] } };
const source = { positionId: "P-1", heldSide: "LONG", quantity: 2, validForSec: 120, takeProfitPrice: 105, stopLossPrice: 99 };

for (const side of ["LONG", "SHORT"]) {
  test(`${side}: -3 whole-position stop includes quantity and costs, independent of account total`, () => {
    const p = { ...position, side, orderPrice: 100, roundTripFee: 1 };
    const snapshot = amount => {
      const price = 100 + (side === "LONG" ? 1 : -1) * (amount + 1) / 2;
      return { ...market, account: { positionsVerified: true, positions: [p], realtimeValueChange: 100 },
        orderBook: { bids: [{ price, volume: 20 }], asks: [{ price, volume: 20 }] } };
    };
    for (const amount of [-2.99, -1, 0, 2, 10]) assert.equal(positionAmountExit(p, snapshot(amount), observed), null);
    for (const amount of [-10, -3]) {
      const result = positionAmountExit(p, snapshot(amount), observed);
      assert.equal(result.decision.exitType, "STOP_LOSS");
      assert.equal(result.decision.action, side === "LONG" ? "SELL" : "BUY");
      assert.equal(result.netPnl, amount);
      const guard = result.decision.exitGuard;
      assert.equal(guard.positionAmount.threshold, -3);
      assert.equal(positionAmountGuardAllowsPrice(guard, p, result.quotePrice), true);
      for (const change of [{ orderPrice: 101 }, { quantity: 1 }, { frozenQuantity: 1 }, { side: side === "LONG" ? "SHORT" : "LONG" }])
        assert.equal(positionAmountGuardAllowsPrice(guard, { ...p, ...change }, result.quotePrice), false);
      if (amount === -3) {
        assert.equal(positionAmountGuardAllowsPrice(guard, { ...p, roundTripFee: 0 }, result.quotePrice), false);
        assert.equal(positionAmountGuardAllowsPrice(guard, p, result.quotePrice + (side === "LONG" ? 0.01 : -0.01)), false);
      }
    }
    assert.equal(positionAmountExit(p, snapshot(-3), observed + 5001), null);
    assert.equal(positionAmountExit(p, { ...snapshot(-3), account: { positionsVerified: false } }, observed), null);
    assert.equal(positionAmountExit({ ...p, frozenQuantity: 1 }, snapshot(-3), observed), null);
  });

  test(`${side}: exact decimal stop boundary does not round an interior amount`, () => {
    const p = { ...position, side, orderPrice: 100, quantity: 4, roundTripFee: 0.2 };
    const price = 100 + (side === "LONG" ? 1 : -1) * (-3 + 0.2) / 4;
    const snapshot = { ...market, orderBook: { bids: [{ price, volume: 20 }], asks: [{ price, volume: 20 }] } };
    const candidate = positionAmountExit(p, snapshot, observed);
    assert.ok(candidate);
    assert.equal(positionAmountGuardAllowsPrice(candidate.decision.exitGuard, p, price), true);
    const inside = price + (side === "LONG" ? 0.00001 : -0.00001);
    assert.equal(positionAmountGuardAllowsPrice(candidate.decision.exitGuard, p, inside), false);
    snapshot.orderBook = { bids: [{ price: inside, volume: 20 }], asks: [{ price: inside, volume: 20 }] };
    assert.equal(positionAmountExit(p, snapshot, observed), null);
  });
}

test("unknown fees stay unknown when user price-point boundary executes", () => {
  const result = positionProfitExit({ ...position, quantity: 3 }, market, observed);
  assert.equal(result.grossPnl, 6);
  assert.equal(result.netPnl, null);
  assert.equal(result.decision.exitGuard.positionPoints.fees, null);
});

test("closing uses the saved stop time, with the lead counted back from that instant", () => {
  const saved = { tradingSession: { opensAt: "2026-10-13T09:00", closesAt: "2026-10-13T16:00" }, sessionClose: { leadMinutes: 5 } };
  assert.equal(sessionCloseWindow(saved, Date.parse("2026-10-13T15:54:59+08:00")).active, false);
  assert.equal(sessionCloseWindow(saved, Date.parse("2026-10-13T15:55:00+08:00")).active, true);
  assert.equal(sessionCloseWindow(saved, Date.parse("2026-10-13T16:00:00+08:00")).overdue, true);
  assert.equal(sessionCloseWindow({ tradingSession: { opensAt: "2026-10-13T09:00", closesAt: "2026-10-13T15:30" }, sessionClose: { leadMinutes: 10 } }, Date.parse("2026-10-13T15:20:00+08:00")).active, true);
  assert.equal(sessionCloseWindow({}, Date.parse("2026-10-14T09:00:00+08:00")).active, false);
  for (const value of [{ leadMinutes: 0 }, { leadMinutes: 1.5 }, null]) assert.equal(parseSessionClose(value), null);
  assert.deepEqual(parseSessionClose({ time: "16:00", leadMinutes: 5 }), { leadMinutes: 5, timezone: "Asia/Shanghai" });
});

test("AI validity starts at original observation; a slow response cannot renew expired plans", () => {
  const result = validateExitPlans({ exitPlans: [source] }, market, {}, observed + 120000);
  assert.equal(result.plans.length, 0);
  assert.equal(result.rejected[0].code, "EXIT_PLAN_EXPIRED");
  const fresh = validateExitPlans({ exitPlans: [source] }, market, {}, observed + 45000).plans[0];
  assert.equal(Date.parse(fresh.expiresAt), observed + 120000);
});

test("exit checks executable bid for longs, ask for shorts, and never manufactures a trigger", () => {
  const plan = validateExitPlans({ exitPlans: [source] }, market, {}, observed).plans[0];
  assert.equal(evaluateExitPlan(plan, market, observed).status, "ARMED");
  const favorable = { ...market, orderBook: { bids: [{ price: 105, volume: 20 }], asks: [{ price: 107, volume: 20 }] } };
  let result = evaluateExitPlan(plan, favorable, observed);
  assert.equal(result.decision.action, "SELL");
  assert.equal(result.decision.exitType, "TAKE_PROFIT");
  const short = { ...source, heldSide: "SHORT", takeProfitPrice: 100, stopLossPrice: 110 };
  const shortMarket = { ...market, account: { positionsVerified: true, positions: [{ ...position, side: "卖出" }] }, orderBook: { bids: [{ price: 98, volume: 20 }], asks: [{ price: 101, volume: 20 }] } };
  const shortPlan = validateExitPlans({ exitPlans: [short] }, shortMarket, {}, observed).plans[0];
  assert.equal(evaluateExitPlan(shortPlan, shortMarket, observed).status, "ARMED");
  result = evaluateExitPlan(shortPlan, { ...shortMarket, orderBook: { ...shortMarket.orderBook, asks: [{ price: 100, volume: 20 }] } }, observed);
  assert.equal(result.decision.action, "BUY");
});

test("unknown holdings, changed quantity, absent or stale quotes cannot trigger exits", () => {
  const plan = validateExitPlans({ exitPlans: [source] }, market, {}, observed).plans[0];
  assert.equal(evaluateExitPlan(plan, { ...market, account: { positionsVerified: false, positions: [] } }, observed).status, "POSITIONS_UNVERIFIED");
  assert.equal(evaluateExitPlan(plan, { ...market, account: { positionsVerified: true, positions: [{ ...position, quantity: 1 }] } }, observed).status, "POSITION_CHANGED");
  assert.equal(evaluateExitPlan(plan, market, observed + 6000).status, "QUOTE_UNVERIFIED");
  assert.equal(evaluateExitPlan(plan, { ...market, orderBook: {} }, observed).status, "QUOTE_UNVERIFIED");
  const invalid = validateExitPlans({ exitPlans: [{ ...source, stopLossPrice: 110 }, { ...source, positionId: "other" }] }, market, {}, observed);
  assert.equal(invalid.plans.length, 0);
});

for (const heldSide of ["LONG", "SHORT"]) {
  test(`${heldSide} ignores flash display prices but still executes AI conditions on verified bid/ask`, () => {
    const long = heldSide === "LONG";
    const observedMarket = { ...market, account: { positionsVerified: true, positions: [{ ...position, side: long ? "买入" : "卖出" }] } };
    const plan = validateExitPlans({ exitPlans: [{ ...source, heldSide, takeProfitPrice: long ? 106 : 98, stopLossPrice: long ? 95 : 110 }] }, observedMarket, {}, observed).plans[0];
    for (const flashPrice of [90, 120]) {
      const displayed = { ...observedMarket, latest: { price: flashPrice }, quote: { price: flashPrice }, history: [{ timestamp: observed, close: flashPrice }], ticks: [{ timestamp: observed, price: flashPrice }] };
      assert.equal(evaluateExitPlan(plan, displayed, observed).status, "ARMED");
      for (const [price, exitType] of [[long ? 106 : 98, "TAKE_PROFIT"], [long ? 95 : 110, "STOP_LOSS"]]) {
        const executable = { ...displayed, orderBook: { bids: [{ price: long ? price : price - 1, volume: 20 }], asks: [{ price: long ? price + 1 : price, volume: 20 }] } };
        const result = evaluateExitPlan(plan, executable, observed);
        assert.equal(result.status, "TRIGGERED");
        assert.equal(result.decision.exitType, exitType);
        assert.equal(result.decision.action, long ? "SELL" : "BUY");
      }
    }
  });
}

test("止盈计划必须高于真实多单入场价，不能把亏损当止盈", () => {
  const result = validateExitPlans({ exitPlans: [{ ...source, takeProfitPrice: 99, stopLossPrice: 95 }] }, market, {}, observed);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].takeProfitPrice, null);
  assert.equal(result.plans[0].stopLossPrice, 95);
  assert.ok(result.rejected.some(item => item.code === "EXIT_PLAN_TAKE_PROFIT_NOT_PROFITABLE"));
  const armed = evaluateExitPlan(result.plans[0], { ...market, orderBook: { bids: [{ price: 101, volume: 20 }], asks: [{ price: 102, volume: 20 }] } }, observed);
  assert.equal(armed.status, "ARMED");
});

test("止盈计划必须低于真实空单入场价，空单下跌才是盈利", () => {
  const shortPosition = { ...position, side: "卖出", orderPrice: 102 };
  const shortMarket = { ...market, account: { positionsVerified: true, positions: [shortPosition] }, orderBook: { bids: [{ price: 100, volume: 20 }], asks: [{ price: 101, volume: 20 }] } };
  const result = validateExitPlans({ exitPlans: [{ positionId: "P-1", heldSide: "SHORT", quantity: 2, validForSec: 120, takeProfitPrice: 103, stopLossPrice: 110 }] }, shortMarket, {}, observed);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].takeProfitPrice, null);
  assert.ok(result.rejected.some(item => item.code === "EXIT_PLAN_TAKE_PROFIT_NOT_PROFITABLE"));
  const profitable = validateExitPlans({ exitPlans: [{ positionId: "P-1", heldSide: "SHORT", quantity: 2, validForSec: 120, takeProfitPrice: 100, stopLossPrice: 110 }] }, shortMarket, {}, observed).plans[0];
  assert.equal(evaluateExitPlan(profitable, { ...shortMarket, orderBook: { ...shortMarket.orderBook, asks: [{ price: 100, volume: 20 }] } }, observed).decision.action, "BUY");
});

test("confirmation rejects a changed price or expiry after a condition initially triggered", () => {
  const guard = { comparison: "GTE", triggerPrice: 105, expiresAt: new Date(observed + 120000).toISOString() };
  assert.equal(exitGuardAllowsPrice(guard, 104, observed), false);
  assert.equal(exitGuardAllowsPrice(guard, 105, observed), true);
  assert.equal(exitGuardAllowsPrice(guard, 106, observed + 120000), false);
});

for (const heldSide of ["LONG", "SHORT"]) {
  test(`${heldSide}: realtime profit conditions require explicit AI prices, positive position profit and the current account amount`, () => {
    const isLong = heldSide === "LONG";
    const p = { ...position, orderPrice: 100, quantity: 1, side: isLong ? "买入" : "卖出", roundTripFee: 2 };
    const snapshot = { ...market, account: { positionsVerified: true, positions: [p], realtimeValueChange: 2.5 },
      orderBook: { bids: [{ price: isLong ? 103 : 96, volume: 10 }], asks: [{ price: isLong ? 104 : 97, volume: 10 }] } };
    const input = { positionId: p.positionOrderId, heldSide, quantity: 1, validForSec: 120,
      realtime_take_profit: { value_above: 1, take_profit_price: isLong ? 103 : 97 } };
    const plan = validateExitPlans({ exitPlans: [input] }, snapshot, {}, observed).plans[0];
    assert.ok(plan, "an explicit realtime condition can stand alone");
    const triggered = evaluateExitPlan(plan, snapshot, observed);
    assert.equal(triggered.decision.exitType, "TAKE_PROFIT");
    assert.equal(triggered.decision.exitGuard.realtimeValueAbove, 1);
    assert.equal(triggered.decision.exitGuard.triggerPrice, isLong ? 103 : 97);
    for (const amount of [undefined, null, "", false, "unknown", -2, 0, 1]) {
      assert.equal(evaluateExitPlan(plan, { ...snapshot, account: { ...snapshot.account, realtimeValueChange: amount, dayPnl: 9, valueChange: 9 } }, observed).status, "ARMED");
    }
    for (const price of [100, isLong ? 102 : 98, isLong ? 99 : 101]) {
      const next = { ...snapshot, orderBook: { bids: [{ price, volume: 10 }], asks: [{ price, volume: 10 }] } };
      assert.equal(evaluateExitPlan(plan, next, observed).status, "ARMED", "positive account totals never authorize flat or losing holdings");
    }
    assert.equal(evaluateExitPlan(plan, snapshot, observed + 120000).status, "EXPIRED");
    const invalid = validateExitPlans({ exitPlans: [{ ...input, stopLossPrice: isLong ? 90 : 110,
      realtime_take_profit: { value_above: 1, take_profit_price: 100 } }] }, snapshot, {}, observed);
    assert.equal(invalid.plans.length, 1, "invalid optional profit conditions do not erase valid protection");
    assert.equal(invalid.plans[0].realtimeTakeProfit, null);
    assert.equal(invalid.rejected[0].code, "EXIT_PLAN_REALTIME_PROFIT_INVALID");
  });
}

test("费用已知时拒绝毛利净亏，未知费用不伪报净收益", () => {
  const p = { ...position, roundTripFee: 4 };
  assert.equal(exitNetPnl(p, 103).grossPnl, 2);
  assert.equal(exitNetPnl(p, 103).netPnl, -2);
  assert.equal(isNonLosingExit(p, 103), false);
  assert.equal(isNonLosingExit(p, 104), true);
  assert.equal(isNonLosingExit(p, 105), true);
  assert.equal(exitNetPnl(position, 105).netPnl, null);
  assert.equal(exitNetPnl({ ...position, roundTripFee: null, totalFees: 8 }, 105).netPnl, -2);
  assert.equal(isNonLosingExit({ ...position, orderPrice: null }, 105), false);
});

test("持仓成本改变后旧计划失效，防止同号持仓被按旧盈利目标平掉", () => {
  const plan = validateExitPlans({ exitPlans: [source] }, market, {}, observed).plans[0];
  const changed = { ...market, account: { positionsVerified: true, positions: [{ ...position, orderPrice: 110 }] } };
  assert.equal(evaluateExitPlan(plan, changed, observed).status, "POSITION_CHANGED");
});

test("账户实时货值变化不单独生成离场动作", () => {
  const p = { ...position, orderPrice: 100, quantity: 1, roundTripFee: 0.5 };
  const snapshot = { ...market, account: { positionsVerified: true, realtimeValueChange: 2, positions: [p] },
    orderBook: { bids: [{ price: 102, volume: 20 }], asks: [{ price: 103, volume: 20 }] } };
  const noPlans = validateExitPlans({ exitPlans: [] }, snapshot, {}, observed);
  assert.deepEqual(noPlans.plans, []);
});
