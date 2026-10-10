import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createPersistence } from "../server/persistence.mjs";

function databaseMode(t, mode) {
  const previous = process.env.DB_MODE;
  process.env.DB_MODE = mode;
  t.after(() => { if (previous === undefined) delete process.env.DB_MODE; else process.env.DB_MODE = previous; });
}

test("configured quantity survives MySQL task save and hydration", async (t) => {
  databaseMode(t, "mysql");
  const mysql = createRequire(import.meta.url)("mysql2/promise");
  let stored;
  t.mock.method(mysql, "createPool", () => ({
    query: async (sql) => [sql === "SELECT * FROM tasks" && stored ? [stored] : []],
    execute: async (sql, values) => {
      if (/INSERT INTO tasks/.test(sql)) stored = { id: values[0], owner_user_id: values[1], name: values[2], status: values[3], mode: values[4], symbol: values[5], timeframe: values[6], target_json: values[7], risk_profile: values[8], stop_locked: values[9], runtime_json: values[10] };
      return [{}];
    },
    end: async () => {},
  }));
  const adapter = await createPersistence();
  try {
    await adapter.saveTask({ id: "quantity-task", ownerUserId: "owner", entryQuantity: 3, target: {}, mode: "LIVE", status: "READY" });
    assert.equal(JSON.parse(stored.runtime_json).entryQuantity, 3);
    assert.equal((await adapter.loadState()).tasks[0].entryQuantity, 3);
    await adapter.saveTask({ id: "default-task", target: {}, mode: "LIVE", status: "READY" });
    assert.equal((await adapter.loadState()).tasks[0].entryQuantity, 1);
  } finally { await adapter.close(); }
});

