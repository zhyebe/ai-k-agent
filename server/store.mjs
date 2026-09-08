import { indexSkill } from "./rag.mjs";
import { publicProvider } from "./provider.mjs";

const isoNow = () => new Date().toISOString();

export const state = {
  tasks: [
    {
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
        connectorId: "connector_demo_northstar",
        credentialRef: "credential:demo",
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
        createdAt: isoNow(),
        ttlSec: 300,
      },
      metrics: { equity: 102840.32, dayPnl: 1284.2, dayPnlPct: 1.24, exposurePct: 18, riskBudgetPct: 62 },
      nextTrigger: "09:45:00",
      updatedAt: isoNow(),
      stopLocked: false,
      heartbeatAt: isoNow(),
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  ],
  skills: [
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
  ],
  providers: [
    { id: "provider_deepseek", name: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", encryptedKey: "", keyPreview: "", status: "未配置" },
    { id: "provider_custom", name: "自定义 OpenAI Compatible", model: "未设置", baseUrl: "", encryptedKey: "", keyPreview: "", status: "未配置" },
  ],
  events: [],
  runs: [
    { id: "run_20260907_01", taskId: "task_demo_001", status: "running", startedAt: isoNow(), decisions: 38, orders: 7, blocked: 3 },
  ],
  connectors: [
    {
      connectorId: "connector_demo_northstar",
      type: "website",
      target: "https://demo.exchange.local",
      name: "Northstar Exchange",
      adapterId: "northstar-web",
      adapterVersion: "1.0.0",
      status: "DISCOVERED",
      discoveryStatus: "已发现",
      adapterStatus: "Northstar Exchange v1.0.0",
      reviewStatus: "APPROVED",
      capabilities: ["navigate", "login", "read_history", "observe_orders", "paper_trade"],
      actionMapping: "模拟动作已映射",
      executionModes: ["PAPER", "SHADOW"],
      liveExecution: false,
      pathStatus: "unknown",
      discoveredAt: isoNow(),
    },
  ],
  orders: [],
};

for (const skill of state.skills) if (skill.status === "APPROVED") skill.chunks = indexSkill(skill);

let persistence = null;

export function setPersistence(adapter) {
  persistence = adapter;
}

export function hydrateState(snapshot) {
  if (!snapshot) return;
  if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks.length ? snapshot.tasks : state.tasks;
  if (Array.isArray(snapshot.skills)) state.skills = snapshot.skills.length ? snapshot.skills : state.skills;
  if (Array.isArray(snapshot.providers)) state.providers = snapshot.providers.length ? snapshot.providers : state.providers;
  if (Array.isArray(snapshot.connectors)) state.connectors = snapshot.connectors.length ? snapshot.connectors : state.connectors;
  if (Array.isArray(snapshot.orders)) state.orders = snapshot.orders;
  if (Array.isArray(snapshot.events)) state.events = snapshot.events;
  if (Array.isArray(snapshot.runs) && snapshot.runs.length) state.runs = snapshot.runs;
  for (const skill of state.skills) if (skill.status === "APPROVED") skill.chunks = indexSkill(skill);
}

export function getTask(taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

export function getConnector(connectorId) {
  return state.connectors.find((connector) => connector.connectorId === connectorId);
}

export function persistTask(task) {
  if (persistence?.saveTask) persistence.saveTask(task).catch(() => {});
}

export function persistSkill(skill) {
  if (persistence?.saveSkill) persistence.saveSkill(skill).catch(() => {});
}

export function persistProvider(provider) {
  if (persistence?.saveProvider) persistence.saveProvider(provider).catch(() => {});
}

export function persistConnector(connector) {
  if (persistence?.saveConnector) persistence.saveConnector(connector).catch(() => {});
}

export function persistOrder(order) {
  if (persistence?.saveOrder) persistence.saveOrder(order).catch(() => {});
}

export function addEvent(type, message, metadata = {}) {
  const event = { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, message, metadata, createdAt: isoNow() };
  state.events.unshift(event);
  if (state.events.length > 80) state.events.length = 80;
  if (persistence) persistence.recordAudit(event).catch(() => {});
  return event;
}

export function publicState() {
  return {
    tasks: state.tasks,
    skills: state.skills,
    providers: state.providers.map(publicProvider),
    events: state.events,
    runs: state.runs,
    connectors: state.connectors,
    orders: state.orders,
  };
}
