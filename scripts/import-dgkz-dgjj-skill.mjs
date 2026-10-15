import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { approvedKnowledgeForAnalysis, PRIORITY_SKILL_TAG } from "../server/rag.mjs";

// Only the explicitly reviewed baseline is replaced. Default is read-only.
const filename = "skills/dgkz-dgjj-entry-exit-analysis/SKILL.md";
const title = "AI 趋势交易：入场、持仓与离场（合并版）";
const content = (await readFile(new URL(`../${filename}`, import.meta.url), "utf8")).trim();
const baselinePath = process.env.AXIOM_MERGE_BASELINE;
const baseUrl = String(process.env.AXIOM_IMPORT_API_URL || "").replace(/\/$/, "");
if (!baselinePath || !baseUrl || !process.env.DESKTOP_USERNAME || !process.env.DESKTOP_PASSWORD) {
  throw new Error("MERGE_BASELINE_API_URL_AND_DESKTOP_CREDENTIALS_REQUIRED");
}
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
assert.ok(Array.isArray(baseline) && baseline.length === 12, "Expected the 12 reviewed records");
assert.equal(new Set(baseline.map(item => item.id)).size, 12);
assert.ok(baseline.every(item => item.owned === true && item.content && item.source));
const hash = value => createHash("sha256").update(value).digest("hex");
const same = (left, right) => left.owned === true && left.source === right.source
  && left.title === right.title && left.status === right.status && left.version === right.version
  && JSON.stringify(left.tags) === JSON.stringify(right.tags) && hash(left.content) === hash(right.content);

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
// Logout intentionally stops all user tasks; importing knowledge must not call it.
const before = (await request("/api/skills")).skills;
const baselineIds = new Set(baseline.map(item => item.id));
const candidates = before.filter(item => !baselineIds.has(item.id) && item.source === filename && item.title === title);
assert.ok(candidates.length <= 1, "MERGE_DUPLICATE_TARGET");
let skill = candidates[0];
if (skill) assert.ok(skill.owned === true && skill.content === content && skill.tags.includes(PRIORITY_SKILL_TAG), "MERGE_TARGET_CHANGED");
const remaining = baseline.filter(item => before.some(current => current.id === item.id));
if (!skill) assert.equal(remaining.length, baseline.length, "MERGE_BASELINE_RECORD_MISSING");
for (const previous of remaining) {
  assert.ok(same(before.find(item => item.id === previous.id), previous), `MERGE_BASELINE_CHANGED:${previous.id}`);
}
const preview = { apply: process.argv.includes("--apply"), previousCount: before.length, mergeCount: remaining.length, contentBytes: Buffer.byteLength(content), contentHash: hash(content) };
if (!preview.apply) {
  console.log(JSON.stringify(preview));
  process.exit(0);
}
const backupPath = resolve(dirname(baselinePath), `before-merge-${Date.now()}.json`);
await mkdir(dirname(backupPath), { recursive: true });
await writeFile(backupPath, JSON.stringify(before, null, 2), { mode: 0o600, flag: "wx" });
if (!skill) {
  ({ skill } = await request("/api/skills", "POST", {
    title, filename, kind: "expert", content,
    tags: [PRIORITY_SKILL_TAG, "趋势识别", "多空对称", "持仓离场", "MACD", "KDJ", "收益优先"],
  }));
}
if (skill.status !== "APPROVED") ({ skill } = await request(`/api/skills/${encodeURIComponent(skill.id)}/approve`, "POST", {}));
const ready = (await request("/api/skills")).skills;
const verified = ready.find(item => item.id === skill.id);
assert.ok(verified?.owned && verified.status === "APPROVED" && verified.content === content, "MERGE_TARGET_NOT_VERIFIED");
assert.equal(approvedKnowledgeForAnalysis([verified])[0].excerpt, content);
// Recheck after replacement approval, before deleting any old record.
for (const previous of remaining) assert.ok(same(ready.find(item => item.id === previous.id) || {}, previous), `MERGE_BASELINE_CHANGED:${previous.id}`);
for (const previous of remaining) {
  const current = (await request("/api/skills")).skills.find(item => item.id === previous.id);
  if (current) {
    assert.ok(same(current, previous), `MERGE_BASELINE_CHANGED:${previous.id}`);
    await request(`/api/skills/${encodeURIComponent(previous.id)}`, "DELETE");
  }
}
const after = (await request("/api/skills")).skills;
assert.ok(after.every(item => !baselineIds.has(item.id)), "MERGE_OLD_RECORDS_REMAIN");
assert.equal(after.find(item => item.id === skill.id)?.content, content);
for (const previous of before.filter(item => !baselineIds.has(item.id) && item.id !== skill.id)) {
  assert.deepEqual(after.find(item => item.id === previous.id), previous, "MERGE_UNRELATED_RECORD_CHANGED");
}
console.log(JSON.stringify({ ...preview, skillId: skill.id, status: "APPROVED", skillsAfter: after.length, backupPath }));
