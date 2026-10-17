import { readFile } from "node:fs/promises";
import { approvedKnowledgeForAnalysis, buildApprovedExperiencePrompt } from "../../server/rag.mjs";

// Synthetic, fixed monitoring data. Never contacts a provider or a trading page.
export async function decisionLatencyContext(roundCount = 8) {
  const content = await readFile(new URL("../../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8");
  const evidence = approvedKnowledgeForAnalysis([{ id: "knowledge-fixture", title: "交易分析经验", status: "APPROVED", version: "fixture", content }]);
  const observedAt = "2026-10-17T07:00:00.000Z";
  const positions = Array.from({ length: 4 }, (_, i) => ({ positionOrderId: `P-${i}`, side: i % 2 ? "SHORT" : "LONG", quantity: 1, frozenQuantity: 0, orderPrice: 100 + i, symbol: "DGKZ" }));
  const exitPlans = positions.map(p => ({ positionId: p.positionOrderId, heldSide: p.side, quantity: 1, validForSec: 300, takeProfitPrice: p.side === "LONG" ? 108 : 96, stopLossPrice: p.side === "LONG" ? 94 : 110, rationale: "主趋势仍在，目标覆盖成本；结构失效时保护离场" }));
  const openOrders = positions.map((p, i) => ({ orderId: `O-${i}`, symbol: "DGKZ", side: p.side, quantity: 1, remainingQuantity: 1, price: 99 + i }));
  const orderAssessments = openOrders.map(o => ({ orderId: o.orderId, decision: "KEEP", reason: "原入场路径有效，预计成交收益优于撤单释放保证金" }));
  const market = { observedAt, symbol: "DGKZ", timeframe: "1m", latest: { price: 101, bid: 100, ask: 102 }, trend: "up", history: Array.from({ length: 60 }, (_, i) => ({ timestamp: Date.parse(observedAt) - (60 - i) * 60000, open: 99, high: 102, low: 98, close: 100, volume: 20 })) };
  const decision = {
    action: "HOLD", bullishProfitProbability: 0.61, bearishProfitProbability: 0.32, profitProbability: 0.61, confidence: 0.7,
    analysisSummary: "主判断：偏涨；下一K可能回踩，约10K延续上行；已有仓位等待合理目标，候选低位尚未到达，不追高。",
    forecastHorizon: { nextK: { direction: "DOWN", rationale: "近端回踩" }, next10K: { direction: "UP", rationale: "高低点抬升，趋势延续" } },
    holdingPlan: { decision: "HOLD_THROUGH_PULLBACK", maxHoldK: 10, maxHoldMinutes: 10, rationale: "正常回撤后仍有盈利路径；核对逐仓净收益和恢复依据", invalidation: "94" },
    exitPlans, orderAssessments, cancelOrderIds: [], entryPrice: 99, takeProfitPrice: 108, stopLossPrice: 94,
    keyLevels: ["支撑99", "目标108"], watchConditions: ["回踩99附近重新评估入场"], invalidation: "94",
  };
  return {
    market, strategy: { entryQuantity: 1 }, executionPolicy: { conditionalExits: true, rulesBlockExecution: false, entryMode: "MANUAL" },
    account: { positionsVerified: true, positions, openOrders, realtimeValueChange: 0 },
    evidence, evidenceIds: evidence.map(item => item.evidenceId), experiencePrompt: buildApprovedExperiencePrompt(evidence),
    approvedSkills: evidence.map(item => ({ skillId: item.skillId, content: item.excerpt })),
    previousAnalysis: { observedAt, decision: { ...decision, positionAudit: { positionsVerified: true, positions } }, exitPlans },
    conversation: { round: roundCount + 1, recentRounds: Array.from({ length: roundCount }, (_, i) => ({ round: i + 1, createdAt: observedAt, market: { ...market, history: undefined, fingerprint: `round-${i}` }, decision: { ...decision, analysisSummary: `历史第${i + 1}轮：${decision.analysisSummary}` } })) },
  };
}

export function latencyDecision(context) {
  return { action: "HOLD", bullish_profit_probability: 0.61, bearish_profit_probability: 0.32,
    holding_plan: { decision: "HOLD_THROUGH_PULLBACK" }, exit_plans: context.previousAnalysis.exitPlans,
    order_assessments: context.previousAnalysis.decision.orderAssessments };
}

export function decisionEnvelope(apiFormat, decision) {
  const text = JSON.stringify(decision);
  if (apiFormat === "anthropic") return { content: [{ type: "text", text }], stop_reason: "end_turn" };
  if (apiFormat === "responses") return { output_text: text, status: "completed" };
  if (apiFormat === "gemini") return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] };
  return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}
