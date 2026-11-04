import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalPersistence } from "../server/local-persistence.mjs";
import { compactTaskRuntime } from "../server/persistence.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-local-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const open = () => createLocalPersistence({ directory, compactTaskRuntime });
  return { directory, file: path.join(directory, "workspace.json"), open, adapter: await open() };
}

test("local writes retain independent records and capture inputs before queuing; close flushes", async t => {
  const { open, adapter, file } = await fixture(t);
  assert.equal(await adapter.loadState(), null);
  const task = { id: "t", ownerUserId: "local-user", entryQuantity: 3, target: { credentialRef: "cred" }, market: { history: Array(500).fill({ price: 1 }) } };
  const saves = [adapter.saveTask(task), adapter.saveProvider({ id: "p", encryptedKey: "encrypted" }), adapter.saveSkill({ id: "s", content: "经验" }), adapter.saveCredential({ id: "cred", password: "encrypted" })];
  task.entryQuantity = 999;
  await adapter.close();
  await Promise.all(saves);
  const restored = await open();
  const state = await restored.loadState();
  assert.equal(state.tasks[0].entryQuantity, 3);
  assert.equal(state.tasks[0].target.credentialRef, "cred");
  assert.equal(state.tasks[0].market, null);
  assert.equal(state.providers[0].id, "p");
  assert.equal(state.skills[0].content, "经验");
  assert.equal((await restored.loadCredentials())[0].id, "cred");
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await restored.deleteSkill("s");
  await restored.deleteTaskData({ taskId: "t", ownerUserId: "local-user" });
  await restored.deleteProvider("p");
  await restored.close();
  assert.deepEqual((await (await open()).loadState()).tasks, []);
  assert.deepEqual((await (await open()).loadState()).skills, []);
});

test("corrupt or unsupported local state fails without overwriting files", async t => {
  const { file, open } = await fixture(t);
  for (const text of ["{broken", '{"schemaVersion":999}', '{"schemaVersion":1,"tasks":null}']) {
    await fs.writeFile(file, text);
    await assert.rejects(open(), /LOCAL_DATA_READ_FAILED/);
    assert.equal(await fs.readFile(file, "utf8"), text);
  }
});

test("local reviewed built-in strategy upgrades once and never restores a deleted skill", async t => {
  const { adapter, file, open } = await fixture(t);
  const previous = (await fs.readFile(new URL("./fixtures/trading-skill-v0.3.133.md", import.meta.url), "utf8")).trim();
  const bundled = (await fs.readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8")).trim();
  await adapter.saveSkill({ id: "skill_local_trading", status: "APPROVED", version: "v1.0.0", content: previous, ownerUserId: "local-user" });
  await adapter.saveProvider({ id: "keep-provider", encryptedKey: "encrypted" });
  const restored = await open();
  const first = await restored.loadState();
  assert.equal(first.skills[0].version, "v1.0.2");
  assert.equal(first.skills[0].content, bundled);
  assert.equal(first.skills[0].ownerUserId, "local-user");
  assert.equal(first.providers[0].id, "keep-provider");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).skills[0].version, "v1.0.2");
  assert.equal((await restored.loadState()).skills[0].updatedAt, first.skills[0].updatedAt);
  await restored.deleteSkill("skill_local_trading");
  await restored.close();
  assert.deepEqual((await (await open()).loadState()).skills, []);
});

test("local strategy migration preserves edits, review status and unrelated records", async t => {
  const content = (await fs.readFile(new URL("./fixtures/trading-skill-v0.3.133.md", import.meta.url), "utf8")).trim();
  for (const change of [{ content: `${content}\n用户规则` }, { status: "REVIEW" }, { version: "user-version" }, { id: "user-skill" }]) {
    const { adapter, open } = await fixture(t);
    const skill = { id: "skill_local_trading", status: "APPROVED", version: "v1.0.0", content, ...change };
    await adapter.saveSkill(skill);
    await adapter.close();
    assert.deepEqual((await (await open()).loadState()).skills, [skill]);
  }
});

test("local strategy migration accepts Windows line endings while preserving edited content", async t => {
  const previous = (await fs.readFile(new URL("./fixtures/trading-skill-v0.3.133.md", import.meta.url), "utf8")).trim().replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const bundled = (await fs.readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8")).trim();
  for (const content of [previous, `${previous}\r\n用户规则`]) {
    const { adapter, open } = await fixture(t);
    const skill = { id: "skill_local_trading", status: "APPROVED", version: "v1.0.0", content };
    await adapter.saveSkill(skill);
    await adapter.close();
    const restored = (await (await open()).loadState()).skills[0];
    if (content === previous) {
      assert.equal(restored.version, "v1.0.2");
      assert.equal(restored.content, bundled);
    } else {
      assert.deepEqual(restored, skill);
    }
  }
});

test("failed local write is surfaced, preserves the committed snapshot, and does not poison later writes", async t => {
  const { file, adapter, open } = await fixture(t);
  await adapter.saveProvider({ id: "p", model: "saved" });
  await fs.rename(file, `${file}.saved`);
  await fs.mkdir(file);
  await assert.rejects(adapter.saveProvider({ id: "p", model: "lost" }), /LOCAL_DATA_WRITE_FAILED/);
  assert.equal((await adapter.health()).available, false);
  assert.equal(adapter.available, false);
  assert.equal((await adapter.loadState()).providers[0].model, "saved");
  await assert.rejects(adapter.close(), /LOCAL_DATA_WRITE_FAILED/);
  await fs.rmdir(file);
  await fs.rename(`${file}.saved`, file);
  await adapter.saveSkill({ id: "s", content: "after recovery" });
  await adapter.close();
  assert.equal((await (await open()).loadState()).providers[0].model, "saved");
  assert.equal((await adapter.health()).available, true);
});
