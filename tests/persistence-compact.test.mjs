import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskRuntime, shouldPersistAuditEvent } from "../server/persistence.mjs";

test("compactTaskRuntime does not persist market snapshots", () => {
  const runtime = compactTaskRuntime({
    workflow: ["monitor"],
    decision: { action: "BUY", evidenceIds: ["e1", "e2"], analysisSummary: "x".repeat(800), boardAssessments: [{ symbol: "DGJJ", history: [1, 2, 3], summary: "ok" }] },
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
});

test("only login and account events persist to audit logs", () => {
  assert.equal(shouldPersistAuditEvent("user_login"), true);
  assert.equal(shouldPersistAuditEvent("admin_login"), true);
  assert.equal(shouldPersistAuditEvent("analysis_completed"), false);
  assert.equal(shouldPersistAuditEvent("agent_output"), false);
});
