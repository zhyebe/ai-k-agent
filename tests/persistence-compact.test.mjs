import assert from "node:assert/strict";
import test from "node:test";
import { compactTaskRuntime, shouldPersistAuditEvent } from "../server/persistence.mjs";

test("enabled provider is a desktop preference and excluded from durable task runtime", () => {
  assert.equal("providerId" in compactTaskRuntime({ providerId: "stepfun-local-selection" }), false);
});

test("decision correlation and compact model diagnostics survive restart without raw output", () => {
  const modelDiagnostics = { wireApi: "anthropic", jsonStatus: "INVALID_JSON", contentTypes: ["thinking", "text"], stopReason: "end_turn", textLength: 40, contentHash: "a".repeat(64) };
  const runtime = compactTaskRuntime({
    decision: { runId: "current-run", action: "HOLD", modelDiagnostics: { ...modelDiagnostics, rawOutput: "private model output", reasoning: "private thinking" } },
    pendingAction: { id: "prior-order", decisionRunId: "prior-run", status: "AWAITING_FILL" },
  });
  assert.equal(runtime.decision.runId, "current-run");
  assert.equal(runtime.pendingAction.decisionRunId, "prior-run");
  assert.deepEqual(runtime.decision.modelDiagnostics, modelDiagnostics);
  assert.doesNotMatch(JSON.stringify(runtime), /private model output|private thinking/);
});

test("MySQL runtime retains configured quantity and cancellation evidence", () => {
  const task = { entryQuantity: 3, decision: { action: "HOLD", orderAssessments: [{ orderId: "O-1", decision: "CANCEL" }], cancelOrderIds: ["O-1"], orderCancellation: { results: [{ orderId: "O-1", cancelled: true }] } } };
  const stored = JSON.parse(JSON.stringify(compactTaskRuntime(task)));
  const restored = compactTaskRuntime(stored);
  assert.equal(restored.entryQuantity, 3);
  assert.equal(compactTaskRuntime({}).entryQuantity, 1);
  assert.deepEqual(restored.decision.orderCancellation, task.decision.orderCancellation);
  assert.deepEqual(restored.decision.cancelOrderIds, ["O-1"]);
});

test("performance diagnostics survive restart with only numeric usage and per-attempt timings", () => {
  const timing = { requestBytes: 64000, responseDurationMs: 38041, providerAttempts: 1 };
  const usage = { inputTokens: 12000, outputTokens: 1800, reasoningTokens: 900, cachedInputTokens: 0 };
  const diagnostics = { wireApi: "chat", ...timing, usage: { ...usage, prompt: "private prompt", cacheCreationInputTokens: -1 }, attempts: [{ ...timing, usage: { ...usage, reasoning: "private thinking" } }] };
  const restored = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime({ decision: { action: "BUY", modelDiagnostics: diagnostics } }))));
  assert.deepEqual(restored.decision.modelDiagnostics.usage, usage);
  assert.deepEqual(restored.decision.modelDiagnostics.attempts[0].usage, usage);
  for (const [key, value] of Object.entries(timing)) assert.equal(restored.decision.modelDiagnostics[key], value);
  assert.doesNotMatch(JSON.stringify(restored), /private/);
});

test("last model failure survives successful rounds and restart with both sanitized attempts", () => {
  const failed = { wireApi: "anthropic", jsonStatus: "INVALID_JSON", jsonError: "TRUNCATED_JSON", contentTypes: ["text"], stopReason: "end_turn", textLength: 22, contentHash: "a".repeat(64) };
  const complete = { ...failed, jsonStatus: "COMPLETE_JSON", jsonError: "", contentHash: "b".repeat(64) };
  const runtime = compactTaskRuntime({
    decision: { action: "SELL", modelDiagnostics: complete },
    lastModelFailure: { runId: "failure-run", providerId: "same-provider", createdAt: "2026-10-13T06:44:44Z", code: "INVALID_MODEL_JSON", recovered: true, modelDiagnostics: { ...complete, rawOutput: "private final text", attempts: [{ ...failed, reasoning: "private reasoning" }, { ...complete, rawOutput: "private corrected text" }] } },
  });
  const restored = compactTaskRuntime(JSON.parse(JSON.stringify(runtime)));
  assert.equal(restored.lastModelFailure.runId, "failure-run");
  assert.equal(restored.lastModelFailure.recovered, true);
  assert.deepEqual(restored.lastModelFailure.modelDiagnostics.attempts, [failed, complete]);
  assert.equal(restored.decision.modelDiagnostics.jsonStatus, "COMPLETE_JSON");
  assert.doesNotMatch(JSON.stringify(restored), /private/);
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
      forecastHorizon: { next3K: { direction: "DOWN", path: "未来3分钟回撤" }, nextK: { direction: "DOWN" }, next10K: { direction: "UP" } },
      holdingPlan: { decision: "HOLD_THROUGH_PULLBACK", maxHoldK: 10, maxHoldMinutes: 10, rationale: "recover" },
    },
  });
  assert.equal(runtime.decision.forecastHorizon.next10K.direction, "UP");
  assert.equal(runtime.decision.holdingPlan.maxHoldK, 10);
});

test("saving and restoring a blocked entry preserves its actual cause and future forecast", () => {
  const decision = { action: "HOLD", marketRegime: "RANGE",
    entryBlock: { requestedAction: "BUY", reason: "RANGE_MARKET_NO_ENTRY" },
    boardAssessments: [{ symbol: "A", action: "BUY", marketRegime: "RANGE" }],
    analysisSummary: "主判断：震荡", watchConditions: ["预计10分钟内试1331"],
    forecastHorizon: { next3K: { direction: "DOWN", path: "未来3分钟回撤" }, nextK: { direction: "RANGE", path: "区间往返" }, next10K: { direction: "UP", path: "试1331" } } };
  const restored = compactTaskRuntime(JSON.parse(JSON.stringify(compactTaskRuntime({ decision })))).decision;
  for (const field of ["marketRegime", "entryBlock", "analysisSummary", "watchConditions", "forecastHorizon"])
    assert.deepEqual(restored[field], decision[field]);
  assert.equal(restored.boardAssessments[0].marketRegime, "RANGE");
});

test("only login and account events persist to audit logs", () => {
  assert.equal(shouldPersistAuditEvent("user_login"), true);
  assert.equal(shouldPersistAuditEvent("admin_login"), true);
  assert.equal(shouldPersistAuditEvent("analysis_completed"), false);
  assert.equal(shouldPersistAuditEvent("agent_output"), false);
});
