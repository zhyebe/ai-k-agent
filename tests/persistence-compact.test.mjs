import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskRuntime, shouldPersistAuditEvent } from "../server/persistence.mjs";

test("MySQL runtime retains configured quantity and cancellation evidence", () => {
  const task = { entryQuantity: 3, decision: { action: "HOLD", orderAssessments: [{ orderId: "O-1", decision: "CANCEL" }], cancelOrderIds: ["O-1"], orderCancellation: { results: [{ orderId: "O-1", cancelled: true }] } } };
  const stored = JSON.parse(JSON.stringify(compactTaskRuntime(task)));
  const restored = compactTaskRuntime(stored);
  assert.equal(restored.entryQuantity, 3);
  assert.equal(compactTaskRuntime({}).entryQuantity, 1);
  assert.deepEqual(restored.decision.orderCancellation, task.decision.orderCancellation);
  assert.deepEqual(restored.decision.cancelOrderIds, ["O-1"]);
});

test("LIVE persistence preserves the selected entry mode", () => {
  for (const enabled of [false, true]) {
    assert.equal(compactTaskRuntime({ mode: "LIVE", autoDecisionEnabled: enabled }).autoDecisionEnabled, enabled);
  }
});

test("pending reconciliation survives restart independently of the latest action", () => {
  const previous = { id: "old-exit", status: "AWAITING_FILL", targetPositionIds: ["P-1"], baselinePositionQty: 1, suggestedQty: 1 };
  const latest = { id: "new-entry", status: "AWAITING_FILL" };
  const runtime = compactTaskRuntime({ pendingAction: latest, unsettledActions: [previous], lastEntryKWindow: 1234, decision: { observedAt: "2026-10-09T06:00:00Z", analysisDurationMs: 800 } });
  assert.equal(runtime.pendingAction, latest);
  assert.deepEqual(runtime.unsettledActions, [previous]);
  assert.equal(runtime.lastEntryKWindow, 1234);
  assert.equal(runtime.decision.analysisDurationMs, 800);
});

test("compactTaskRuntime does not persist market snapshots", () => {
  const runtime = compactTaskRuntime({
    workflow: ["monitor"],
    decision: { action: "BUY", evidenceIds: ["e1", "e2"], analysisSummary: "x".repeat(800), bullishProfitProbability: 0.52, bearishProfitProbability: 0.31, boardAssessments: [{ symbol: "DGJJ", history: [1, 2, 3], summary: "ok", bullishProfitProbability: 0.52 }] },
    market: {
      symbol: "DGJJ",
      history: Array.from({ length: 200 }, (_, i) => ({ t: i, c: i })),
      books: [{ symbol: "DGKZ", history: [{ c: 1 }], historyCount: 88, latest: { c: 12 } }],
    },
    positionTracking: { "P-1": { firstObservedAt: "2026-10-10T00:00:00.000Z", bestPrice: 123, worstPrice: 120 } },
  });
  assert.equal(runtime.market, null);
  assert.deepEqual(runtime.decision.evidenceIds, []);
  assert.equal(runtime.decision.analysisSummary.length, 400);
  assert.equal(runtime.decision.boardAssessments[0].history, undefined);
  assert.equal(runtime.decision.bullishProfitProbability, 0.52);
  assert.equal(runtime.decision.bearishProfitProbability, 0.31);
  assert.equal(runtime.decision.boardAssessments[0].bullishProfitProbability, 0.52);
  assert.equal(runtime.positionTracking["P-1"].bestPrice, 123);
});

test("compactTaskRuntime preserves AI forecast horizons and holding plan", () => {
  const runtime = compactTaskRuntime({
    decision: {
      action: "HOLD",
      forecastHorizon: { nextK: { direction: "DOWN" }, next10K: { direction: "UP" } },
      holdingPlan: { decision: "HOLD_THROUGH_PULLBACK", maxHoldK: 10, maxHoldMinutes: 10, rationale: "recover" },
    },
  });
  assert.equal(runtime.decision.forecastHorizon.next10K.direction, "UP");
  assert.equal(runtime.decision.holdingPlan.maxHoldK, 10);
});

test("only login and account events persist to audit logs", () => {
  assert.equal(shouldPersistAuditEvent("user_login"), true);
  assert.equal(shouldPersistAuditEvent("admin_login"), true);
  assert.equal(shouldPersistAuditEvent("analysis_completed"), false);
  assert.equal(shouldPersistAuditEvent("agent_output"), false);
});
