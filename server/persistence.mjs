function json(value) {
  return JSON.stringify(value ?? {});
}

function parse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// 大 JSON 行（完整 K 线、审计快照）不能直接在 MySQL 里 ORDER BY，会撑爆 sort buffer。
// 先用窄子查询取最近 id，再回表取整行，展示顺序在 JS 里排。
function recentRowsSql(table, idColumn, orderColumn, limit, columns = "t.*") {
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1));
  return `SELECT ${columns} FROM ${table} t JOIN (SELECT ${idColumn} FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ${safeLimit}) recent ON recent.${idColumn} = t.${idColumn}`;
}

function byDesc(column) {
  return (a, b) => new Date(b?.[column] || 0).getTime() - new Date(a?.[column] || 0).getTime();
}

const PERSISTED_AUDIT_TYPES = new Set([
  "admin_login",
  "user_login",
  "user_created",
  "user_updated",
  "user_deleted",
  "user_bootstrapped",
]);

function compactBookSummary(book) {
  if (!book || typeof book !== "object") return null;
  return {
    symbol: book.symbol || "",
    symbolName: book.symbolName || "",
    instrumentId: book.instrumentId || "",
    latest: book.latest || book.quote || null,
    changePct: book.changePct ?? null,
    timeframe: book.timeframe || "",
    source: book.source || "",
    historyCount: Number(book.historyCount || book.history?.length || 0),
    dataQuality: book.dataQuality || "",
  };
}

function compactPersistedMarket(market) {
  if (!market || typeof market !== "object") return null;
  const books = Array.isArray(market.books) ? market.books.map(compactBookSummary).filter(Boolean) : [];
  return {
    ...compactBookSummary(market),
    observedAt: market.observedAt || null,
    expectedBookCount: Number(market.expectedBookCount || books.length || 0),
    boardCoverage: market.boardCoverage || null,
    books,
    account: market.account || null,
  };
}

function compactPersistedDecision(decision) {
  if (!decision || typeof decision !== "object") return decision;
  return {
    action: decision.action || "HOLD",
    confidence: Number(decision.confidence || 0),
    profitProbability: Number(decision.profitProbability || 0),
    bullishProfitProbability: Number(decision.bullishProfitProbability || 0),
    bearishProfitProbability: Number(decision.bearishProfitProbability || 0),
    signalTier: decision.signalTier || null,
    exitType: decision.exitType || null,
    targetSymbol: decision.targetSymbol || "",
    targetSymbolName: decision.targetSymbolName || "",
    targetInstrumentId: decision.targetInstrumentId || "",
    targetPositionPct: Number(decision.targetPositionPct || 0),
    maxOrderValuePct: Number(decision.maxOrderValuePct || 0),
    reasonCodes: Array.isArray(decision.reasonCodes) ? decision.reasonCodes.slice(0, 8) : [],
    evidenceIds: [],
    invalidation: String(decision.invalidation || "").slice(0, 240),
    riskFlags: Array.isArray(decision.riskFlags) ? decision.riskFlags.slice(0, 12) : [],
    createdAt: decision.createdAt || null,
    ttlSec: Number(decision.ttlSec || decision.decisionTtlSec || 300),
    analysisSummary: String(decision.analysisSummary || "").slice(0, 400),
    boardAssessments: Array.isArray(decision.boardAssessments)
      ? decision.boardAssessments.slice(0, 8).map((item) => ({
        symbol: item.symbol || "",
        symbolName: item.symbolName || "",
        instrumentId: item.instrumentId || "",
        action: item.action || "HOLD",
        confidence: Number(item.confidence || 0),
        profitProbability: Number(item.profitProbability || 0),
        bullishProfitProbability: Number(item.bullishProfitProbability || 0),
        bearishProfitProbability: Number(item.bearishProfitProbability || 0),
        summary: String(item.summary || "").slice(0, 160),
      }))
      : [],
  };
}

