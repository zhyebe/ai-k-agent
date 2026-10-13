import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExitPlan, exitGuardAllowsPrice, parseSessionClose, sessionCloseWindow, validateExitPlans } from "../server/exit-policy.mjs";

const observed = Date.parse("2026-10-13T10:00:00+08:00");
const position = { positionOrderId: "P-1", symbol: "DGKZ", side: "买入", quantity: 2 };
const market = { symbol: "DGKZ", observedAt: new Date(observed).toISOString(), account: { positionsVerified: true, positions: [position] }, orderBook: { bids: [{ price: 104, volume: 20 }], asks: [{ price: 106, volume: 20 }] } };
const source = { positionId: "P-1", heldSide: "LONG", quantity: 2, validForSec: 120, takeProfitPrice: 105, stopLossPrice: 99 };

test("daily closing uses Beijing time, configurable lead, and resets the next day", () => {
  assert.equal(sessionCloseWindow({}, Date.parse("2026-10-13T15:54:59+08:00")).active, false);
  assert.equal(sessionCloseWindow({}, Date.parse("2026-10-13T15:55:00+08:00")).active, true);
  assert.equal(sessionCloseWindow({}, Date.parse("2026-10-13T16:00:00+08:00")).overdue, true);
  assert.equal(sessionCloseWindow({}, Date.parse("2026-10-14T09:00:00+08:00")).active, false);
  assert.equal(sessionCloseWindow({ sessionClose: { time: "15:30", leadMinutes: 10 } }, Date.parse("2026-10-13T15:20:00+08:00")).active, true);
  for (const value of [{ time: "25:00", leadMinutes: 5 }, { time: "16:00", leadMinutes: 0 }, { time: "16:00", leadMinutes: 1.5 }, null]) assert.equal(parseSessionClose(value), null);
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

test("confirmation rejects a changed price or expiry after a condition initially triggered", () => {
  const guard = { comparison: "GTE", triggerPrice: 105, expiresAt: new Date(observed + 120000).toISOString() };
  assert.equal(exitGuardAllowsPrice(guard, 104, observed), false);
  assert.equal(exitGuardAllowsPrice(guard, 105, observed), true);
  assert.equal(exitGuardAllowsPrice(guard, 106, observed + 120000), false);
});
