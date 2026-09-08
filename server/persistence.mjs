function json(value) {
  return JSON.stringify(value ?? {});
}

function parse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function createMemoryAdapter() {
  const adapter = {
    mode: "memory",
    available: true,
    detail: "演示仓储",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    async recordAudit() {},
    async saveTask() {},
    async saveSkill() {},
    async saveProvider() {},
    async saveConnector() {},
    async saveCredential() {},
    async saveOrder() {},
    async loadState() { return null; },
    async loadEvents() { return []; },
    async loadCredentials() { return []; },
    async close() {},
  };
  return adapter;
}

async function createMySqlAdapter() {
  const { createPool } = await import("mysql2/promise");
  const pool = createPool(process.env.MYSQL_URL || "mysql://root:password@127.0.0.1:3306/axiom_agent");
  await pool.query("SELECT 1");
  await pool.query("ALTER TABLE tasks ADD COLUMN runtime_json JSON NULL").catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS connectors (
    connector_id VARCHAR(96) PRIMARY KEY,
    type VARCHAR(16) NOT NULL,
    target_value VARCHAR(1024) NOT NULL,
    name VARCHAR(200) NOT NULL,
    adapter_id VARCHAR(128) NOT NULL,
    adapter_version VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    profile_json JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS credentials (
    credential_ref VARCHAR(96) PRIMARY KEY,
    username_ciphertext TEXT NOT NULL,
    password_ciphertext TEXT NOT NULL,
    target_json JSON NOT NULL,
    label VARCHAR(200) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  const adapter = {
    mode: "mysql",
    available: true,
    detail: "MySQL 已连接",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    async recordAudit(event) {
      await pool.execute(
        "INSERT INTO audit_logs (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json)",
        [event.id, event.type, json(event)],
      );
    },
    async saveTask(task) {
      const runtime = {
        workflow: task.workflow,
        rules: task.rules,
        decision: task.decision,
        metrics: task.metrics,
        nextTrigger: task.nextTrigger,
        heartbeatAt: task.heartbeatAt,
        leaseExpiresAt: task.leaseExpiresAt,
        connectorId: task.target?.connectorId || "",
        credentialRef: task.target?.credentialRef || "",
      };
      await pool.execute(
        `INSERT INTO tasks (id, name, status, mode, symbol, timeframe, target_json, risk_profile, stop_locked, runtime_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), mode=VALUES(mode), symbol=VALUES(symbol), timeframe=VALUES(timeframe), target_json=VALUES(target_json), risk_profile=VALUES(risk_profile), stop_locked=VALUES(stop_locked), runtime_json=VALUES(runtime_json), updated_at=NOW()`,
        [task.id, task.name, task.status, task.mode, task.symbol, task.timeframe, json(task.target), task.riskProfile, Boolean(task.stopLocked), json(runtime)],
      );
    },
    async saveSkill(skill) {
      await pool.execute(
        `INSERT INTO skills (id, title, kind, source, status, version, tags_json, content, chunk_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE title=VALUES(title), kind=VALUES(kind), source=VALUES(source), status=VALUES(status), version=VALUES(version), tags_json=VALUES(tags_json), content=VALUES(content), chunk_count=VALUES(chunk_count), updated_at=NOW()`,
        [skill.id, skill.title, skill.kind, skill.source, skill.status, skill.version, json(skill.tags), skill.content, skill.chunks || 0],
      );
    },
    async saveProvider(provider) {
      await pool.execute(
        `INSERT INTO providers (id, name, model, base_url, encrypted_key, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE name=VALUES(name), model=VALUES(model), base_url=VALUES(base_url), encrypted_key=VALUES(encrypted_key), status=VALUES(status), updated_at=NOW()`,
        [provider.id, provider.name, provider.model, provider.baseUrl, provider.encryptedKey || "", provider.status || "未验证"],
      );
    },
    async saveConnector(connector) {
      await pool.execute(
        `INSERT INTO connectors (connector_id, type, target_value, name, adapter_id, adapter_version, status, profile_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE type=VALUES(type), target_value=VALUES(target_value), name=VALUES(name), adapter_id=VALUES(adapter_id), adapter_version=VALUES(adapter_version), status=VALUES(status), profile_json=VALUES(profile_json), updated_at=NOW()`,
        [connector.connectorId, connector.type, connector.target, connector.name, connector.adapterId, connector.adapterVersion, connector.status, json(connector)],
      );
    },
    async saveCredential(record) {
      await pool.execute(
        `INSERT INTO credentials (credential_ref, username_ciphertext, password_ciphertext, target_json, label, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username_ciphertext=VALUES(username_ciphertext), password_ciphertext=VALUES(password_ciphertext), target_json=VALUES(target_json), label=VALUES(label), updated_at=NOW()`,
        [record.id, record.username, record.password, json(record.target), record.label || ""],
      );
    },
    async saveOrder(order) {
      await pool.execute(
        `INSERT INTO orders (id, idempotency_key, task_id, symbol, action, mode, status, order_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status=VALUES(status), order_json=VALUES(order_json)`,
        [order.id, order.idempotencyKey, order.taskId, order.symbol, order.action, order.mode, order.status, json(order)],
      );
    },
    async loadState() {
      const [taskRows] = await pool.query("SELECT * FROM tasks ORDER BY updated_at DESC");
      const [skillRows] = await pool.query("SELECT * FROM skills ORDER BY updated_at DESC");
      const [providerRows] = await pool.query("SELECT * FROM providers ORDER BY updated_at DESC");
      const [connectorRows] = await pool.query("SELECT * FROM connectors ORDER BY updated_at DESC");
      const [orderRows] = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200").catch(() => [[]]);
      const [eventRows] = await pool.query("SELECT payload_json FROM audit_logs ORDER BY created_at DESC LIMIT 80").catch(() => [[]]);
      return {
        tasks: taskRows.map((row) => {
          const target = parse(row.target_json, {});
          const runtime = parse(row.runtime_json, {});
          return {
            id: row.id,
            name: row.name,
            status: row.status,
            mode: row.mode,
            symbol: row.symbol,
            timeframe: row.timeframe,
            target,
            riskProfile: row.risk_profile,
            stopLocked: Boolean(row.stop_locked),
            workflow: runtime.workflow || [],
            rules: runtime.rules || [],
            decision: runtime.decision || { action: "HOLD", confidence: 0, targetPositionPct: 0, maxOrderValuePct: 0, reasonCodes: [], evidenceIds: [], invalidation: "", riskFlags: ["RESTORED_WITHOUT_RUNTIME"], createdAt: new Date().toISOString(), ttlSec: 300 },
            metrics: runtime.metrics || { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
            nextTrigger: runtime.nextTrigger || "等待触发",
            heartbeatAt: runtime.heartbeatAt,
            leaseExpiresAt: runtime.leaseExpiresAt,
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()),
          };
        }),
        skills: skillRows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, source: row.source, status: row.status, version: row.version, tags: parse(row.tags_json, []), chunks: row.chunk_count || 0, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()), summary: String(row.content || "").slice(0, 120), content: row.content })),
        providers: providerRows.map((row) => ({ id: row.id, name: row.name, model: row.model, baseUrl: row.base_url, encryptedKey: row.encrypted_key, keyPreview: "", status: row.status })),
        connectors: connectorRows.map((row) => parse(row.profile_json, { connectorId: row.connector_id, type: row.type, target: row.target_value, name: row.name, adapterId: row.adapter_id, adapterVersion: row.adapter_version, status: row.status })),
        orders: orderRows.map((row) => parse(row.order_json, { id: row.id, idempotencyKey: row.idempotency_key, taskId: row.task_id, symbol: row.symbol, action: row.action, mode: row.mode, status: row.status })),
        events: eventRows.map((row) => parse(row.payload_json, null)).filter(Boolean),
      };
    },
    async loadCredentials() {
      const [rows] = await pool.query("SELECT credential_ref, username_ciphertext, password_ciphertext, target_json, label, created_at, updated_at FROM credentials");
      return rows.map((row) => ({ id: row.credential_ref, username: row.username_ciphertext, password: row.password_ciphertext, target: parse(row.target_json, {}), label: row.label || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "") }));
    },
    close: () => pool.end(),
  };
  return adapter;
}

