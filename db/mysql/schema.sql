CREATE DATABASE IF NOT EXISTS axiom_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE axiom_agent;

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(32) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  timeframe VARCHAR(16) NOT NULL,
  target_json JSON NOT NULL,
  risk_profile VARCHAR(64) NOT NULL,
  stop_locked BOOLEAN NOT NULL DEFAULT FALSE,
  runtime_json JSON NULL,
  config_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skills (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  source VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  version VARCHAR(32) NOT NULL,
  tags_json JSON NOT NULL,
  content MEDIUMTEXT NOT NULL,
  chunk_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_skills_status (status)
);

CREATE TABLE IF NOT EXISTS skill_chunks (
  id VARCHAR(96) PRIMARY KEY,
  skill_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  content TEXT NOT NULL,
  embedding_json JSON NULL,
  metadata_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_skill_chunks_skill FOREIGN KEY (skill_id) REFERENCES skills(id),
  INDEX idx_skill_chunks_skill (skill_id, version)
);

CREATE TABLE IF NOT EXISTS providers (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  model VARCHAR(160) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  encrypted_key TEXT NOT NULL,
  status VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rules (
  id VARCHAR(64) PRIMARY KEY,
  task_id VARCHAR(64) NULL,
  rule_order INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  expression_json JSON NOT NULL,
  action_json JSON NOT NULL,
  version VARCHAR(32) NOT NULL DEFAULT 'v1',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rules_task_order (task_id, rule_order)
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id VARCHAR(96) PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL,
  market_snapshot_json JSON NOT NULL,
  evidence_json JSON NOT NULL,
  input_summary TEXT NOT NULL,
  output_json JSON NOT NULL,
  model_name VARCHAR(160) NOT NULL,
  prompt_version VARCHAR(64) NOT NULL,
  final_action VARCHAR(8) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_decisions_task_time (task_id, created_at)
);

CREATE TABLE IF NOT EXISTS risk_checks (
  id VARCHAR(96) PRIMARY KEY,
  decision_id VARCHAR(96) NOT NULL,
  passed BOOLEAN NOT NULL,
  checks_json JSON NOT NULL,
  final_route VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_risk_decision (decision_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  event_id VARCHAR(96) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system',
  actor_id VARCHAR(96) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_type (event_type)
);

CREATE TABLE IF NOT EXISTS market_candles (
  symbol VARCHAR(32) NOT NULL,
  timeframe VARCHAR(16) NOT NULL,
  candle_time DATETIME NOT NULL,
  open_price DECIMAL(24, 10) NOT NULL,
  high_price DECIMAL(24, 10) NOT NULL,
  low_price DECIMAL(24, 10) NOT NULL,
  close_price DECIMAL(24, 10) NOT NULL,
  volume DECIMAL(32, 10) NOT NULL,
  source VARCHAR(64) NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, timeframe, candle_time)
);

CREATE TABLE IF NOT EXISTS connectors (
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
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_ref VARCHAR(96) PRIMARY KEY,
  username_ciphertext TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  target_json JSON NOT NULL,
  label VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(96) PRIMARY KEY,
  idempotency_key VARCHAR(220) NOT NULL UNIQUE,
  task_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  action VARCHAR(8) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL,
  order_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_task_time (task_id, created_at)
);
