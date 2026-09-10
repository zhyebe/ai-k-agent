// Run with mongosh after selecting the axiom_agent database.
db.skills.createIndex({ status: 1, tags: 1 });
db.skills.createIndex({ ownerUserId: 1, status: 1 });
db.providers.createIndex({ ownerUserId: 1, providerKey: 1 });
db.skill_chunks.createIndex({ skillId: 1, version: 1 });
db.skill_chunks.createIndex({ content: "text", title: "text" });
db.agent_decisions.createIndex({ taskId: 1, createdAt: -1 });
db.audit_logs.createIndex({ createdAt: -1 });
db.market_candles.createIndex({ symbol: 1, timeframe: 1, candleTime: -1 });
db.connectors.createIndex({ adapterId: 1, status: 1 });
db.credentials.createIndex({ ownerUserId: 1, "target.adapterId": 1, updatedAt: -1 });
db.orders.createIndex({ taskId: 1, createdAt: -1 });
db.agent_runs.createIndex({ taskId: 1, startedAt: -1 });
db.agent_output.createIndex({ runId: 1, sequence: 1 });
db.users.createIndex({ username: 1 }, { unique: true });
db.task_assignments.createIndex({ userId: 1, taskId: 1 }, { unique: true });
