const LEGACY_DEMO_SKILL_IDS = ["skill_trend_1", "skill_guardrail_2"];

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
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "saveAssignment", "deleteAssignment"]);
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
  await pool.query("DELETE FROM skill_chunks WHERE skill_id IN (?, ?)", LEGACY_DEMO_SKILL_IDS).catch(() => {});
  await pool.query("DELETE FROM skills WHERE id IN (?, ?)", LEGACY_DEMO_SKILL_IDS).catch(() => {});
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
        lastAnalysisAt: task.lastAnalysisAt || null,
        lastHeartbeatEventAt: task.lastHeartbeatEventAt || null,
        heartbeatAt: task.heartbeatAt,
        leaseExpiresAt: task.leaseExpiresAt,
        monitoringEnabled: task.monitoringEnabled === undefined ? task.status === "MONITORING" : task.monitoringEnabled === true,
        monitorGeneration: task.monitorGeneration || 0,
        monitoringRound: task.monitoringRound || 0,
        monitorFailureCount: task.monitorFailureCount || 0,
        lastObservedFingerprint: task.lastObservedFingerprint || "",
        lastAnalyzedFingerprint: task.lastAnalyzedFingerprint || "",
        lastAnalysisSucceeded: task.lastAnalysisSucceeded === true,
        lastPolledAt: task.lastPolledAt || null,
        lastCycleAt: task.lastCycleAt || null,
        nextPollAt: task.nextPollAt || null,
        analysisCoverage: task.analysisCoverage || null,
        autoDecisionEnabled: task.autoDecisionEnabled === true,
        autoDecisionCountdownSec: Number(task.autoDecisionCountdownSec || 30),
        providerId: String(task.providerId || ""),
        pendingAction: task.pendingAction || null,
        market: task.market || null,
        activeRunId: task.activeRunId || null,
        connectorId: task.target?.connectorId || "",
        credentialRef: task.target?.credentialRef || "",
      };
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
        `INSERT INTO providers (id, owner_user_id, provider_key, name, model, base_url, api_format, encrypted_key, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id), provider_key=VALUES(provider_key), name=VALUES(name), model=VALUES(model), base_url=VALUES(base_url), api_format=VALUES(api_format), encrypted_key=VALUES(encrypted_key), status=VALUES(status), updated_at=NOW()`,
        [provider.id, provider.ownerUserId || "", provider.providerKey || provider.id, provider.name, provider.model, provider.baseUrl, provider.apiFormat || "", provider.encryptedKey || "", provider.status || "未验证"],
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
    async saveAnalysis(analysis) {
      await pool.execute(
        `INSERT INTO analysis_runs (id, task_id, market_snapshot_json, evidence_json, decision_json, route, round_no, trigger_name, coverage_json, segment_reviews_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE market_snapshot_json=VALUES(market_snapshot_json), evidence_json=VALUES(evidence_json), decision_json=VALUES(decision_json), route=VALUES(route), round_no=VALUES(round_no), trigger_name=VALUES(trigger_name), coverage_json=VALUES(coverage_json), segment_reviews_json=VALUES(segment_reviews_json)`,
        [analysis.id, analysis.taskId, json(analysis.market), json(analysis.evidence), json(analysis.decision), analysis.route, analysis.round ?? null, analysis.trigger || null, json(analysis.coverage), json(analysis.segmentReviews || [])],
      );
    },
    async saveAgentRun(run) {
      await pool.execute(
        `INSERT INTO agent_runs (id, task_id, status, trigger_name, current_stage, line_count, final_action, route, code, started_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status=VALUES(status), current_stage=VALUES(current_stage), line_count=VALUES(line_count), final_action=VALUES(final_action), route=VALUES(route), code=VALUES(code), completed_at=VALUES(completed_at), updated_at=NOW()`,
        [run.id, run.taskId, run.status, run.trigger || "manual", run.currentStage || "system", run.lineCount || 0, run.finalAction, run.route, run.code || null, toDateValue(run.startedAt), toDateValue(run.completedAt)],
      );
    },
    async saveAgentOutput(line) {
      await pool.execute(
        `INSERT INTO agent_output (id, task_id, run_id, sequence_no, stage, kind, level_name, message, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE message=VALUES(message), data_json=VALUES(data_json)`,
        [line.id, line.taskId, line.runId, line.sequence || 0, line.stage, line.kind, line.level, line.message, line.data === null ? null : json(line.data), toDateValue(line.createdAt)],
      );
    },
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
      const [eventRows] = await pool.query(recentRowsSql("audit_logs", "event_id", "created_at", 80, "t.payload_json")).catch(() => [[]]);
      const [userRows] = await pool.query("SELECT * FROM users");
      const [assignmentRows] = await pool.query("SELECT user_id, task_id FROM task_assignments");
      const [analysisRows] = await pool.query(recentRowsSql("analysis_runs", "id", "created_at", 200)).catch(() => [[]]);
      const [agentRunRows] = await pool.query(recentRowsSql("agent_runs", "id", "started_at", 100)).catch(() => [[]]);
      const [agentOutputRows] = await pool.query(recentRowsSql("agent_output", "id", "created_at", 1200)).catch(() => [[]]);
      taskRows.sort(byDesc("updated_at"));
      skillRows.sort(byDesc("updated_at"));
      providerRows.sort(byDesc("updated_at"));
      connectorRows.sort(byDesc("updated_at"));
      userRows.sort(byDesc("updated_at"));
      orderRows.sort(byDesc("created_at"));
      analysisRows.sort(byDesc("created_at"));
      agentRunRows.sort(byDesc("started_at"));
      agentOutputRows.sort(byDesc("created_at"));
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
            providerId: String(runtime.providerId || ""),
            pendingAction: runtime.pendingAction || null,
            market: runtime.market,
            activeRunId: runtime.activeRunId,
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()),
          };
        }),
        skills: skillRows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id || "", title: row.title, kind: row.kind, source: row.source, status: row.status, version: row.version, tags: parse(row.tags_json, []), chunks: row.chunk_count || 0, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || new Date().toISOString()), summary: String(row.content || "").slice(0, 120), content: row.content })),
        providers: providerRows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id || "", providerKey: row.provider_key || row.id, name: row.name, model: row.model, baseUrl: row.base_url, apiFormat: row.api_format || "", encryptedKey: row.encrypted_key, keyPreview: "", status: row.status })),
        connectors: connectorRows.map((row) => ({ ...parse(row.profile_json, { connectorId: row.connector_id, type: row.type, target: row.target_value, name: row.name, adapterId: row.adapter_id, adapterVersion: row.adapter_version, status: row.status }), ownerUserId: row.owner_user_id || "" })),
        orders: orderRows.map((row) => parse(row.order_json, { id: row.id, idempotencyKey: row.idempotency_key, taskId: row.task_id, symbol: row.symbol, action: row.action, mode: row.mode, status: row.status })),
        events: eventRows.map((row) => parse(row.payload_json, null)).filter(Boolean).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
        users: userRows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, passwordHash: row.password_hash, status: row.status, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "") })),
        assignments: assignmentRows.map((row) => ({ userId: row.user_id, taskId: row.task_id })),
        analyses: analysisRows.map((row) => ({ id: row.id, taskId: row.task_id, round: row.round_no === null || row.round_no === undefined ? null : Number(row.round_no), trigger: row.trigger_name || "", market: parse(row.market_snapshot_json, {}), evidence: parse(row.evidence_json, []), decision: parse(row.decision_json, {}), coverage: parse(row.coverage_json, null), segmentReviews: parse(row.segment_reviews_json, []), route: row.route, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || "") })),
        agentRuns: agentRunRows.map((row) => ({ id: row.id, taskId: row.task_id, status: row.status, trigger: row.trigger_name, currentStage: row.current_stage, lineCount: row.line_count, finalAction: row.final_action, route: row.route, code: row.code, startedAt: dateValue(row.started_at), completedAt: dateValue(row.completed_at) })),
        agentOutput: agentOutputRows.map((row) => ({ id: row.id, taskId: row.task_id, runId: row.run_id, sequence: row.sequence_no, stage: row.stage, kind: row.kind, level: row.level_name, message: row.message, data: parse(row.data_json, null), createdAt: dateValue(row.created_at) })),
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
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "saveAssignment", "deleteAssignment"]);
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
  await collections.skills.deleteMany({ _id: { $in: LEGACY_DEMO_SKILL_IDS } });
  const adapter = {
    mode: "mongo",
    available: true,
    detail: "MongoDB 已连接",
    async health() {
      return { mode: adapter.mode, available: adapter.available, detail: adapter.detail };
    },
    recordAudit: (event) => collections.audit.replaceOne({ _id: event.id }, { ...event, _id: event.id }, { upsert: true }),
    saveTask: (task) => collections.tasks.replaceOne({ _id: task.id }, { ...task, _id: task.id }, { upsert: true }),
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
    saveAnalysis: (analysis) => collections.analyses.replaceOne({ _id: analysis.id }, { ...analysis, _id: analysis.id }, { upsert: true }),
    saveAgentRun: (run) => collections.agentRuns.replaceOne({ _id: run.id }, { ...run, _id: run.id }, { upsert: true }),
    saveAgentOutput: (line) => collections.agentOutput.replaceOne({ _id: line.id }, { ...line, _id: line.id }, { upsert: true }),
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
    saveAssignment: (assignment) => collections.assignments.replaceOne({ _id: `${assignment.userId}:${assignment.taskId}` }, { ...assignment, _id: `${assignment.userId}:${assignment.taskId}` }, { upsert: true }),
    deleteAssignment: (assignment) => collections.assignments.deleteOne({ _id: `${assignment.userId}:${assignment.taskId}` }),
    async loadState() {
      const [tasks, skills, providers, connectors, orders, events, users, assignments, analyses, agentRuns, agentOutput] = await Promise.all([
        collections.tasks.find().sort({ updatedAt: -1 }).toArray(),
        collections.skills.find().sort({ updatedAt: -1 }).toArray(),
        collections.providers.find().sort({ updatedAt: -1 }).toArray(),
        collections.connectors.find().sort({ updatedAt: -1 }).toArray(),
        collections.orders.find().sort({ createdAt: -1 }).limit(200).toArray(),
        collections.audit.find().sort({ createdAt: -1 }).limit(80).toArray(),
        collections.users.find().sort({ updatedAt: -1 }).toArray(),
        collections.assignments.find().toArray(),
        collections.analyses.find().sort({ createdAt: -1 }).limit(200).toArray(),
        collections.agentRuns.find().sort({ startedAt: -1 }).limit(100).toArray(),
        collections.agentOutput.find().sort({ createdAt: -1 }).limit(1200).toArray(),
      ]);
      return { tasks: tasks.map(({ _id, ...item }) => item), skills: skills.map(({ _id, ...item }) => item), providers: providers.map(({ _id, ...item }) => item), connectors: connectors.map(({ _id, ...item }) => item), orders: orders.map(({ _id, ...item }) => item), events: events.map(({ _id, ...item }) => item), users: users.map(({ _id, ...item }) => item), assignments: assignments.map(({ _id, ...item }) => item), analyses: analyses.map(({ _id, ...item }) => item), agentRuns: agentRuns.map(({ _id, ...item }) => item), agentOutput: agentOutput.map(({ _id, ...item }) => item) };
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
  return serializeWrites(adapter, ["recordAudit", "saveTask", "deleteTaskData", "saveSkill", "deleteSkill", "saveProvider", "deleteProvider", "saveConnector", "deleteConnector", "saveCredential", "saveOrder", "saveAnalysis", "saveAgentRun", "saveAgentOutput", "saveUser", "deleteUserData", "saveUserSession", "deleteUserSession", "saveAssignment", "deleteAssignment"]);
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
