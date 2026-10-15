import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("reviewed knowledge merge verifies replacement, preserves unrelated records and resumes partial deletion", async t => {
  const dir = await mkdtemp(join(tmpdir(), "axiom-merge-"));
  const baseline = Array.from({ length: 12 }, (_, i) => ({ id: `old-${i}`, source: `source-${i}`, title: `old ${i}`, content: `reviewed ${i}`, owned: true, status: "APPROVED", version: "v1", tags: [] }));
  const unrelated = { id: "someone-else", source: "shared", title: "other", content: "untouched", owned: false, status: "APPROVED", tags: [] };
  let skills = structuredClone([...baseline, unrelated]);
  let created = 0, deleted = 0, failDelete = true;
  const source = (await readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8")).trim();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/api/user/login") return send(200, { token: "test-token" });
    assert.equal(req.headers["x-user-token"], "test-token");
    if (req.url === "/api/skills" && req.method === "GET") return send(200, { skills });
    if (req.url === "/api/skills" && req.method === "POST") {
      const body = JSON.parse(raw);
      const skill = { ...body, source: body.filename, id: "replacement", status: "REVIEW", version: "draft", owned: true };
      skills.push(skill); created++;
      return send(201, { skill });
    }
    if (req.url === "/api/skills/replacement/approve") {
      const skill = skills.find(s => s.id === "replacement");
      skill.status = "APPROVED";
      return send(200, { skill });
    }
    if (req.method === "DELETE") {
      const replacement = skills.find(s => s.id === "replacement");
      assert.equal(replacement.status, "APPROVED");
      assert.equal(replacement.content, source);
      if (deleted === 3 && failDelete) { failDelete = false; return send(503, { error: "TEST_WRITE_FAILURE" }); }
      const id = req.url.split("/").at(-1);
      assert.ok(baseline.some(s => s.id === id));
      skills = skills.filter(s => s.id !== id); deleted++;
      return send(200, { ok: true });
    }
    send(404, { error: "UNEXPECTED_ROUTE" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const baselinePath = join(dir, "baseline.json");
  await writeFile(baselinePath, JSON.stringify(baseline));
  const run = (apply = true) => new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/import-dgkz-dgjj-skill.mjs", ...(apply ? ["--apply"] : [])], {
      env: { ...process.env, AXIOM_IMPORT_API_URL: `http://127.0.0.1:${server.address().port}`, AXIOM_MERGE_BASELINE: baselinePath, DESKTOP_USERNAME: "test", DESKTOP_PASSWORD: "test" },
    });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("close", code => resolve({ code, output }));
  });
  assert.equal((await run(false)).code, 0);
  assert.equal(created, 0);
  skills[0].content = "concurrent change";
  const changed = await run();
  assert.equal(changed.code, 1); assert.match(changed.output, /MERGE_BASELINE_CHANGED/);
  assert.equal(created, 0); assert.equal(deleted, 0);
  skills[0].content = baseline[0].content;
  const failed = await run();
  assert.equal(failed.code, 1); assert.match(failed.output, /TEST_WRITE_FAILURE/);
  assert.equal(created, 1); assert.equal(deleted, 3);
  assert.equal((await run()).code, 0);
  assert.equal((await run()).code, 0);
  assert.equal(created, 1); assert.equal(deleted, 12);
  assert.equal(skills.length, 2);
  assert.deepEqual(skills.find(s => s.id === unrelated.id), unrelated);
});
