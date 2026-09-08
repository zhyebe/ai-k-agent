// Run with mongosh after selecting the axiom_agent database.
db.skills.createIndex({ status: 1, tags: 1 });
db.skill_chunks.createIndex({ skillId: 1, version: 1 });
db.skill_chunks.createIndex({ content: "text", title: "text" });
db.agent_decisions.createIndex({ taskId: 1, createdAt: -1 });
db.audit_logs.createIndex({ createdAt: -1 });
db.market_candles.createIndex({ symbol: 1, timeframe: 1, candleTime: -1 });
db.connectors.createIndex({ adapterId: 1, status: 1 });
db.credentials.createIndex({ "target.adapterId": 1, updatedAt: -1 });
db.orders.createIndex({ taskId: 1, createdAt: -1 });
db.orders.createIndex({ idempotencyKey: 1 }, { unique: true });