export function compactTaskRuntime(task = {}) {
  return {
    workflow: task.workflow || [],
    rules: task.rules || [],
    decision: compactPersistedDecision(task.decision),
    metrics: task.metrics || null,
    nextTrigger: task.nextTrigger || "",
    lastAnalysisAt: task.lastAnalysisAt || null,
    heartbeatAt: task.heartbeatAt || null,
    leaseExpiresAt: task.leaseExpiresAt || null,
    monitoringEnabled: task.monitoringEnabled === undefined ? task.status === "MONITORING" : task.monitoringEnabled === true,
    monitorAllBoards: task.monitorAllBoards === true,
    monitorGeneration: Number(task.monitorGeneration || 0),
    monitoringRound: Number(task.monitoringRound || 0),
    monitorFailureCount: Number(task.monitorFailureCount || 0),
    lastObservedFingerprint: task.lastObservedFingerprint || "",
    lastAnalyzedFingerprint: task.lastAnalyzedFingerprint || "",
    lastAnalysisSucceeded: task.lastAnalysisSucceeded === true,
    lastPolledAt: task.lastPolledAt || null,
    lastCycleAt: task.lastCycleAt || null,
    nextPollAt: task.nextPollAt || null,
    autoDecisionEnabled: task.autoDecisionEnabled === true,
    autoDecisionCountdownSec: Number(task.autoDecisionCountdownSec || 30),
    automationTestMode: task.automationTestMode !== false,
    providerId: String(task.providerId || ""),
    pendingAction: task.pendingAction || null,
    market: null,
    connectorId: task.target?.connectorId || "",
    credentialRef: task.target?.credentialRef || "",
  };
}

export function shouldPersistAuditEvent(type) {
  return PERSISTED_AUDIT_TYPES.has(String(type || ""));
}

const EPHEMERAL_MYSQL_TABLES = [
  "risk_checks",
  "agent_decisions",
  "agent_output",
  "agent_runs",
  "analysis_runs",
  "market_candles",
];

async function purgeEphemeralMysql(pool) {
  await pool.query("SET FOREIGN_KEY_CHECKS = 0").catch(() => {});
  for (const table of EPHEMERAL_MYSQL_TABLES) {
    await pool.query(`TRUNCATE TABLE ${table}`).catch(() => {});
  }
  await pool.query(
    "DELETE FROM audit_logs WHERE event_type NOT IN ('admin_login','user_login','user_created','user_updated','user_deleted','user_bootstrapped')",
  ).catch(() => {});
  await pool.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
}

async function compactStoredTaskRuntimes(pool) {
  const [rows] = await pool.query("SELECT id, runtime_json FROM tasks").catch(() => [[]]);
  for (const row of rows) {
    const compact = compactTaskRuntime(parse(row.runtime_json, {}));
    await pool.execute("UPDATE tasks SET runtime_json = ? WHERE id = ?", [json(compact), row.id]).catch(() => {});
  }
}

function serializeWrites(adapter, methodNames) {
  let queue = Promise.resolve();
  for (const methodName of methodNames) {
    const original = adapter[methodName];
    if (typeof original !== "function") continue;
    adapter[methodName] = (...args) => {
      const operation = queue.then(() => original(...args));
      queue = operation.catch(() => {});
      return operation;
    };
  }
  return adapter;
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
    async deleteTaskData() {},
    async saveSkill() {},
    async deleteSkill() {},
    async saveProvider() {},
    async saveConnector() {},
    async deleteConnector() {},
    async saveCredential() {},
    async saveOrder() {},
    async saveAnalysis() {},
    async saveAgentRun() {},
    async saveAgentOutput() {},
    async saveUser() {},
    async deleteUserData() {},
    async saveUserSession() {},
    async deleteUserSession() {},
    async clearTaskAssignments() {},
    async saveAssignment() {},
    async deleteAssignment() {},
    async deleteProvider() {},
    async loadState() { return null; },
    async loadEvents() { return []; },
    async loadCredentials() { return []; },
    async loadUsers() { return []; },
    async loadUserSessions() { return []; },
    async loadAssignments() { return []; },
    async close() {},
  };
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "clearTaskAssignments", "saveAssignment", "deleteAssignment"]);
}

