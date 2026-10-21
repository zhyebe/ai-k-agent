import assert from "node:assert/strict";
import test from "node:test";
import { currentOrderCancellationPlan } from "../server/order-cancellation-policy.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";

const start = Date.parse("2026-10-21T10:00:00+08:00");
const account = orders => ({ openOrdersVerified: true, openOrders: orders });
const order = (id, orderTime) => ({ orderId: id, orderTime, remainingQuantity: 2, status: "已委托" });

test("new/partial orders wait exactly 30 seconds, independent of price and machine timezone", () => {
  for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const prior = process.env.TZ;
    process.env.TZ = timezone;
    try {
      const task = {}, data = account([order("new", "2026-10-21 10:00:00"), order("old", "2026-10-21T01:59:00Z")]);
      for (const elapsed of [0, 10_000, 29_999]) {
        data.openOrders[0].remainingQuantity = 1;
        data.openOrders[0].orderPrice = elapsed;
        assert.deepEqual(currentOrderCancellationPlan(task, data, start + elapsed).orderIds, ["old"]);
      }
      assert.deepEqual(currentOrderCancellationPlan(task, data, start + 30_000).orderIds, ["new", "old"]);
    } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
  }
});

test("unknown/invalid/future order times wait from first verified observation and survive restart", () => {
  for (const time of [undefined, "", "invalid", "10:00:00", "2026-02-30 10:00:00", "2026-10-21 10:01:00"]) {
    const task = {}, data = account([order("O1", time)]);
    assert.deepEqual(currentOrderCancellationPlan(task, data, start).orderIds, []);
    assert.equal(currentOrderCancellationPlan(task, data, start + 20_000).waiting[0].remainingMs, 10_000);
    const restored = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime(task))));
    assert.deepEqual(currentOrderCancellationPlan(restored, data, start + 30_000).orderIds, ["O1"]);
  }
});

test("filled orders never cancel; unverified tables do not clear clocks or prove absence", () => {
  const task = {}, data = account([order("O1")]);
  currentOrderCancellationPlan(task, data, start);
  assert.deepEqual(currentOrderCancellationPlan(task, { openOrdersVerified: false, openOrders: [] }, start + 20_000).orderIds, []);
  assert.deepEqual(currentOrderCancellationPlan(task, data, start + 30_000).orderIds, ["O1"]);
  data.openOrders[0].remainingQuantity = 0;
  assert.deepEqual(currentOrderCancellationPlan(task, data, start + 31_000).orderIds, []);
  assert.deepEqual(task.currentOrderTracking, {});
  assert.deepEqual(currentOrderCancellationPlan(task, account([order("O1")]), start + 32_000).orderIds, []);
});

test("later timestamp changes never restart an observed order's fill window", () => {
  const task = {}, data = account([order("O1", "2026-10-21 10:01:00")]);
  currentOrderCancellationPlan(task, data, start);
  assert.deepEqual(currentOrderCancellationPlan(task, data, start + 60_000).orderIds, ["O1"]);
  data.openOrders[0].orderTime = "2026-10-21 10:01:10";
  data.openOrders[0].remainingQuantity = 1;
  assert.deepEqual(currentOrderCancellationPlan(task, data, start + 70_000).orderIds, ["O1"]);
});
