import type { EventItem, Provider, RunItem, Skill, Task, Workspace } from "../types";

const now = new Date().toISOString();

export const demoTask: Task = {
  id: "task_demo_001",
  name: "BTC/USDT 趋势观察",
  status: "READY",
  mode: "PAPER",
  symbol: "BTC/USDT",
  timeframe: "15m",
  target: {
    type: "website",
    name: "Northstar Exchange",
    url: "https://demo.exchange.local",
    installPath: "",
    accountLabel: "未配置",
    credentialStatus: "未配置",
    connectionStatus: "disconnected",
    adapterStatus: "Northstar Adapter v1",
    discoveryStatus: "已发现",
  },
  automationAuthorized: false,
  riskProfile: "Balanced",
  workflow: [
    { key: "connect", label: "连接目标", status: "pending", detail: "等待连接" },
    { key: "login", label: "登录验证", status: "pending", detail: "等待凭据" },
    { key: "collect", label: "数据采集", status: "pending", detail: "等待只读行情" },
    { key: "analyze", label: "趋势分析", status: "pending", detail: "等待触发" },
    { key: "rules", label: "规则裁决", status: "pending", detail: "等待当前轮次" },
    { key: "action", label: "执行动作", status: "pending", detail: "默认只给出建议" },
  ],
  rules: [
    { id: "rule_01", order: 1, name: "数据新鲜度 < 5 秒", mode: "AUTO", status: "standby", detail: "等待实时数据" },
    { id: "rule_02", order: 2, name: "单品种仓位 ≤ 30%", mode: "AUTO", status: "standby", detail: "等待账户对账" },
    { id: "rule_03", order: 3, name: "突破后需人工复核", mode: "REVIEW", status: "standby", detail: "未触发" },
    { id: "rule_04", order: 4, name: "异常波动立即停止", mode: "BLOCK", status: "standby", detail: "未触发" },
  ],
  decision: {
    action: "HOLD",
    confidence: 0,
    targetPositionPct: 0,
    maxOrderValuePct: 0,
    reasonCodes: [],
    evidenceIds: [],
    invalidation: "完成一次真实分析后更新",
    riskFlags: ["NOT_ANALYZED"],
    createdAt: now,
    ttlSec: 300,
  },
  metrics: { equity: 0, dayPnl: 0, dayPnlPct: 0, exposurePct: 0, riskBudgetPct: 100 },
  nextTrigger: "等待启动",
  updatedAt: now,
  stopLocked: false,
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

export const demoProviders: Provider[] = [];

export const demoEvents: EventItem[] = [];

export const demoRuns: RunItem[] = [];

export const demoWorkspace: Workspace = {
  tasks: [demoTask],
  skills: demoSkills,
  providers: demoProviders,
  events: demoEvents,
  runs: demoRuns,
  health: { db: "memory", dbAvailable: true, persistentSecret: false },
  rag: { indexedChunks: 4, mode: "local-keyword", vectorProvider: "pluggable" },
};