async function createMySqlAdapter() {
  const { createPool } = await import("mysql2/promise");
  const pool = createPool(process.env.MYSQL_URL || "mysql://root:password@127.0.0.1:3306/axiom_agent");
  await pool.query("SELECT 1");
  await pool.query("ALTER TABLE tasks ADD COLUMN runtime_json JSON NULL").catch(() => {});
  await pool.query("ALTER TABLE tasks ADD COLUMN owner_user_id VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("CREATE INDEX idx_tasks_owner ON tasks (owner_user_id, updated_at)").catch(() => {});
  await pool.query("ALTER TABLE skills ADD COLUMN owner_user_id VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN owner_user_id VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN provider_key VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN api_format VARCHAR(32) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN models_json JSON NULL").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN models_url VARCHAR(1024) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE providers ADD COLUMN full_url_mode TINYINT(1) NOT NULL DEFAULT 0").catch(() => {});
  await pool.query("ALTER TABLE providers MODIFY COLUMN base_url VARCHAR(1024) NOT NULL").catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS connectors (
    connector_id VARCHAR(96) PRIMARY KEY,
    owner_user_id VARCHAR(96) NOT NULL DEFAULT '',
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
  await pool.query("ALTER TABLE connectors ADD COLUMN owner_user_id VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query("CREATE INDEX idx_connectors_owner ON connectors (owner_user_id, updated_at)").catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS credentials (
    credential_ref VARCHAR(96) PRIMARY KEY,
    owner_user_id VARCHAR(96) NOT NULL DEFAULT '',
    username_ciphertext TEXT NOT NULL,
    password_ciphertext TEXT NOT NULL,
    target_json JSON NOT NULL,
    label VARCHAR(200) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query("ALTER TABLE credentials ADD COLUMN owner_user_id VARCHAR(96) NOT NULL DEFAULT ''").catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(96) PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(120) NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(96) NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_sessions_expiry (expires_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS task_assignments (
    user_id VARCHAR(96) NOT NULL,
    task_id VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, task_id)
  )`);
  await pool.query(`
    UPDATE tasks t
    JOIN task_assignments a ON a.task_id = t.id
    SET t.owner_user_id = a.user_id
    WHERE t.owner_user_id = ''
  `).catch(() => {});
  await pool.query(`
    UPDATE connectors
    SET owner_user_id = COALESCE(
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(profile_json, '$.ownerUserId')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(profile_json, '$.ownerUserIds[0]')), ''),
      ''
    )
    WHERE owner_user_id = ''
  `).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS analysis_runs (
    id VARCHAR(96) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    market_snapshot_json JSON NOT NULL,
    evidence_json JSON NOT NULL,
    decision_json JSON NOT NULL,
    route VARCHAR(32) NOT NULL,
    round_no INT NULL,
    trigger_name VARCHAR(32) NULL,
    coverage_json JSON NULL,
    segment_reviews_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_analysis_task_time (task_id, created_at)
  )`);
  await pool.query("ALTER TABLE analysis_runs ADD COLUMN round_no INT NULL").catch(() => {});
  await pool.query("ALTER TABLE analysis_runs ADD COLUMN trigger_name VARCHAR(32) NULL").catch(() => {});
  await pool.query("ALTER TABLE analysis_runs ADD COLUMN coverage_json JSON NULL").catch(() => {});
  await pool.query("ALTER TABLE analysis_runs ADD COLUMN segment_reviews_json JSON NULL").catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_runs (
    id VARCHAR(128) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL,
    trigger_name VARCHAR(32) NOT NULL,
    current_stage VARCHAR(32) NOT NULL,
    line_count INT NOT NULL DEFAULT 0,
    final_action VARCHAR(8) NULL,
    route VARCHAR(32) NULL,
    code VARCHAR(96) NULL,
    started_at DATETIME NOT NULL,
    completed_at DATETIME NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_agent_runs_task_time (task_id, started_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_output (
    id VARCHAR(128) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(128) NOT NULL,
    sequence_no INT NOT NULL,
    stage VARCHAR(32) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    level_name VARCHAR(16) NOT NULL,
    message TEXT NOT NULL,
    data_json JSON NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_agent_output_run_seq (run_id, sequence_no),
    INDEX idx_agent_output_task_time (task_id, created_at)
  )`);
  await pool.query(`
    UPDATE tasks t
    JOIN (SELECT MIN(id) AS user_id FROM users HAVING COUNT(*) = 1) only_user
    SET t.owner_user_id = only_user.user_id
    WHERE t.owner_user_id = ''
  `).catch(() => {});
  await pool.query(`
    UPDATE connectors c
    JOIN tasks t ON JSON_UNQUOTE(JSON_EXTRACT(t.target_json, '$.connectorId')) = c.connector_id
    SET c.owner_user_id = t.owner_user_id
    WHERE c.owner_user_id = '' AND t.owner_user_id <> ''
  `).catch(() => {});
  for (const table of ["providers", "skills", "credentials", "connectors"]) {
    await pool.query(`
      UPDATE ${table} item
      JOIN (SELECT MIN(id) AS user_id FROM users HAVING COUNT(*) = 1) only_user
      SET item.owner_user_id = only_user.user_id
      WHERE item.owner_user_id = ''
    `).catch(() => {});
  }
  // Unresolved legacy ownership must survive startup for explicit repair.
  const foreignKeys = [
    "ALTER TABLE tasks ADD CONSTRAINT fk_tasks_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE providers ADD CONSTRAINT fk_providers_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE skills ADD CONSTRAINT fk_skills_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE credentials ADD CONSTRAINT fk_credentials_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE connectors ADD CONSTRAINT fk_connectors_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE skill_chunks ADD CONSTRAINT fk_skill_chunks_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE",
    "ALTER TABLE analysis_runs ADD CONSTRAINT fk_analysis_runs_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE agent_runs ADD CONSTRAINT fk_agent_runs_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE agent_output ADD CONSTRAINT fk_agent_output_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE orders ADD CONSTRAINT fk_orders_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE rules ADD CONSTRAINT fk_rules_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE agent_decisions ADD CONSTRAINT fk_agent_decisions_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
    "ALTER TABLE risk_checks ADD CONSTRAINT fk_risk_checks_decision FOREIGN KEY (decision_id) REFERENCES agent_decisions(id) ON DELETE CASCADE",
  ];
  for (const statement of foreignKeys) await pool.query(statement).catch(() => {});
  await compactStoredTaskRuntimes(pool);
  await purgeEphemeralMysql(pool);
  const adapter = {
    mode: "mysql",
    available: true,
    detail: "MySQL 已连接",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    async recordAudit(event) {
      if (!shouldPersistAuditEvent(event?.type)) return;
      await pool.execute(
        "INSERT INTO audit_logs (event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json)",
        [event.id, event.type, json(event)],
      );
    },
    async saveTask(task) {
      const runtime = compactTaskRuntime(task);
      await pool.execute(
        `INSERT INTO tasks (id, owner_user_id, name, status, mode, symbol, timeframe, target_json, risk_profile, stop_locked, runtime_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), name=VALUES(name), status=VALUES(status), mode=VALUES(mode), symbol=VALUES(symbol), timeframe=VALUES(timeframe), target_json=VALUES(target_json), risk_profile=VALUES(risk_profile), stop_locked=VALUES(stop_locked), runtime_json=VALUES(runtime_json), updated_at=NOW()`,
        [task.id, task.ownerUserId || "", task.name, task.status, task.mode, task.symbol, task.timeframe, json(task.target), task.riskProfile, Boolean(task.stopLocked), json(runtime)],
      );
    },
    async deleteTaskData({ taskId, ownerUserId }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [owned] = await connection.execute(
          "SELECT id FROM tasks WHERE id = ? AND owner_user_id = ? FOR UPDATE",
          [taskId, ownerUserId],
        );
        if (!owned.length) throw new Error("TASK_NOT_FOUND");
        const [decisions] = await connection.execute("SELECT id FROM agent_decisions WHERE task_id = ?", [taskId]);
        const decisionIds = decisions.map((row) => row.id);
        if (decisionIds.length) {
          await connection.execute(`DELETE FROM risk_checks WHERE decision_id IN (${decisionIds.map(() => "?").join(",")})`, decisionIds);
        }
        for (const table of ["agent_output", "agent_runs", "analysis_runs", "orders", "rules", "agent_decisions", "task_assignments"]) {
          await connection.execute(`DELETE FROM ${table} WHERE task_id = ?`, [taskId]);
        }
        await connection.execute("DELETE FROM tasks WHERE id = ? AND owner_user_id = ?", [taskId, ownerUserId]);
        await connection.execute(
          "DELETE FROM audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.metadata.taskId')) = ?",
          [taskId],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async saveSkill(skill) {
      await pool.execute(
        `INSERT INTO skills (id, owner_user_id, title, kind, source, status, version, tags_json, content, chunk_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), title=VALUES(title), kind=VALUES(kind), source=VALUES(source), status=VALUES(status), version=VALUES(version), tags_json=VALUES(tags_json), content=VALUES(content), chunk_count=VALUES(chunk_count), updated_at=NOW()`,
        [skill.id, skill.ownerUserId || "", skill.title, skill.kind, skill.source, skill.status, skill.version, json(skill.tags), skill.content, skill.chunks || 0],
      );
    },
    async deleteSkill(skillId) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute("DELETE FROM skill_chunks WHERE skill_id = ?", [skillId]);
        await connection.execute("DELETE FROM skills WHERE id = ?", [skillId]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async saveProvider(provider) {
      await pool.execute(
        `INSERT INTO providers (id, owner_user_id, provider_key, name, model, models_json, base_url, api_format, models_url, full_url_mode, encrypted_key, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), provider_key=VALUES(provider_key), name=VALUES(name), model=VALUES(model), models_json=VALUES(models_json), base_url=VALUES(base_url), api_format=VALUES(api_format), models_url=VALUES(models_url), full_url_mode=VALUES(full_url_mode), encrypted_key=VALUES(encrypted_key), status=VALUES(status), updated_at=NOW()`,
        [provider.id, provider.ownerUserId || "", provider.providerKey || provider.id, provider.name, provider.model, json(provider.models || [provider.model]), provider.baseUrl, provider.apiFormat || "", provider.modelsUrl || "", provider.fullUrlMode === true ? 1 : 0, provider.encryptedKey || "", provider.status || "未验证"],
      );
    },
    async deleteProvider(providerId) {
      await pool.execute("DELETE FROM providers WHERE id = ?", [providerId]);
    },
    async saveConnector(connector) {
      await pool.execute(
        `INSERT INTO connectors (connector_id, owner_user_id, type, target_value, name, adapter_id, adapter_version, status, profile_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), type=VALUES(type), target_value=VALUES(target_value), name=VALUES(name), adapter_id=VALUES(adapter_id), adapter_version=VALUES(adapter_version), status=VALUES(status), profile_json=VALUES(profile_json), updated_at=NOW()`,
        [connector.connectorId, connector.ownerUserId || "", connector.type, connector.target, connector.name, connector.adapterId, connector.adapterVersion, connector.status, json(connector)],
      );
    },
    async deleteConnector(connectorId) {
      await pool.execute("DELETE FROM connectors WHERE connector_id = ?", [connectorId]);
    },
    async saveCredential(record) {
      await pool.execute(
        `INSERT INTO credentials (credential_ref, owner_user_id, username_ciphertext, password_ciphertext, target_json, label, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), username_ciphertext=VALUES(username_ciphertext), password_ciphertext=VALUES(password_ciphertext), target_json=VALUES(target_json), label=VALUES(label), updated_at=NOW()`,
        [record.id, record.ownerUserId || "", record.username, record.password, json(record.target), record.label || ""],
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
    async saveAnalysis() {},
    async saveAgentRun() {},
    async saveAgentOutput() {},
    async saveUser(user) {
      await pool.execute(
        `INSERT INTO users (id, username, display_name, password_hash, status, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username=VALUES(username), display_name=VALUES(display_name), password_hash=VALUES(password_hash), status=VALUES(status), updated_at=NOW()`,
        [user.id, user.username, user.displayName, user.passwordHash, user.status],
      );
    },
    async deleteUserData({ userId, taskIds = [] }) {
      const connection = await pool.getConnection();
      const ids = [...new Set(taskIds.map(String).filter(Boolean))];
      const placeholders = ids.map(() => "?").join(",");
      try {
        await connection.beginTransaction();
        if (ids.length) {
          const decisionRows = await connection.query(`SELECT id FROM agent_decisions WHERE task_id IN (${placeholders})`, ids);
          const decisionIds = decisionRows[0].map((row) => row.id);
          if (decisionIds.length) {
            await connection.execute(`DELETE FROM risk_checks WHERE decision_id IN (${decisionIds.map(() => "?").join(",")})`, decisionIds);
          }
          for (const table of ["agent_output", "agent_runs", "analysis_runs", "orders", "rules", "agent_decisions"]) {
            await connection.execute(`DELETE FROM ${table} WHERE task_id IN (${placeholders})`, ids);
          }
          await connection.execute(`DELETE FROM task_assignments WHERE task_id IN (${placeholders})`, ids);
          await connection.execute(`DELETE FROM tasks WHERE id IN (${placeholders})`, ids);
        }
        await connection.execute("DELETE sc FROM skill_chunks sc JOIN skills s ON s.id = sc.skill_id WHERE s.owner_user_id = ?", [userId]);
        await connection.execute("DELETE FROM skills WHERE owner_user_id = ?", [userId]);
        await connection.execute("DELETE FROM providers WHERE owner_user_id = ?", [userId]);
        await connection.execute("DELETE FROM credentials WHERE owner_user_id = ?", [userId]);
        await connection.execute("DELETE FROM user_sessions WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM task_assignments WHERE user_id = ?", [userId]);
        await connection.execute("DELETE FROM connectors WHERE owner_user_id = ?", [userId]);
        if (ids.length) {
          await connection.execute(
            `DELETE FROM audit_logs WHERE actor_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.metadata.userId')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.metadata.taskId')) IN (${placeholders})`,
            [userId, userId, ...ids],
          );
        } else {
          await connection.execute(
            "DELETE FROM audit_logs WHERE actor_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.metadata.userId')) = ?",
            [userId, userId],
          );
        }
        await connection.execute("DELETE FROM users WHERE id = ?", [userId]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async saveUserSession(session) {
      await pool.execute(
        `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), expires_at=VALUES(expires_at)`,
        [session.tokenHash, session.userId, session.expiresAt],
      );
    },
    async deleteUserSession(tokenHash) {
      await pool.execute("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
    },
    async clearTaskAssignments() {
      await pool.execute("DELETE FROM task_assignments");
    },
    async saveAssignment(assignment) {
      await pool.execute("INSERT IGNORE INTO task_assignments (user_id, task_id) VALUES (?, ?)", [assignment.userId, assignment.taskId]);
    },
    async deleteAssignment(assignment) {
      await pool.execute("DELETE FROM task_assignments WHERE user_id = ? AND task_id = ?", [assignment.userId, assignment.taskId]);
    },
    async loadState() {
      const [taskRows] = await pool.query("SELECT * FROM tasks");
      const [skillRows] = await pool.query("SELECT * FROM skills");
      const [providerRows] = await pool.query("SELECT * FROM providers");
      const [connectorRows] = await pool.query("SELECT * FROM connectors");
      const [orderRows] = await pool.query(recentRowsSql("orders", "id", "created_at", 200)).catch(() => [[]]);
      const [eventRows] = await pool.query(
        "SELECT payload_json FROM audit_logs WHERE event_type IN ('admin_login','user_login','user_created','user_updated','user_deleted','user_bootstrapped') ORDER BY created_at DESC LIMIT 80",
      ).catch(() => [[]]);
      const [userRows] = await pool.query("SELECT * FROM users");
      const [assignmentRows] = await pool.query("SELECT user_id, task_id FROM task_assignments");
      taskRows.sort(byDesc("updated_at"));
      skillRows.sort(byDesc("updated_at"));
      providerRows.sort(byDesc("updated_at"));
      connectorRows.sort(byDesc("updated_at"));
      userRows.sort(byDesc("updated_at"));
      orderRows.sort(byDesc("created_at"));
      return {
        tasks: taskRows.map((row) => {
          const target = parse(row.target_json, {});
          const runtime = parse(row.runtime_json, {});
          return {
            id: row.id,
            ownerUserId: row.owner_user_id || "",
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
            lastAnalysisAt: runtime.lastAnalysisAt || null,
            lastHeartbeatEventAt: runtime.lastHeartbeatEventAt || null,
            heartbeatAt: runtime.heartbeatAt,
            leaseExpiresAt: runtime.leaseExpiresAt,
            monitoringEnabled: runtime.monitoringEnabled === undefined ? row.status === "MONITORING" : runtime.monitoringEnabled === true,
            monitorAllBoards: runtime.monitorAllBoards === true,
            monitorGeneration: Number(runtime.monitorGeneration || 0),
            monitoringRound: Number(runtime.monitoringRound || 0),
            monitorFailureCount: Number(runtime.monitorFailureCount || 0),
            lastObservedFingerprint: runtime.lastObservedFingerprint || "",
            lastAnalyzedFingerprint: runtime.lastAnalyzedFingerprint || "",
            lastAnalysisSucceeded: runtime.lastAnalysisSucceeded === true,
            lastPolledAt: runtime.lastPolledAt || null,
            lastCycleAt: runtime.lastCycleAt || null,
            nextPollAt: runtime.nextPollAt || null,
            analysisCoverage: runtime.analysisCoverage || null,
            autoDecisionEnabled: runtime.autoDecisionEnabled === true,
            autoDecisionCountdownSec: Number(runtime.autoDecisionCountdownSec || 30),
            automationTestMode: runtime.automationTestMode !== false,
            providerId: String(runtime.providerId || ""),
            pendingAction: runtime.pendingAction || null,
            market: null,
            activeRunId: runtime.activeRunId,
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()),
          };
        }),
        skills: skillRows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id || "", title: row.title, kind: row.kind, source: row.source, status: row.status, version: row.version, tags: parse(row.tags_json, []), chunks: row.chunk_count || 0, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()), summary: String(row.content || "").slice(0, 120), content: row.content })),
        providers: providerRows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id || "", providerKey: row.provider_key || row.id, name: row.name, model: row.model, models: parse(row.models_json, [row.model]), baseUrl: row.base_url, apiFormat: row.api_format || "", modelsUrl: row.models_url || "", fullUrlMode: row.full_url_mode === 1 || row.full_url_mode === true, encryptedKey: row.encrypted_key, keyPreview: "", status: row.status })),
        connectors: connectorRows.map((row) => ({ ...parse(row.profile_json, { connectorId: row.connector_id, type: row.type, target: row.target_value, name: row.name, adapterId: row.adapter_id, adapterVersion: row.adapter_version, status: row.status }), ownerUserId: row.owner_user_id || "" })),
        orders: orderRows.map((row) => parse(row.order_json, { id: row.id, idempotencyKey: row.idempotency_key, taskId: row.task_id, symbol: row.symbol, action: row.action, mode: row.mode, status: row.status })),
        events: eventRows.map((row) => parse(row.payload_json, null)).filter(Boolean).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
        users: userRows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "") })),
        assignments: assignmentRows.map((row) => ({ userId: row.user_id, taskId: row.task_id })),
        analyses: [],
        agentRuns: [],
        agentOutput: [],
      };
    },
    async loadCredentials() {
      const [rows] = await pool.query("SELECT credential_ref, owner_user_id, username_ciphertext, password_ciphertext, target_json, label, created_at, updated_at FROM credentials");
      return rows.map((row) => ({ id: row.credential_ref, ownerUserId: row.owner_user_id || "", username: row.username_ciphertext, password: row.password_ciphertext, target: parse(row.target_json, {}), label: row.label || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "") }));
    },
    async loadUsers() {
      const [rows] = await pool.query("SELECT id, username, display_name, password_hash, status, created_at, updated_at FROM users");
      return rows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "") }));
    },
    async loadUserSessions() {
      const [rows] = await pool.query("SELECT token_hash, user_id, expires_at FROM user_sessions WHERE expires_at > ?", [Date.now()]);
      return rows.map((row) => ({ tokenHash: row.token_hash, userId: row.user_id, expiresAt: Number(row.expires_at) }));
    },
    async loadAssignments() {
      const [rows] = await pool.query("SELECT user_id, task_id FROM task_assignments").catch(() => [[]]);
      return rows.map((row) => ({ userId: row.user_id, taskId: row.task_id }));
    },
    close: () => pool.end(),
  };
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "clearTaskAssignments", "saveAssignment", "deleteAssignment"]);
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
    analyses: database.collection("analysis_runs"),
    users: database.collection("users"),
    sessions: database.collection("user_sessions"),
    assignments: database.collection("task_assignments"),
    agentRuns: database.collection("agent_runs"),
    agentOutput: database.collection("agent_output"),
  };
  const adapter = {
    mode: "mongo",
    available: true,
    detail: "MongoDB 已连接",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    async recordAudit(event) {
      if (!shouldPersistAuditEvent(event?.type)) return;
      await collections.audit.replaceOne({ _id: event.id }, { ...event, _id: event.id }, { upsert: true });
    },
    saveTask: (task) => collections.tasks.replaceOne({ _id: task.id }, { ...task, ...compactTaskRuntime(task), _id: task.id }, { upsert: true }),
    async deleteTaskData({ taskId, ownerUserId }) {
      const owned = await collections.tasks.findOne({ _id: taskId, ownerUserId });
      if (!owned) throw new Error("TASK_NOT_FOUND");
      await Promise.all([
        collections.tasks.deleteOne({ _id: taskId, ownerUserId }),
        collections.assignments.deleteMany({ taskId }),
        collections.orders.deleteMany({ taskId }),
        collections.analyses.deleteMany({ taskId }),
        collections.agentRuns.deleteMany({ taskId }),
        collections.agentOutput.deleteMany({ taskId }),
        collections.audit.deleteMany({ "metadata.taskId": taskId }),
      ]);
    },
    saveSkill: (skill) => collections.skills.replaceOne({ _id: skill.id }, { ...skill, _id: skill.id }, { upsert: true }),
    deleteSkill: (id) => collections.skills.deleteOne({ _id: id }),
    saveProvider: (provider) => collections.providers.replaceOne({ _id: provider.id }, { ...provider, _id: provider.id }, { upsert: true }),
    deleteProvider: (id) => collections.providers.deleteOne({ _id: id }),
    saveConnector: (connector) => collections.connectors.replaceOne({ _id: connector.connectorId }, { ...connector, _id: connector.connectorId }, { upsert: true }),
    deleteConnector: (id) => collections.connectors.deleteOne({ _id: id }),
    saveCredential: (record) => collections.credentials.replaceOne({ _id: record.id }, { ...record, _id: record.id }, { upsert: true }),
    saveOrder: (order) => collections.orders.replaceOne({ _id: order.id }, { ...order, _id: order.id }, { upsert: true }),
    async saveAnalysis() {},
    async saveAgentRun() {},
    async saveAgentOutput() {},
    saveUser: (user) => collections.users.replaceOne({ _id: user.id }, { ...user, _id: user.id }, { upsert: true }),
    async deleteUserData({ userId, taskIds = [] }) {
      const ids = [...new Set(taskIds.map(String).filter(Boolean))];
      await Promise.all([
        collections.skills.deleteMany({ ownerUserId: userId }),
        collections.providers.deleteMany({ ownerUserId: userId }),
        collections.credentials.deleteMany({ ownerUserId: userId }),
        collections.connectors.deleteMany({ ownerUserId: userId }),
        collections.sessions.deleteMany({ userId }),
        collections.assignments.deleteMany({ $or: [{ userId }, { taskId: { $in: ids } }] }),
        collections.tasks.deleteMany({ _id: { $in: ids } }),
        collections.orders.deleteMany({ taskId: { $in: ids } }),
        collections.analyses.deleteMany({ taskId: { $in: ids } }),
        collections.agentRuns.deleteMany({ taskId: { $in: ids } }),
        collections.agentOutput.deleteMany({ taskId: { $in: ids } }),
        collections.audit.deleteMany({ $or: [{ "metadata.userId": userId }, { "metadata.taskId": { $in: ids } }] }),
        collections.users.deleteOne({ _id: userId }),
      ]);
    },
    saveUserSession: (session) => collections.sessions.replaceOne({ _id: session.tokenHash }, { ...session, _id: session.tokenHash }, { upsert: true }),
    deleteUserSession: (tokenHash) => collections.sessions.deleteOne({ _id: tokenHash }),
    clearTaskAssignments: () => collections.assignments.deleteMany({}),
    saveAssignment: (assignment) => collections.assignments.replaceOne({ _id: `${assignment.userId}:${assignment.taskId}` }, { ...assignment, _id: `${assignment.userId}:${assignment.taskId}` }, { upsert: true }),
    deleteAssignment: (assignment) => collections.assignments.deleteOne({ _id: `${assignment.userId}:${assignment.taskId}` }),
    async loadState() {
      const [tasks, skills, providers, connectors, orders, events, users, assignments] = await Promise.all([
        collections.tasks.find().sort({ updatedAt: -1 }).toArray(),
        collections.skills.find().sort({ updatedAt: -1 }).toArray(),
        collections.providers.find().sort({ updatedAt: -1 }).toArray(),
        collections.connectors.find().sort({ updatedAt: -1 }).toArray(),
        collections.orders.find().sort({ createdAt: -1 }).limit(200).toArray(),
        collections.audit.find({ type: { $in: [...PERSISTED_AUDIT_TYPES] } }).sort({ createdAt: -1 }).limit(80).toArray(),
        collections.users.find().sort({ updatedAt: -1 }).toArray(),
        collections.assignments.find().toArray(),
      ]);
      return { tasks: tasks.map(({ _id, ...item }) => item), skills: skills.map(({ _id, ...item }) => item), providers: providers.map(({ _id, ...item }) => item), connectors: connectors.map(({ _id, ...item }) => item), orders: orders.map(({ _id, ...item }) => item), events: events.map(({ _id, ...item }) => item), users: users.map(({ _id, ...item }) => item), assignments: assignments.map(({ _id, ...item }) => item), analyses: [], agentRuns: [], agentOutput: [] };
    },
    async loadCredentials() {
      const rows = await collections.credentials.find().toArray();
      return rows.map(({ _id, ...item }) => item);
    },
    async loadUsers() {
      return (await collections.users.find().toArray()).map(({ _id, ...item }) => item);
    },
    async loadUserSessions() {
      return (await collections.sessions.find({ expiresAt: { $gt: Date.now() } }).toArray()).map(({ _id, ...item }) => item);
    },
    async loadAssignments() {
      return (await collections.assignments.find().toArray()).map(({ userId, taskId }) => ({ userId, taskId }));
    },
    close: () => client.close(),
  };
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "clearTaskAssignments", "saveAssignment", "deleteAssignment"]);
}

export async function createPersistence() {
  const mode = process.env.DB_MODE || "memory";
  const allowMemoryFallback = process.env.ALLOW_MEMORY_FALLBACK === "1";
  if (mode === "mysql") {
    try { return await createMySqlAdapter(); } catch (error) {
      if (!allowMemoryFallback) throw new Error(`MYSQL_CONNECTION_FAILED: ${error.message}`);
      const adapter = createMemoryAdapter();
      adapter.mode = "mysql";
      adapter.available = false;
      adapter.detail = `MySQL 未连接：${error.message}`;
      return adapter;
    }
  }
  if (mode === "mongo") {
    try { return await createMongoAdapter(); } catch (error) {
      if (!allowMemoryFallback) throw new Error(`MONGO_CONNECTION_FAILED: ${error.message}`);
      const adapter = createMemoryAdapter();
      adapter.mode = "mongo";
      adapter.available = false;
      adapter.detail = `MongoDB 未连接：${error.message}`;
      return adapter;
    }
  }
  return createMemoryAdapter();
}
