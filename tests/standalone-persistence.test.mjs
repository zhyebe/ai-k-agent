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
