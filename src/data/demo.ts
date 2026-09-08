import type { EventItem, Provider, RunItem, Skill, Task, Workspace } from "../types";

const now = new Date().toISOString();

export const demoTask: Task = {
  id: "task_demo_001",
  name: "BTC/USDT 趋势观察",
  status: "MONITORING",
  mode: "PAPER",
  symbol: "BTC/USDT",
  timeframe: "15m",
  target: {
    type: "website",
    name: "Northstar Exchange",
    url: "https://demo.exchange.local",
    installPath: "",
    accountLabel: "trader@demo",
    credentialStatus: "已托管",
    connectionStatus: "connected",
    adapterStatus: "Northstar Adapter v1",
    discoveryStatus: "已发现",
  },
  riskProfile: "Balanced",
  workflow: [
    { key: "connect", label: "连接目标", status: "complete", detail: "浏览器会话已建立" },
    { key: "login", label: "登录验证", status: "complete", detail: "凭据已脱敏注入" },
    { key: "collect", label: "数据采集", status: "complete", detail: "历史 2,400 根 K 线" },
    { key: "analyze", label: "趋势分析", status: "active", detail: "15m 收盘触发" },
    { key: "rules", label: "规则裁决", status: "pending", detail: "等待当前轮次" },
    { key: "action", label: "执行动作", status: "pending", detail: "风控通过后执行" },
  ],
  rules: [
    { id: "rule_01", order: 1, name: "数据新鲜度 < 5 秒", mode: "AUTO", status: "passed", detail: "延迟 1.2 秒" },
    { id: "rule_02", order: 2, name: "单品种仓位 ≤ 30%", mode: "AUTO", status: "passed", detail: "当前 18%" },
    { id: "rule_03", order: 3, name: "突破后需人工复核", mode: "REVIEW", status: "pending", detail: "触发条件已满足" },
    { id: "rule_04", order: 4, name: "异常波动立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
  ],
  decision: {
    action: "BUY",
    confidence: 0.78,
    targetPositionPct: 24,
    maxOrderValuePct: 8,
    reasonCodes: ["EMA_SLOPE_POSITIVE", "VOLUME_CONFIRMATION"],
    evidenceIds: ["evidence:skill_trend_1-chunk-1", "candle:2026-09-07T09:45Z"],
    invalidation: "15m 收盘跌破 EMA20 或数据延迟超过 5 秒",
    riskFlags: [],
    createdAt: now,
    ttlSec: 300,
  },
  metrics: { equity: 102840.32, dayPnl: 1284.2, dayPnlPct: 1.24, exposurePct: 18, riskBudgetPct: 62 },
  nextTrigger: "09:45:00",
  updatedAt: now,
  stopLocked: false,
  heartbeatAt: now,
  leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

export const demoSkills: Skill[] = [
  {
    id: "skill_trend_1",
    title: "趋势突破与回撤红线",
    kind: "expert",
    source: "专家复盘 · 交易组 A",
    status: "APPROVED",
    version: "v1.3",
    tags: ["BTC/USDT", "15m", "趋势", "红线"],
    chunks: 4,
    updatedAt: "2026-09-06T08:20:00Z",
    summary: "突破须有成交量确认；跌破 EMA20 时禁止追单。",
    content: "适用于 BTC/USDT 15m 趋势行情。突破前高且成交量高于 20 根均值 1.4 倍时，可考虑小仓位买入。跌破 EMA20、数据延迟超过 5 秒或连续两次信号冲突时禁止追单并保持 HOLD。任何异常波动需要人工复核。",
  },
  {
    id: "skill_guardrail_2",
    title: "模拟盘账户红线",
    kind: "guardrail",
    source: "风险委员会",
    status: "REVIEW",
    version: "draft-2",
    tags: ["风控", "模拟盘", "人工复核"],
    chunks: 0,
    updatedAt: "2026-09-07T06:10:00Z",
    summary: "单笔金额、日亏损和异常波动需明确处理路径。",
    content: "单笔订单金额不得超过账户权益 8%，单日亏损达到 3% 时停止自动交易并通知人工。",
  },
];

export const demoProviders: Provider[] = [
  { id: "provider_deepseek", name: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", configured: false, keyPreview: "未配置", status: "未配置" },
  { id: "provider_custom", name: "自定义 OpenAI Compatible", model: "未设置", baseUrl: "", configured: false, keyPreview: "未配置", status: "未配置" },
];

export const demoEvents: EventItem[] = [
  { id: "evt_1", type: "decision", message: "模型输出 BUY，等待规则 3 人工复核", metadata: {}, createdAt: "2026-09-07T09:30:10Z" },
  { id: "evt_2", type: "risk", message: "规则 1、2 自动通过，风险预算剩余 62%", metadata: {}, createdAt: "2026-09-07T09:29:48Z" },
  { id: "evt_3", type: "data", message: "完成最新 15m K 线采集，延迟 1.2 秒", metadata: {}, createdAt: "2026-09-07T09:28:32Z" },
  { id: "evt_4", type: "system", message: "任务租约续期成功，控制器在线", metadata: {}, createdAt: "2026-09-07T09:15:00Z" },
];

export const demoRuns: RunItem[] = [
  { id: "run_20260907_01", taskId: "task_demo_001", status: "running", startedAt: now, decisions: 38, orders: 7, blocked: 3 },
];

export const demoWorkspace: Workspace = {
  tasks: [demoTask],
  skills: demoSkills,
  providers: demoProviders,
  events: demoEvents,
  runs: demoRuns,
  health: { db: "memory", dbAvailable: true, persistentSecret: false },
  rag: { indexedChunks: 4, mode: "local-keyword", vectorProvider: "pluggable" },
};
