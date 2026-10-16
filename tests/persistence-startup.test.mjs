import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test, { after, before, mock } from "node:test";
import { createPersistence } from "../server/persistence.mjs";
import { tradingSkillUpgrade } from "../server/trading-skill-upgrade.mjs";
import { approvedKnowledgeForAnalysis, buildApprovedExperiencePrompt } from "../server/rag.mjs";
import { hydrateState, state } from "../server/store.mjs";

let mysqlPool;
before(() => {
  const mysql = createRequire(import.meta.url)("mysql2/promise");
  // The ESM import caches createPool, so keep one mock and change its pool.
  mock.method(mysql, "createPool", () => mysqlPool);
});
after(() => mock.restoreAll());

function databaseMode(t, mode) {
  const previous = process.env.DB_MODE;
  process.env.DB_MODE = mode;
  t.after(() => { if (previous === undefined) delete process.env.DB_MODE; else process.env.DB_MODE = previous; });
}

async function oldTradingSkill() {
  return {
    id: "skill_04ef36d5-3002-40fd-b51f-3914867e29f1", status: "APPROVED", version: "v0.3.76",
    owner_user_id: "author", title: "AI 趋势交易：入场、持仓与离场（合并版）", tags_json: '["优先参考"]',
    content: (await readFile(new URL("./fixtures/trading-skill-v0.3.76.md", import.meta.url), "utf8")).trim(),
  };
}

test("only the exact reviewed legacy Skill is eligible for the short-term correction", async () => {
  const previous = await oldTradingSkill();
  const revision = await tradingSkillUpgrade(previous);
  assert.equal(revision.version, "v0.3.84");
  assert.match(revision.content, /盈利吃到 2–5 根 K 就及时离场/);
  assert.match(revision.content, /持仓超过约 5 根 K 仍亏损/);
  assert.equal(await tradingSkillUpgrade({ ...previous, ...revision }), null);
  for (const change of [{ id: "unrelated" }, { status: "REVIEW" }, { version: "newer" }, { content: `${previous.content}\n用户新增内容` }]) {
    assert.equal(await tradingSkillUpgrade({ ...previous, ...change }), null);
  }
});

test("MySQL upgrades the reviewed Skill once and loads the persisted revision into AI context", async t => {
  databaseMode(t, "mysql");
  const old = await oldTradingSkill();
  let row = { ...old };
  let writes = 0;
  mysqlPool = {
    query: async sql => [/^SELECT \* FROM skills$/.test(sql) ? [{ ...row }] : []],
    execute: async (sql, values) => {
      assert.match(sql, /WHERE id = \? AND status = \? AND version = \? AND BINARY content = BINARY \?/);
      assert.deepEqual(values.slice(3), [old.id, old.status, old.version, old.content]);
      row = { ...row, content: values[0], version: values[1], chunk_count: values[2], updated_at: new Date() };
      writes++;
      return [{ affectedRows: 1 }];
    },
    end: async () => {},
  };
  const previousSkills = state.skills;
  t.after(() => hydrateState({ skills: previousSkills }));
  const adapter = await createPersistence();
  t.after(() => adapter.close());
  for (let restart = 0; restart < 2; restart++) {
    const snapshot = await adapter.loadState();
    hydrateState({ skills: snapshot.skills });
    assert.equal(state.skills[0].version, "v0.3.84");
    assert.equal(state.skills[0].ownerUserId, old.owner_user_id);
    assert.deepEqual(state.skills[0].tags, ["优先参考"]);
    const prompt = buildApprovedExperiencePrompt(approvedKnowledgeForAnalysis(state.skills));
    assert.ok(prompt.includes(row.content));
    assert.match(prompt, /没有具体、近期、可核实的恢复证据/);
    assert.doesNotMatch(prompt, /5 根只是示例，不是盈利目标或持仓上限/);
  }
  assert.equal(writes, 1);
});

