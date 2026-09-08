export type ViewKey = "console" | "workflows" | "skills" | "connectors" | "runs";

export type DesktopUpdateStatus = "disabled" | "unsupported" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "not-available" | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  progress: number;
  error: string | null;
}

export interface DesktopUpdateBridge {
  getState: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  onState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

declare global {
  interface Window {
    axiomDesktop?: {
      platform: string;
      isDesktop: boolean;
      apiBaseUrl: string;
      updates?: DesktopUpdateBridge;
    };
  }
}

export type TaskStatus =
  | "READY"
  | "STARTING"
  | "MONITORING"
  | "ANALYZING"
  | "RISK_CHECK"
  | "EXECUTING"
  | "STOPPING"
  | "MANUAL_CONTROL"
  | "PAUSED"
  | "BLOCKED"
  | "ERROR";

export interface WorkflowStep {
  key: string;
  label: string;
  status: "complete" | "active" | "pending";
  detail: string;
}

export interface Rule {
  id: string;
  order: number;
  name: string;
  mode: "AUTO" | "REVIEW" | "BLOCK";
  status: "passed" | "pending" | "standby";
  detail: string;
}

export interface Decision {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  targetPositionPct: number;
  maxOrderValuePct: number;
  reasonCodes: string[];
  evidenceIds: string[];
  invalidation: string;
  riskFlags: string[];
  createdAt: string;
  ttlSec: number;
}

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  mode: "PAPER" | "SHADOW" | "LIVE";
  symbol: string;
  timeframe: string;
  target: {
    type: "website" | "app";
    name: string;
    url?: string;
    appId?: string;
    installPath?: string;
    connectorId?: string;
    adapterId?: string;
    adapterVersion?: string;
    credentialRef?: string;
    accountLabel: string;
    credentialStatus: string;
    connectionStatus: string;
    loginStatus?: string;
    executionModes?: string[];
    adapterStatus?: string;
    discoveryStatus?: string;
  };
  riskProfile: string;
  workflow: WorkflowStep[];
  rules: Rule[];
  decision: Decision;
  metrics: { equity: number; dayPnl: number; dayPnlPct: number; exposurePct: number; riskBudgetPct: number };
  nextTrigger: string;
  updatedAt: string;
  stopLocked: boolean;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  market?: {
    source: string;
    symbol: string;
    timeframe: string;
    historyCount: number;
    latest: { price: number; open: number; high: number; low: number; volume: number };
    changePct: number;
    indicators: { ema20: number; rsi14: number; atr14: number; volumeRatio: number };
    trend: string;
    anomaly: boolean;
    freshnessSec: number;
    evidenceId: string;
    observedAt: string;
  };
}

export interface Skill {
  id: string;
  title: string;
  kind: "expert" | "rule" | "guardrail";
  source: string;
  status: "APPROVED" | "REVIEW" | "ARCHIVED";
  version: string;
  tags: string[];
  chunks: number;
  updatedAt: string;
  summary: string;
  content: string;
}

export interface Provider {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  configured: boolean;
  keyPreview: string;
  status: string;
}

export interface EventItem {
  id: string;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunItem {
  id: string;
  taskId: string;
  status: string;
  startedAt: string;
  decisions: number;
  orders: number;
  blocked: number;
}

export interface ConnectorProfile {
  connectorId: string;
  type: "website" | "app";
  target: string;
  name: string;
  adapterId: string;
  adapterVersion: string;
  status: string;
  discoveryStatus: string;
  adapterStatus: string;
  reviewStatus: string;
  capabilities: string[];
  actionMapping: string;
  executionModes: string[];
  liveExecution: boolean;
  pathStatus?: string;
  discoveredAt: string;
}

export interface OrderItem {
  id: string;
  idempotencyKey: string;
  taskId: string;
  symbol: string;
  action: "BUY" | "SELL";
  mode: "PAPER" | "SHADOW" | "LIVE";
  status: string;
  targetPositionPct: number;
  maxOrderValuePct: number;
  createdAt: string;
}

export interface Workspace {
  tasks: Task[];
  skills: Skill[];
  providers: Provider[];
  events: EventItem[];
  runs: RunItem[];
  connectors?: ConnectorProfile[];
  orders?: OrderItem[];
  health?: { db: string; dbAvailable: boolean; persistentSecret: boolean };
  rag?: { indexedChunks: number; mode: string; vectorProvider: string };
}
