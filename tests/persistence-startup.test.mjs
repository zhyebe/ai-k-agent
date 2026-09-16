import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPersistence } from "../server/persistence.mjs";

function databaseMode(t, mode) {
  const previous = process.env.DB_MODE;
  process.env.DB_MODE = mode;
  t.after(() => { if (previous === undefined) delete process.env.DB_MODE; else process.env.DB_MODE = previous; });
}

test("MySQL startup keeps account and task rows and only truncates AI dumps", async (t) => {
  databaseMode(t, "mysql");
  const statements = [];
  const mysql = createRequire(import.meta.url)("mysql2/promise");
  t.mock.method(mysql, "createPool", () => ({
    query: async (sql) => { statements.push(sql); return [[]]; },
    end: async () => {},
  }));
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