async function createMongoAdapter() {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.MONGO_URL || "mongodb://127.0.0.1:27017");
  await client.connect();
  const database = client.db(process.env.MONGO_DB || "axiom_agent");
  const collections = {
    audit: database.collection("audit_logs"),
    tasks: database.collection("tasks"),
    skills: database.collection("skills"),
    providers: database.collection("providers"),
    connectors: database.collection("connectors"),
    credentials: database.collection("credentials"),
    orders: database.collection("orders"),
  };
  const adapter = {
    mode: "mongo",
    available: true,
    detail: "MongoDB 已连接",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    recordAudit: (event) => collections.audit.replaceOne({ _id: event.id }, { ...event, _id: event.id }, { upsert: true }),
    saveTask: (task) => collections.tasks.replaceOne({ _id: task.id }, { ...task, _id: task.id }, { upsert: true }),
    saveSkill: (skill) => collections.skills.replaceOne({ _id: skill.id }, { ...skill, _id: skill.id }, { upsert: true }),
    saveProvider: (provider) => collections.providers.replaceOne({ _id: provider.id }, { ...provider, _id: provider.id }, { upsert: true }),
    saveConnector: (connector) => collections.connectors.replaceOne({ _id: connector.connectorId }, { ...connector, _id: connector.connectorId }, { upsert: true }),
    saveCredential: (record) => collections.credentials.replaceOne({ _id: record.id }, { ...record, _id: record.id }, { upsert: true }),
    saveOrder: (order) => collections.orders.replaceOne({ _id: order.id }, { ...order, _id: order.id }, { upsert: true }),
    async loadState() {
      const [tasks, skills, providers, connectors, orders, events] = await Promise.all([
        collections.tasks.find().sort({ updatedAt: -1 }).toArray(),
        collections.skills.find().sort({ updatedAt: -1 }).toArray(),
        collections.providers.find().sort({ updatedAt: -1 }).toArray(),
        collections.connectors.find().sort({ updatedAt: -1 }).toArray(),
        collections.orders.find().sort({ createdAt: -1 }).limit(200).toArray(),
        collections.audit.find().sort({ createdAt: -1 }).limit(80).toArray(),
      ]);
      return { tasks: tasks.map(({ _id, ...item }) => item), skills: skills.map(({ _id, ...item }) => item), providers: providers.map(({ _id, ...item }) => item), connectors: connectors.map(({ _id, ...item }) => item), orders: orders.map(({ _id, ...item }) => item), events: events.map(({ _id, ...item }) => item) };
    },
    async loadCredentials() {
      const rows = await collections.credentials.find().toArray();
      return rows.map(({ _id, ...item }) => item);
    },
    close: () => client.close(),
  };
  return adapter;
}

export async function createPersistence() {
  const mode = process.env.DB_MODE || "memory";
  if (mode === "mysql") {
    try { return await createMySqlAdapter(); } catch (error) {
      const adapter = createMemoryAdapter();
      adapter.mode = "mysql";
      adapter.available = false;
      adapter.detail = `MySQL 未连接：${error.message}`;
      return adapter;
    }
  }
  if (mode === "mongo") {
    try { return await createMongoAdapter(); } catch (error) {
      const adapter = createMemoryAdapter();
      adapter.mode = "mongo";
      adapter.available = false;
      adapter.detail = `MongoDB 未连接：${error.message}`;
      return adapter;
    }
  }
  return createMemoryAdapter();
}