test("MySQL does not replace concurrent edits and reloads the current database Skill", async t => {
  databaseMode(t, "mysql");
  const old = await oldTradingSkill();
  let row = { ...old };
  mysqlPool = {
    query: async sql => [/^SELECT \* FROM skills$/.test(sql) ? [{ ...row }] : []],
    execute: async sql => {
      assert.match(sql, /BINARY content = BINARY \?/);
      row = { ...row, version: "user-update", content: "用户并发更新的经验" };
      return [{ affectedRows: 0 }];
    },
    end: async () => {},
  };
  const adapter = await createPersistence();
  t.after(() => adapter.close());
  const snapshot = await adapter.loadState();
  assert.equal(snapshot.skills[0].content, row.content);
  assert.equal(snapshot.skills[0].version, "user-update");
});

test("failed MySQL knowledge upgrade is reported without losing persisted skills, tasks or providers", async t => {
  databaseMode(t, "mysql");
  const row = await oldTradingSkill();
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  mysqlPool = {
    query: async sql => [/^SELECT \* FROM skills$/.test(sql) ? [{ ...row }]
      : /^SELECT \* FROM tasks$/.test(sql) ? [{ id: "existing-task", runtime_json: "{}", target_json: "{}" }]
        : /^SELECT \* FROM providers$/.test(sql) ? [{ id: "existing-model", name: "模型", model: "deepseek-chat" }] : []],
    execute: async () => { throw new Error("database write failed"); },
    end: async () => {},
  };
  const adapter = await createPersistence();
  t.after(() => adapter.close());
  const snapshot = await adapter.loadState();
  assert.deepEqual(errors, [["TRADING_SKILL_UPGRADE_FAILED", { skillId: row.id, code: "UPGRADE_FAILED" }]]);
  assert.equal(snapshot.skills[0].version, "v0.3.76");
  assert.equal(snapshot.skills[0].content, row.content);
  assert.equal(snapshot.tasks[0].id, "existing-task");
  assert.equal(snapshot.providers[0].id, "existing-model");
});

test("MongoDB upgrades the same reviewed Skill and reloads persisted content", async t => {
  databaseMode(t, "mongo");
  const old = await oldTradingSkill();
  let row = { ...old, _id: old.id, ownerUserId: "author", tags: ["优先参考"] };
  let writes = 0;
  const { MongoClient } = await import("mongodb");
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: name => ({
    find: () => {
      const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => name === "skills" ? [{ ...row }] : [] };
      return cursor;
    },
    updateOne: async (filter, update) => {
      assert.equal(name, "skills");
      assert.deepEqual(filter, { _id: old.id, id: old.id, status: old.status, version: old.version, content: old.content });
      row = { ...row, ...update.$set };
      writes++;
      return { modifiedCount: 1 };
    },
  }) }));
  const adapter = await createPersistence();
  t.after(() => adapter.close());
  for (let restart = 0; restart < 2; restart++) {
    const snapshot = await adapter.loadState();
    assert.equal(snapshot.skills[0].version, "v0.3.84");
    assert.match(snapshot.skills[0].content, /持仓超过约 5 根 K 仍亏损/);
    assert.equal(snapshot.skills[0].ownerUserId, "author");
  }
  assert.equal(writes, 1);
});

test("MySQL startup keeps account and task rows and only truncates AI dumps", async (t) => {
  databaseMode(t, "mysql");
  const statements = [];
  mysqlPool = {
    query: async (sql) => { statements.push(sql); return [[]]; },
    end: async () => {},
  };
  for (let restart = 0; restart < 2; restart++) {
    const adapter = await createPersistence();
    assert.equal(adapter.available, true);
    await adapter.close();
  }
  assert.ok(statements.some((sql) => /CREATE TABLE/i.test(sql)));
  const cleanup = statements.filter((sql) => /^\s*(DELETE|TRUNCATE|DROP)\b/i.test(sql));
  assert.ok(cleanup.every((sql) => /TRUNCATE TABLE (risk_checks|agent_decisions|agent_output|agent_runs|analysis_runs|market_candles)/i.test(sql) || /DELETE FROM audit_logs WHERE event_type NOT IN/i.test(sql)));
  assert.equal(cleanup.some((sql) => /FROM (users|tasks|providers|connectors|credentials|task_assignments)\b/i.test(sql)), false);
});

