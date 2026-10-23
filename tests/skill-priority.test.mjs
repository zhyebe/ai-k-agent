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
  assert.match(content, /预测当前周期下一根及随后1～3根K/);
  assert.match(content, /普通入场必须由AI明确BUY买多或SELL买空，选定方向盈利概率>=40%才允许/);
  assert.match(content, /多单点差=当前bid-均价；空单点差=均价-当前ask/);
  assert.match(content, /点差不乘数量，不是盈亏金额/);
  assert.match(content, /盈利点差>=1时，程序立即整行离场，不等待AI，超过1点也立即执行/);
  assert.match(content, /亏损点差<=-2时，交给独立AI请求判断EXIT离场还是HOLD继续持仓/);
  assert.match(content, /持仓汇总对应商品方向整行“转让”，一次提交整行数量/);
  assert.match(content, /持仓及当前委托全部核实清零才结束本轮/);
  assert.match(content, /未定 K 和闪 K 的瞬时 OHLC 以未确认盘中证据交给 AI/);
  assert.match(content, /不能一律判假、删除或忽略/);
  assert.match(content, /多周期结构/);
  assert.doesNotMatch(content, /realtimeValueChange >= 2/);
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
    assert.match(payload.messages[0].content, /盈利点差>=1时程序立即整行离场，不等待AI/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "HOLD", bullish_profit_probability: 0.3, bearish_profit_probability: 0.3, profit_probability: 0.3, confidence: 0.4, analysis_summary: "测试行情，无可执行入场计划" }) } }] }), { headers: { "content-type": "application/json" } });
  });
  const now = Date.now();
  await analyzeCollectedMarket({ apiKey: "test", apiFormat: "chat", baseUrl: "https://provider.example.test", model: "model" }, {
    symbol: "DGKZ", timeframe: "1m", dataAt: new Date(now).toISOString(),
    history: [{ timestamp: now - 60000, open: 100, high: 101, low: 99, close: 100, volume: 10 }],
  }, { evidence, evidenceIds: evidence.map(item => item.evidenceId), experiencePrompt });
  assert.equal(calls, 1);
});
