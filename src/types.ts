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

export interface DesktopWindowBridge {
  minimize: () => Promise<void>;
  maximize: () => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  startResize: (edge: string) => void;
  resizeMove: () => void;
  endResize: () => void;
}

export interface DesktopApiBridge {
  getBaseUrl: () => Promise<string>;
  setBaseUrl: (value: string) => Promise<string>;
}

export interface DesktopAiBridge {
  connect: (session: { apiBaseUrl: string; userToken: string }) => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    axiomDesktop?: {
      platform: string;
      isDesktop: boolean;
      apiBaseUrl: string;
      api?: DesktopApiBridge;
      ai?: DesktopAiBridge;
      updates?: DesktopUpdateBridge;
      window?: DesktopWindowBridge;
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

export interface PendingAction {
  id: string;
  action: "BUY" | "SELL";
  status: "WAITING" | "SUBMITTING" | "CONFIRMED" | "TAKEN_OVER" | "CANCELLED";
  source?: "manual_confirm" | "auto_timeout" | "manual_takeover" | "manual_cancel" | null;
  suggestedQty: number | null;
  suggestedPrice: number | null;
  formFilled: boolean;
  formSubmitBlocked: boolean;
  createdAt: string;
  deadlineAt?: string | null;
  countdownSec: number;
  resolvedAt?: string | null;
  message: string;
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
  analysisSummary?: string;
  timeframeConsistency?: string;
  keyLevels?: unknown[];
  watchConditions?: unknown[];
}

export interface MarketCandle {
  timestamp: number;
  previousClose?: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount?: number | null;
  inventory?: number | null;
  partial?: boolean;
}

export interface MarketTimeframe {
  ok: boolean;
  code: string;
  message?: string;
  timeframe: string;
  label: string;
  kind: "kline";
  period: number | null;
  source: string;
  endpoint?: string;
  responseCount: number;
  requestedCount: number;
  history: MarketCandle[];
  historyCount: number;
  completeHistoryCount: number;
  firstTimestamp?: number | null;
  lastTimestamp?: number | null;
  dataAt?: string | null;
  indicators: Record<string, unknown>;
  trend: string;
  anomaly: boolean;
  missingFields: string[];
  dataQuality: string;
  ticks: MarketTick[];
  rawData?: unknown[];
}

export interface MarketTick {
  timestamp: number;
  price: number;
  volume: number;
  referencePrice?: number | null;
  averagePrice?: number | null;
  flag?: string;
}

export interface MarketSnapshot {
  ok?: boolean;
  code?: string;
  message?: string;
  source: string;
  sourceKind?: string;
  symbol: string;
  symbolName?: string;
  instrumentId?: string | null;
  instrument?: Record<string, unknown> | null;
  executionEnabled?: boolean;
  timeframe: string;
  historyCount: number;
  completeHistoryCount?: number;
  latest: { price: number | null; open: number | null; high: number | null; low: number | null; volume: number | null; settlement?: number | null; inventory?: number | null; positionChange?: number | null };
  changePct: number | null;
  indicators: { ema20: number | null; ema50?: number | null; sma20?: number | null; rsi14: number | null; atr14: number | null; volumeRatio: number | null; macd?: Record<string, number | null>; bollinger?: Record<string, number | null> };
  trend: string;
  anomaly: boolean;
  freshnessSec: number | null;
  evidenceId: string;
  fingerprint?: string;
  observedAt: string;
  dataAt?: string | null;
  dataQuality?: string;
  missingFields?: string[];
  marketClosed?: boolean;
  history: MarketCandle[];
  ticks: MarketTick[];
  timeframes?: Record<string, MarketTimeframe>;
  availableTimeframes?: string[];
  timeline?: { kind: string; source?: string; ticks: MarketTick[]; tickCount: number; dataAt?: string | null };
  page?: Record<string, unknown> | null;
  raw?: unknown;
  account?: {
    availableFunds?: number | null;
    equity?: number | null;
    riskRate?: number | null;
    dayPnl?: number | null;
    maxOrderQty?: number | null;
    exposurePct?: number | null;
    positionEmpty?: boolean;
  };
  pageView?: Record<string, unknown> | null;
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
    browserSessionId?: string;
  };
  automationAuthorized?: boolean;
  autoDecisionEnabled?: boolean;
  autoDecisionCountdownSec?: number;
  providerId?: string;
  pendingAction?: PendingAction | null;
  activeRunId?: string | null;
  riskProfile: string;
  workflow: WorkflowStep[];
  rules: Rule[];
  decision: Decision;
  metrics: { equity: number; dayPnl: number; dayPnlPct: number; exposurePct: number; riskBudgetPct: number };
  nextTrigger: string;
  updatedAt: string;
  stopLocked: boolean;
  monitoringEnabled?: boolean;
  monitorGeneration?: number;
  monitoringRound?: number;
  monitorFailureCount?: number;
  lastObservedFingerprint?: string;
  lastAnalyzedFingerprint?: string;
  lastAnalysisSucceeded?: boolean;
  lastPolledAt?: string | null;
  lastCycleAt?: string | null;
  nextPollAt?: string | null;
  analysisCoverage?: {
    mode: string;
    fingerprint?: string;
    estimatedDirectBytes?: number;
    totalSegments: number;
    totalKlineRows: number;
    totalLiveTickRows: number;
    reviewedSegments: number;
    failedSegments: Array<Record<string, unknown>>;
    complete: boolean;
  } | null;
  lastAnalysisAt?: string | null;
  lastHeartbeatEventAt?: string | null;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  market?: MarketSnapshot;
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
  apiFormat?: string;
  configured: boolean;
  keyPreview: string;
  status: string;
  owned?: boolean;
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

export interface AgentRun {
  id: string;
  taskId: string;
  status: string;
  trigger: string;
  currentStage: string;
  lineCount: number;
  finalAction: string | null;
  route: string | null;
  code?: string;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentOutputLine {
  id: string;
  taskId: string;
  runId: string;
  sequence: number;
  stage: string;
  kind: string;
  level: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface WorkspaceUser {
  id: string;
  username: string;
  displayName: string;
  assignedTaskIds: string[];
}

export interface Workspace {
  tasks: Task[];
  skills: Skill[];
  providers: Provider[];
  events: EventItem[];
  runs: RunItem[];
  connectors?: ConnectorProfile[];
  orders?: OrderItem[];
  analyses?: Array<Record<string, unknown>>;
  agentRuns?: AgentRun[];
  health?: { db: string; dbAvailable: boolean; persistentSecret: boolean };
  rag?: { indexedChunks: number; mode: string; vectorProvider: string };
  auth?: { type: "user" | "admin"; user?: WorkspaceUser; username?: string } | null;
}