test("MongoDB startup keeps stored experience including legacy identifiers", async (t) => {
  databaseMode(t, "mongo");
  const { MongoClient } = await import("mongodb");
  const deletions = [];
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: (name) => ({ deleteMany: async (filter) => { deletions.push({ name, filter }); } }) }));
  const adapter = await createPersistence();
  assert.equal(adapter.available, true);
  assert.deepEqual(deletions, []);
  await adapter.close();
});

test("MySQL loads the last model failure independently of a later successful decision", async (t) => {
  databaseMode(t, "mysql");
  const lastModelFailure = { runId: "failed-run", code: "INVALID_MODEL_JSON", recovered: false, modelDiagnostics: { jsonStatus: "INVALID_JSON", jsonError: "TRUNCATED_JSON" } };
  const runtime = { decision: { action: "BUY" }, lastModelFailure };
  mysqlPool = {
    query: async sql => [/^SELECT \* FROM tasks$/.test(sql) ? [{ id: "task", runtime_json: JSON.stringify(runtime), target_json: "{}" }] : []],
    execute: async () => [[]],
    end: async () => {},
  };
  const adapter = await createPersistence();
  const snapshot = await adapter.loadState();
  assert.equal(snapshot.tasks[0].decision.action, "BUY");
  assert.deepEqual(snapshot.tasks[0].lastModelFailure, lastModelFailure);
  await adapter.close();
});

test("MySQL removes the legacy skill-owner cascade and keeps knowledge when deleting an account", async (t) => {
  databaseMode(t, "mysql");
  const statements = [];
  let skillOwnerConstraint = true;
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql) => { statements.push(sql); return [[]]; },
  };
  mysqlPool = {
    query: async (sql) => {
      statements.push(sql);
      if (/information_schema.KEY_COLUMN_USAGE/.test(sql)) return [skillOwnerConstraint ? [{ CONSTRAINT_NAME: "fk_skills_owner" }] : []];
      if (/ALTER TABLE skills DROP FOREIGN KEY/.test(sql)) skillOwnerConstraint = false;
      return [[]];
    },
    getConnection: async () => connection,
    end: async () => {},
  };
  for (let restart = 0; restart < 2; restart++) {
    const adapter = await createPersistence();
    assert.equal(adapter.available, true);
    await adapter.deleteUserData({ userId: "author", taskIds: [] });
    await adapter.close();
  }
  assert.equal(statements.filter((sql) => /ALTER TABLE skills DROP FOREIGN KEY/.test(sql)).length, 1);
  assert.equal(statements.some((sql) => /ALTER TABLE skills ADD CONSTRAINT .*owner/i.test(sql)), false);
  assert.equal(statements.some((sql) => /^\s*DELETE.*\bskills\b/i.test(sql)), false);
  assert.equal(statements.some((sql) => /^\s*DELETE.*\bskill_chunks\b/i.test(sql)), false);
  assert.ok(statements.some((sql) => /DELETE FROM users/.test(sql)));
  assert.ok(statements.some((sql) => /DELETE FROM providers/.test(sql)));
});

test("MongoDB account deletion retains the shared knowledge collection", async (t) => {
  databaseMode(t, "mongo");
  const { MongoClient } = await import("mongodb");
  const deletions = [];
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: (name) => ({
    deleteMany: async (filter) => { deletions.push({ name, filter }); },
    deleteOne: async (filter) => { deletions.push({ name, filter }); },
  }) }));
  const adapter = await createPersistence();
  assert.equal(adapter.available, true);
  await adapter.deleteUserData({ userId: "author", taskIds: ["task"] });
  assert.equal(deletions.some((item) => item.name === "skills"), false);
  assert.ok(deletions.some((item) => item.name === "providers"));
  assert.ok(deletions.some((item) => item.name === "users"));
  await adapter.close();
});
