import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PRIORITY_SKILL_TAG } from "../server/rag.mjs";

const filename = "skills/dgkz-dgjj-entry-exit-analysis/SKILL.md";
const source = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
const title = "DGKZ / DGJJ 入场离场分析（优先参考）";
const integration = `# Agent 调用说明

本条为用户指定的优先参考 Skill。分析 DGKZ / DGJJ 时先核验下方技能的适用条件，再结合其他已审核经验与实时行情；其他品种不套用这两个品种的静态参数。优先追求有证据支持的最大预期净收益；只有盈利路径被证据否定、继续持仓预计扩大损失时，选择最小预期损失离场。不得承诺事前保证最高收益。

下方研究技能不新增或撤销交易授权。其“由用户执行”“不得自行下单”等表述表示 Skill 本身不执行交易；当前 Agent 的执行仍由现有 executionPolicy、自动/手动入场模式和用户授权决定。模型按系统要求返回完整交易 JSON，持仓退出、委托处理与收盘清仓沿用现有执行规则，不能因本文改成人工交接或停止自动离场。

2026-10-14 合约、费用、时段、样本和候选参数均为来源快照，必须用本轮数据与有效公告核验，不作为当前报价、已验证胜率或硬编码交易阈值。收盘截止与计划有效期以当前用户配置为准。以下保留来源 SKILL.md 全文。

---

`;
const content = `${integration}${source}`.trim();
const baseUrl = String(process.env.AXIOM_IMPORT_API_URL || "").replace(/\/$/, "");
if (!baseUrl || !process.env.DESKTOP_USERNAME || !process.env.DESKTOP_PASSWORD) {
  throw new Error("IMPORT_API_URL_AND_DESKTOP_CREDENTIALS_REQUIRED");
}

let token = "";
async function request(path, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { "x-user-token": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`IMPORT_HTTP_${response.status}:${result.error || "REQUEST_FAILED"}`);
  return result;
}

const login = await request("/api/user/login", "POST", { username: process.env.DESKTOP_USERNAME, password: process.env.DESKTOP_PASSWORD });
token = login.token;
assert.ok(token);
const before = (await request("/api/skills")).skills;
const existing = before.filter(skill => skill.source === filename);
if (existing.length > 1) throw new Error("IMPORT_DUPLICATE_SOURCE");
let skill = existing[0];
if (skill) {
  assert.ok(skill.content === content, "Existing source differs; review explicitly before replacing it");
  assert.ok(skill.tags.includes(PRIORITY_SKILL_TAG), "Existing skill lacks the priority tag");
} else {
  ({ skill } = await request("/api/skills", "POST", {
    title,
    filename,
    kind: "expert",
    tags: [PRIORITY_SKILL_TAG, "DGKZ", "DGJJ", "入场离场", "收益优先", "AI操盘核验"],
    content,
  }));
}
if (skill.status !== "APPROVED") ({ skill } = await request(`/api/skills/${encodeURIComponent(skill.id)}/approve`, "POST", {}));
const after = (await request("/api/skills")).skills;
assert.equal(after.filter(item => item.source === filename).length, 1);
assert.ok(after.find(item => item.id === skill.id)?.content === content, "Imported content differs");
assert.equal(after.find(item => item.id === skill.id)?.status, "APPROVED");
for (const previous of before.filter(item => item.id !== skill.id)) assert.deepEqual(after.find(item => item.id === previous.id), previous);
console.log(JSON.stringify({ imported: !existing.length, skillId: skill.id, status: skill.status, version: skill.version, priority: PRIORITY_SKILL_TAG, contentBytes: Buffer.byteLength(content), skillsBefore: before.length, skillsAfter: after.length }));
