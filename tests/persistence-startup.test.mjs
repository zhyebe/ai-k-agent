import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, before, mock } from "node:test";
import { createPersistence } from "../server/persistence.mjs";

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
