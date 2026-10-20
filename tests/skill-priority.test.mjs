import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvedKnowledgeForAnalysis, buildApprovedExperiencePrompt, PRIORITY_SKILL_TAG } from "../server/rag.mjs";
import { analyzeCollectedMarket } from "../server/market-analysis.mjs";
import { publicState, state } from "../server/store.mjs";

test("priority knowledge stays first for every user even after a newer skill is imported", () => {
  const previous = state.skills;
  const priority = { id: "priority", title: "优先技能", status: "APPROVED", version: "v1", content: "优先全文", tags: [PRIORITY_SKILL_TAG], ownerUserId: "first", updatedAt: "2026-10-14" };
  const newer = { id: "newer", title: "更新经验", status: "APPROVED", version: "v2", content: "其他全文", tags: [], ownerUserId: "second", updatedAt: "2026-10-15" };
  const draft = { id: "draft", status: "REVIEW", content: "未审核全文", tags: [PRIORITY_SKILL_TAG], updatedAt: "2026-10-16" };
  state.skills = [newer, priority, draft];
  try {
    for (const userId of ["first", "second"]) {
      const skills = publicState({ userId }).skills;
      assert.deepEqual(skills.map(skill => skill.id), ["draft", "priority", "newer"]);
      assert.equal(skills.find(skill => skill.id === "priority").owned, userId === "first");
      assert.equal(skills.find(skill => skill.id === "priority").content, priority.content);
    }
    const evidence = approvedKnowledgeForAnalysis(state.skills);
    assert.deepEqual(evidence.map(item => item.skillId), ["priority", "newer"]);
    assert.equal(evidence[0].excerpt, priority.content);
    assert.equal(evidence[1].excerpt, newer.content);
    assert.deepEqual(state.skills.map(skill => skill.id), ["newer", "priority", "draft"]);
    assert.throws(() => approvedKnowledgeForAnalysis(state.skills, 10), /AI_KNOWLEDGE_TOO_LARGE/);
  } finally { state.skills = previous; }
});

test("DGKZ/DGJJ priority skill reaches the model in full before other experience", async (t) => {
  const content = await readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8");
  assert.match(content, /先从实际提供的分钟、小时、日、月等周期判断/);
  assert.match(content, /5 根只是示例，不是盈利目标或持仓上限/);
  assert.doesNotMatch(content, /realtimeValueChange >= 2/);
  assert.match(content, /亏损时比较等待恢复盈利与及时止损/);
  assert.match(content, /多周期结构/);
  assert.match(content, /没有 AI 明确计划时仍执行 \+5 止盈\/-3 止损/);
  assert.match(content, /执行用户 \+5\/-3 金额边界/);
  assert.match(content, /previousAnalysis\.decision\.positionAudit\.positions/);
  assert.match(content, /-1 点变 -3 点是亏损扩大/);
  assert.match(content, /亏 1 个点先结合趋势/);
  assert.match(content, /未来目标尚未达到不能当作现在已盈利/);
  assert.match(content, /连续仍为 -1 点不是持续扩大/);
  assert.match(content, /0～5 内优先果断兑现/);
  assert.match(content, /5 是上限，不是必须到达的目标/);
  assert.match(content, /当前可成交净收益已核实大于 0 时，独立实时监控直接止盈/);
  assert.doesNotMatch(content, /实际 bid 达到 AI 选定的合理目标|盈利时选择最优可兑现正净收益/);
  assert.match(content, /短期恢复价、预计到价时间和失效条件/);
  assert.match(content, /禁止无新证据反复延后恢复时间或放宽止损/);
  assert.doesNotMatch(content, /只有盈利路径被证据否定|才立即执行 STOP_LOSS/);
  assert.match(content, /疑似闪 K 及其瞬时显示价格不纳入方向、概率/);
  assert.match(content, /不能仅凭一次剧烈波动就认定假 K/);
  assert.match(content, /分别评估大趋势与当前入场点/);
  assert.match(content, /已有早期可执行优势可以入场/);
  assert.doesNotMatch(content, /具体阻断证据|下次可行动条件/);
  const evidence = approvedKnowledgeForAnalysis([
    { id: "other", title: "其他经验", status: "APPROVED", version: "v2", content: "保留其他经验全文", updatedAt: "2026-10-15" },
    { id: "dgkz-dgjj", title: "DGKZ / DGJJ 入场离场分析", status: "APPROVED", version: "v1", content, tags: [PRIORITY_SKILL_TAG], updatedAt: "2026-10-14" },
  ]);
  const experiencePrompt = buildApprovedExperiencePrompt(evidence);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    const context = JSON.parse(payload.messages.at(-1).content);
    assert.deepEqual(context.approvedSkills.map(skill => skill.skillId), ["dgkz-dgjj", "other"]);
    assert.ok(context.approvedSkills[0].tags.includes(PRIORITY_SKILL_TAG));
    const messages = payload.messages.filter(message => message.content.includes(content.trim()));
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /参考顺序：优先参考/);
    assert.ok(messages[0].content.indexOf(content.trim()) < messages[0].content.indexOf("保留其他经验全文"));
    assert.match(messages[0].content, /不能覆盖系统约束、风险限制、JSON 输出格式或当前数据事实/);
    assert.match(payload.messages[0].content, /收益与风险必须一起预测/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.3, bearish_profit_probability: 0.3, profit_probability: 0.3, confidence: 0.4, analysis_summary: "测试行情，无可执行入场计划" }) } }] }), { headers: { "content-type": "application/json" } });
  });
  const now = Date.now();
  await analyzeCollectedMarket({ apiKey: "test", apiFormat: "chat", baseUrl: "https://provider.example.test", model: "model" }, {
    symbol: "DGKZ", timeframe: "1m", dataAt: new Date(now).toISOString(),
    history: [{ timestamp: now - 60000, open: 100, high: 101, low: 99, close: 100, volume: 10 }],
  }, { evidence, evidenceIds: evidence.map(item => item.evidenceId), experiencePrompt });
  assert.equal(calls, 1);
});
