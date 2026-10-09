import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskRuntime, shouldPersistAuditEvent } from "../server/persistence.mjs";

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
  });
  assert.equal(runtime.market, null);
  assert.deepEqual(runtime.decision.evidenceIds, []);
  assert.equal(runtime.decision.analysisSummary.length, 400);
  assert.equal(runtime.decision.boardAssessments[0].history, undefined);
  assert.equal(runtime.decision.bullishProfitProbability, 0.52);
  assert.equal(runtime.decision.bearishProfitProbability, 0.31);
  assert.equal(runtime.decision.boardAssessments[0].bullishProfitProbability, 0.52);
});

test("only login and account events persist to audit logs", () => {
  assert.equal(shouldPersistAuditEvent("user_login"), true);
  assert.equal(shouldPersistAuditEvent("admin_login"), true);
  assert.equal(shouldPersistAuditEvent("analysis_completed"), false);
  assert.equal(shouldPersistAuditEvent("agent_output"), false);
});
