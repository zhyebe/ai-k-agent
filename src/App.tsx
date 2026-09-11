import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CirclePause,
  Clock3,
  Database,
  Download,
  Eye,
  FileText,
  Gauge,
  Globe2,
  Hand,
  History,
  KeyRound,
  Laptop,
  LayoutDashboard,
  ListChecks,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Upload,
  UserRound,
  Waypoints,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import {
  analyzeTask,
  approveSkill,
  autoJudge,
  agentStreamUrl,
  claimManual,
  cancelPendingAction,
  confirmPendingAction,
  createTask,
  configureApiBaseUrl,
  deleteProvider,
  discoverConnector,
  fetchApiHealth,
  fetchAgentOutput,
  fetchWorkspace,
  getApiBaseUrl,
  getUserToken,
  clearUserToken,
  saveProvider,
  saveSkill,
  setAutoDecision,
  setTaskMode,
  setTaskProvider,
  startTask,
  stopTask,
  takeoverPendingAction,
  testConnector,
  testProvider,
  setUserToken,
  userLogin,
  userLogout,
  userSession,
} from "./lib/api";
import type { AgentOutputLine, AgentRun, DesktopUpdateState, MarketCandle, MarketTimeframe, PendingAction, Provider, Rule, SavedCredential, Skill, Task, TaskStatus, ViewKey, Workspace, WorkspaceUser } from "./types";

const navItems: Array<{ key: ViewKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: "console", label: "任务控制台", icon: LayoutDashboard },
  { key: "workflows", label: "工作流", icon: Workflow },
  { key: "skills", label: "经验与 Skills", icon: BookOpen },
  { key: "connectors", label: "连接器", icon: Waypoints },
  { key: "runs", label: "运行记录", icon: History },
];

const statusMeta: Record<TaskStatus, { label: string; tone: string; icon: typeof Activity }> = {
  READY: { label: "待启动", tone: "neutral", icon: CircleDashed },
  STARTING: { label: "启动检查中", tone: "blue", icon: RefreshCw },
  MONITORING: { label: "持续监控", tone: "green", icon: Activity },
  ANALYZING: { label: "正在分析", tone: "blue", icon: BarChart3 },
  RISK_CHECK: { label: "风控检查中", tone: "amber", icon: ShieldCheck },
  EXECUTING: { label: "执行动作中", tone: "green", icon: Zap },
  STOPPING: { label: "停止中", tone: "red", icon: Square },
  MANUAL_CONTROL: { label: "人工接管", tone: "amber", icon: Hand },
  PAUSED: { label: "已暂停", tone: "amber", icon: CirclePause },
  BLOCKED: { label: "启动被阻断", tone: "red", icon: CircleAlert },
  ERROR: { label: "异常已保护", tone: "red", icon: AlertTriangle },
};
const statusMetaLabels: Record<string, string> = Object.fromEntries(Object.entries(statusMeta).map(([key, value]) => [key, value.label]));

const formatCurrency = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatPercent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const actionLabels: Record<"BUY" | "SELL" | "HOLD", string> = { BUY: "买入", SELL: "卖出", HOLD: "观望" };
const actionSuggestionLabels: Record<"BUY" | "SELL" | "HOLD", string> = { BUY: "建议买入", SELL: "建议卖出", HOLD: "保持观望" };
const modeLabels: Record<string, string> = { PAPER: "观察 / 建议", SHADOW: "影子记录", LIVE: "实盘（确认后下单）" };
const trendLabels: Record<string, string> = { up: "上行", down: "下行", range: "震荡", unknown: "未知" };
const stageLabels: Record<string, string> = { connect: "连接目标", login: "登录验证", collect: "数据采集", analyze: "趋势分析", rules: "规则裁决", action: "动作建议", system: "系统" };
const routeLabels: Record<string, string> = {
  SUGGESTION_PENDING: "建议待确认",
  SUGGESTION_ONLY: "仅输出建议",
  BLOCKED: "已阻断",
  HOLD: "保持观望",
  HOLD_RULE: "规则要求观望",
  HOLD_DATA_QUALITY: "数据质量不足",
  HOLD_INVALID_EVIDENCE: "证据无效",
  HOLD_PROVIDER: "模型服务不可用",
  RISK_BLOCKED: "风控阻断",
  HUMAN_REVIEW_REQUIRED: "等待人工复核",
  AUTO_RULE_FAILED: "自动规则未通过",
  REAUTH_REQUIRED: "需要重新登录",
  CONNECT_FAILED: "连接失败",
  COLLECT_FAILED: "采集失败",
  CYCLE_IN_PROGRESS: "分析进行中",
  STOP_LOCKED: "停止锁定",
  TRADING_DISABLED: "交易动作已锁定",
  WAITING_FOR_CHANGE: "等待行情变化",
};
const riskLabels: Record<string, string> = {
  NOT_ANALYZED: "尚未分析",
  REAUTH_REQUIRED: "登录已失效",
  STALE_MARKET_DATA: "行情已过期",
  MARKET_CLOSED: "当前已闭市",
  HISTORY_INSUFFICIENT: "历史数据不足",
  DATA_QUALITY_LIMITED: "数据质量受限",
  DECISION_EXPIRED: "建议已过期",
  RISK_LIMIT_EXCEEDED: "超过风险上限",
  INVALID_EVIDENCE_REFERENCE: "证据引用无效",
  PROVIDER_REQUEST_FAILED: "模型请求失败",
  PROVIDER_NOT_CONFIGURED: "模型尚未配置",
  TRADING_DISABLED: "交易动作已锁定",
  RED_LINE_TRIGGERED: "触发红线",
  HUMAN_REVIEW_REQUIRED: "需要人工复核",
};
const reasonLabels: Record<string, string> = {
  EMA_SLOPE_POSITIVE: "EMA20 斜率为正",
  VOLUME_CONFIRMATION: "成交量确认突破",
  EMA_SLOPE_NEGATIVE: "EMA20 斜率为负",
  RSI_OVERBOUGHT: "RSI 处于超买区",
  RSI_OVERSOLD: "RSI 处于超卖区",
  BREAKOUT: "出现突破信号",
  BREAKDOWN: "出现跌破信号",
};
const connectionLabels: Record<string, string> = {
  connected: "登录已确认",
  readonly_ready: "只读已就绪",
  browser_ready: "浏览器已打开",
  credential_required: "待配置凭据",
  disconnected: "未连接",
  review_required: "待适配器审核",
  login_failed: "登录失败",
  connection_failed: "连接失败",
};
const providerStatusLabels: Record<string, string> = {
  PROVIDER_OK: "已验证",
  PROVIDER_NOT_READY: "未就绪",
  PROVIDER_NOT_CONFIGURED: "未配置",
  PROVIDER_AUTH_FAILED: "密钥无效",
  PROVIDER_HTTP_ERROR: "服务返回错误",
  PROVIDER_UNREACHABLE: "服务不可达",
};
const runStatusLabels: Record<string, string> = { running: "运行中", completed: "已完成", skipped: "已跳过", paused: "已暂停", error: "异常保护" };
const displayLabel = (value: string | null | undefined, labels: Record<string, string>, fallback: string) => {
  const normalized = String(value || "");
  return labels[normalized] || (normalized && /[\u4e00-\u9fff]/.test(normalized) ? normalized : fallback);
};
const displayAction = (value: string | null | undefined) => actionLabels[value as keyof typeof actionLabels] || "待确认";
const displaySuggestion = (value: string | null | undefined) => actionSuggestionLabels[value as keyof typeof actionSuggestionLabels] || "待确认";
const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const taskIsMonitoring = (task: Task | null | undefined) => Boolean(task && !task.stopLocked && (task.monitoringEnabled === true || (task.monitoringEnabled === undefined && ["STARTING", "MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING", "STOPPING"].includes(task.status))));

function StatusBadge({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  const meta = statusMeta[status] || statusMeta.ERROR;
  const Icon = meta.icon;
  return <span className={`status-badge tone-${meta.tone} ${compact ? "compact" : ""}`}><Icon size={compact ? 12 : 14} />{meta.label}</span>;
}

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function DesktopUpdateControl({ state, busy, onAction }: { state: DesktopUpdateState | null; busy: boolean; onAction: () => void }) {
  if (!state || ["disabled", "unsupported"].includes(state.status)) return null;
  const canInstall = state.status === "downloaded" || state.status === "installing" || Boolean(state.downloadedVersion);
  const actionLabel = state.status === "installing"
    ? "正在重启安装"
    : canInstall
      ? "重启并安装"
      : state.status === "available"
        ? "下载更新"
        : state.status === "downloading"
          ? `下载 ${state.progress}%`
          : state.status === "checking"
            ? "检查中"
            : state.status === "error"
              ? "重试更新"
              : state.status === "not-available"
                ? "已是最新"
                : "检查更新";
  const disabled = busy || ["checking", "installing"].includes(state.status);
  const title = [`桌面版 v${state.currentVersion}`, canInstall && state.downloadedVersion ? `已下载 v${state.downloadedVersion}` : "", state.error || actionLabel].filter(Boolean).join(" · ");
  return <button type="button" className={`update-control update-${canInstall ? "downloaded" : state.status}`} onClick={onAction} disabled={disabled} title={title}><Download size={14} /><span>{actionLabel}</span></button>;
}

const emptyWorkspace: Workspace = { tasks: [], skills: [], providers: [], events: [], runs: [], connectors: [], orders: [], agentRuns: [], credentials: [] };

function hostnameOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function sameWorkspaceUser(left: WorkspaceUser | null | undefined, right: WorkspaceUser | null | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.id !== right.id || left.username !== right.username || left.displayName !== right.displayName) return false;
  const current = [...(left.assignedTaskIds || [])].sort();
  const nextIds = [...(right.assignedTaskIds || [])].sort();
  return current.length === nextIds.length && current.every((id, index) => id === nextIds[index]);
}

function savedCredentialForTarget(credentials: SavedCredential[] = [], targetType: string, url: string, installPath: string) {
  return credentials.find((item) => {
    if (targetType === "app") return String(item.target?.installPath || "") === String(installPath || "");
    const savedHost = hostnameOf(item.target?.url || "");
    const nextHost = hostnameOf(url);
    return Boolean(savedHost && nextHost && savedHost === nextHost);
  }) || null;
}

function preferredProviderId(providers: Provider[]) {
  return providers.find((item) => item.configured)?.id;
}

function configuredProviders(providers: Provider[]) {
  return providers.filter((item) => item.configured);
}

const DEFAULT_CLOUD_API_URL = "http://47.109.95.143";

function isLoopbackApiUrl(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function serviceEndpointLabel() {
  const raw = getApiBaseUrl() || (window.axiomDesktop ? DEFAULT_CLOUD_API_URL : "http://127.0.0.1:8787");
  try {
    const url = new URL(raw);
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    const host = !url.port || url.port === defaultPort ? url.hostname : `${url.hostname}:${url.port}`;
    const local = isLoopbackApiUrl(raw);
    return { title: local ? "本机服务（不是云端）" : "服务已连接", host: `API · ${host}` };
  } catch {
    return { title: "服务已连接", host: `API · ${raw.replace(/^https?:\/\//, "")}` };
  }
}

function selectedProviderId(task: Task | null, providers: Provider[]) {
  if (task?.providerId && providers.some((item) => item.id === task.providerId)) return task.providerId;
  return preferredProviderId(providers) || "";
}

function WindowControls() {
  const bridge = window.axiomDesktop?.window;
  if (!bridge || window.axiomDesktop?.platform === "darwin") return null;
  return (
    <div className="window-controls">
      <button type="button" className="window-control" aria-label="最小化" onClick={() => bridge.minimize()}><Minus size={12} /></button>
      <button type="button" className="window-control" aria-label="最大化" onClick={() => bridge.maximize()}><Square size={10} /></button>
      <button type="button" className="window-control window-close" aria-label="关闭" onClick={() => bridge.close()}><X size={12} /></button>
    </div>
  );
}

function WindowResizeHandles() {
  const bridge = window.axiomDesktop?.window;
  const resizing = useRef(false);
  useEffect(() => {
    if (!bridge) return;
    const move = () => { if (resizing.current) bridge.resizeMove(); };
    const end = () => { if (!resizing.current) return; resizing.current = false; bridge.endResize(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [bridge]);
  if (!bridge) return null;
  return <>{["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => <div key={edge} className={`window-resize-handle resize-${edge}`} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); resizing.current = true; bridge.startResize(edge); }} />)}</>;
}

function UserLogin({ onSignedIn }: { onSignedIn: (user: WorkspaceUser) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serviceUrl, setServiceUrl] = useState(getApiBaseUrl() || (window.axiomDesktop ? DEFAULT_CLOUD_API_URL : "http://127.0.0.1:8787"));
  const [serviceSettingsOpen, setServiceSettingsOpen] = useState(false);
  const [serviceMessage, setServiceMessage] = useState("");
  const [serviceBusy, setServiceBusy] = useState(false);

  async function saveServiceUrl() {
    setServiceBusy(true);
    setServiceMessage("");
    try {
      const normalized = await configureApiBaseUrl(serviceUrl);
      await fetchApiHealth();
      setServiceUrl(normalized);
      setServiceMessage("服务已连接");
      setError("");
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      setServiceMessage(code === "API_URL_INVALID" || code === "API_URL_REQUIRED" ? "服务地址无效" : "无法连接服务，请确认地址和服务状态");
    } finally {
      setServiceBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account.trim() || !password.trim()) {
      setError("请输入桌面账号和密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (window.axiomDesktop) {
        await configureApiBaseUrl(serviceUrl);
        await fetchApiHealth();
      }
      const session = await userLogin(account, password);
      setUserToken(session.token);
      onSignedIn(session.user as WorkspaceUser);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      setError(code === "USER_CREDENTIALS_INVALID" ? "账号或密码不正确，或账号已停用" : "无法连接管理服务，请检查服务地址和服务状态");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <WindowResizeHandles />
      <div className="auth-screen desktop-login">
        <div className="auth-window-drag-region" aria-hidden="true" />
        <div className="auth-window-controls"><WindowControls /></div>
        <section className="auth-panel" aria-labelledby="user-login-title">
          <div className="auth-panel-head">
            <div className="brand-lockup">
              <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
              <div><strong>axiom</strong><small>agent workspace</small></div>
            </div>
            <span className="auth-environment">DESKTOP</span>
          </div>
          <div className="auth-heading">
          <span className="eyebrow"><span className="eyebrow-line" />用户端</span>
          <h1 id="user-login-title">进入任务工作台</h1>
          <p>使用管理后台分配的账号登录。实盘出现买卖建议时会弹窗，你确认后才会下单。</p>
          </div>
          <div className="auth-safety">
            <ShieldCheck size={17} />
            <div className="auth-safety-copy"><strong>确认后下单</strong><span>分析过程不会自动成交。实盘任务弹出确认窗口，点确认后才会在已登录页面提交订单。</span></div>
            <code>CONFIRM</code>
          </div>
          {window.axiomDesktop && <div className="auth-service-settings">
            <div className="auth-service-summary"><span><ServerCog size={14} />服务地址</span><code>{serviceUrl}</code><button type="button" className="text-button" onClick={() => setServiceSettingsOpen((current) => !current)}>{serviceSettingsOpen ? "收起" : "设置"}</button></div>
            {serviceSettingsOpen && <div className="auth-service-editor"><input value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} inputMode="url" aria-label="服务地址" placeholder={DEFAULT_CLOUD_API_URL} /><button type="button" className="button button-small button-secondary" onClick={saveServiceUrl} disabled={serviceBusy}><RefreshCw size={13} />{serviceBusy ? "检查中" : "连接测试"}</button>{serviceMessage && <span className={serviceMessage === "服务已连接" ? "service-ok" : "service-error"}>{serviceMessage}</span>}</div>}
            {isLoopbackApiUrl(serviceUrl) && <div className="login-error auth-error"><AlertTriangle size={14} />当前是本机地址。云端 MySQL 里的 AI Provider 不会出现，请改成生产服务地址后再登录。</div>}
          </div>}
          <form onSubmit={submit} className="auth-form">
            <label className="auth-field"><span>账号</span><span className="auth-input-shell"><UserRound size={16} /><input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" autoFocus placeholder="输入桌面账号" /></span></label>
            <label className="auth-field"><span>密码</span><span className="auth-input-shell"><KeyRound size={16} /><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="输入登录密码" /></span></label>
            {error && <div className="login-error auth-error"><AlertTriangle size={14} />{error}</div>}
            <button className="button button-primary auth-submit" type="submit" disabled={busy}><LogIn size={15} />{busy ? "验证中" : "登录任务工作台"}</button>
          </form>
          <div className="auth-footer"><LockKeyhole size={14} /><span>账号由管理后台分配。Provider 密钥加密后写入服务端数据库。</span></div>
        </section>
      </div>
    </>
  );
}
function App() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [view, setView] = useState<ViewKey>("console");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyLock = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<"task" | "skill" | "provider" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [agentLines, setAgentLines] = useState<AgentOutputLine[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const task = workspace.tasks[0] || null;
  const isRunning = taskIsMonitoring(task);

  useEffect(() => {
    let active = true;
    const existing = getUserToken();
    if (!existing) {
      setAuthChecked(true);
      return;
    }
    userSession()
      .then((session) => {
        if (!active) return;
        setUserToken(existing);
        setUser(session.user);
      })
      .catch(() => { clearUserToken(); if (active) setUser(null); })
      .finally(() => { if (active) setAuthChecked(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const ai = window.axiomDesktop?.ai;
    if (!ai) return;
    if (!user) {
      ai.disconnect().catch(() => {});
      return;
    }
    const userToken = getUserToken();
    if (!userToken) return;
    ai.connect({ apiBaseUrl: getApiBaseUrl(), userToken }).catch(() => {});
    return () => { ai.disconnect().catch(() => {}); };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    fetchWorkspace()
      .then((next) => {
        if (!active) return;
        setWorkspace(next);
        const nextUser = next.auth?.user;
        if (nextUser) setUser((current) => (sameWorkspaceUser(current, nextUser) ? current : nextUser));
        setLoadError(null);
      })
      .catch((error) => { if (active) setLoadError(error instanceof Error ? error.message : "工作区加载失败"); });
    const timer = window.setInterval(() => {
      fetchWorkspace().then((next) => {
        if (!active) return;
        setWorkspace(next);
        const nextUser = next.auth?.user;
        if (nextUser) setUser((current) => (sameWorkspaceUser(current, nextUser) ? current : nextUser));
        setLoadError(null);
      }).catch((error) => { if (active) setLoadError(error instanceof Error ? error.message : "工作区同步失败"); });
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [user?.id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const bridge = window.axiomDesktop?.updates;
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onState((next) => { if (active) setUpdateState(next); });
    bridge.getState().then((next) => { if (active) setUpdateState(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!streamOpen || !task) return;
    let closed = false;
    fetchAgentOutput(task.id).then((result) => {
      if (closed) return;
      setAgentRuns(result.runs);
      setAgentLines(result.output);
    }).catch((error) => { if (!closed) setLoadError(error instanceof Error ? error.message : "Agent 输出加载失败"); });
    const source = new EventSource(agentStreamUrl(task.id));
    source.addEventListener("snapshot", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { runs?: AgentRun[]; output?: AgentOutputLine[] };
      setAgentRuns(payload.runs || []);
      setAgentLines(payload.output || []);
    });
    source.addEventListener("agent.output", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as AgentOutputLine;
      setAgentLines((current) => current.some((item) => item.id === line.id) ? current : [...current, line]);
    });
    source.addEventListener("agent.run.completed", (event) => {
      const run = JSON.parse((event as MessageEvent).data) as AgentRun;
      setAgentRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    });
    return () => { closed = true; source.close(); };
  }, [streamOpen, task?.id]);

  const notify = (message: string) => setToast(message);
  const replaceTask = (nextTask: Task) => setWorkspace((current) => ({ ...current, tasks: current.tasks.some((item) => item.id === nextTask.id) ? current.tasks.map((item) => item.id === nextTask.id ? nextTask : item) : [nextTask, ...current.tasks] }));

  async function withBusy(name: string, work: () => Promise<void>) {
    if (busyLock.current) return;
    busyLock.current = true;
    setBusyAction(name);
    try {
      await work();
    } finally {
      busyLock.current = false;
      setBusyAction(null);
    }
  }

  async function handleLogout() {
    await userLogout().catch(() => {});
    clearUserToken();
    setUser(null);
    setWorkspace(emptyWorkspace);
  }

  async function handleUpdateAction() {
    const bridge = window.axiomDesktop?.updates;
    if (!bridge || !updateState) return;
    setUpdateBusy(true);
    try {
      const canInstall = updateState.status === "downloaded" || Boolean(updateState.downloadedVersion);
      const next = canInstall
        ? await bridge.install()
        : updateState.status === "available" || updateState.status === "downloading"
          ? await bridge.download()
          : await bridge.check();
      setUpdateState(next);
      if (next.status === "installing") notify("正在打开安装包并退出应用");
      else if (next.status === "error" && !next.downloadedVersion) notify(`更新失败：${next.error || "请稍后重试"}`);
      else if (next.error && canInstall) notify(`安装未完成：${next.error}。可再点一次「重启并安装」`);
    } catch (error) {
      notify(`更新失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setUpdateBusy(false); }
  }

  async function handleStart() {
    if (!task) return;
    setBusyAction("start");
    try {
      const next = await startTask(task.id);
      replaceTask(next);
      notify(next.status === "MONITORING" ? "启动检查通过，Agent 已进入持续观察；出现建议时会弹窗确认" : "启动未通过，自动动作保持锁定");
    } catch (error) {
      notify(`启动失败：${error instanceof Error ? error.message : "请检查任务配置"}`);
    } finally { setBusyAction(null); }
  }

  async function handleStop() {
    if (!task) return;
    setBusyAction("stop");
    try {
      const next = await stopTask(task.id);
      replaceTask(next);
      notify("已停止自动控制，任务进入人工接管");
    } catch (error) {
      notify(`停止失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleManual() {
    if (!task) return;
    setBusyAction("manual");
    try {
      const next = await claimManual(task.id);
      replaceTask(next);
      notify("人工接管已确认，Agent 不会自动买卖");
    } catch (error) {
      notify(`接管失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleAutoJudge() {
    if (!task) return;
    setBusyAction("judge");
    try {
      const next = await autoJudge(task.id);
      replaceTask(next);
      notify("规则已确认，结果写入审计链");
    } catch (error) {
      notify(`确认失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleSelectProvider(providerId: string) {
    if (!task || !providerId) return;
    setBusyAction("provider");
    try {
      const next = await setTaskProvider(task.id, providerId);
      replaceTask(next);
      const provider = workspace.providers.find((item) => item.id === next.providerId);
      notify(provider ? `已切换到 ${provider.name}（${provider.model}）` : "已切换分析模型");
    } catch (error) {
      notify(`切换模型失败：${error instanceof Error ? error.message : "请选择已配置的 Provider"}`);
    } finally { setBusyAction(null); }
  }

  async function handleSetMode(mode: string) {
    if (!task || !mode || mode === task.mode) return;
    setBusyAction("mode");
    try {
      const next = await setTaskMode(task.id, mode);
      replaceTask(next);
      notify(next.mode === "LIVE" ? "已切换为实盘：出现买卖建议时会弹窗，确认后才会下单" : "已切换为观察模式，确认后也不会提交实盘");
    } catch (error) {
      notify(`切换运行模式失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleAutoDecisionToggle(enabled: boolean) {
    if (!task) return;
    setBusyAction("auto-decision");
    try {
      const next = await setAutoDecision(task.id, enabled, task.autoDecisionCountdownSec || 30);
      replaceTask(next);
      notify(enabled ? `已打开自动决策：${next.autoDecisionCountdownSec || 30} 秒内可接管，超时后自动确认建议（实盘仍需弹窗）` : "已关闭自动决策，买入/卖出建议需弹窗确认");
    } catch (error) {
      notify(`自动决策切换失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleConfirmAction() {
    if (!task) return;
    setBusyAction("confirm");
    try {
      const next = await confirmPendingAction(task.id);
      replaceTask(next);
      notify(next.pendingAction?.message || (next.mode === "LIVE" ? "已确认并提交订单" : "已确认建议"));
    } catch (error) {
      notify(`确认失败：${error instanceof Error ? error.message : "没有待确认建议"}`);
    } finally { setBusyAction(null); }
  }

  async function handleCancelAction() {
    if (!task) return;
    setBusyAction("cancel");
    try {
      const next = await cancelPendingAction(task.id);
      replaceTask(next);
      notify(next.pendingAction?.message || "已取消本次建议，未下单");
    } catch (error) {
      notify(`取消失败：${error instanceof Error ? error.message : "没有待确认建议"}`);
    } finally { setBusyAction(null); }
  }

  async function handleTakeoverAction() {
    if (!task) return;
    setBusyAction("takeover");
    try {
      const next = await takeoverPendingAction(task.id);
      replaceTask(next);
      notify("已人工接管，倒计时自动确认已取消");
    } catch (error) {
      notify(`接管失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setBusyAction(null); }
  }

  async function handleAnalyze() {
    if (!task) return;
    setBusyAction("analyze");
    setStreamOpen(true);
    try {
      const result = await analyzeTask(task.id, selectedProviderId(task, workspace.providers));
      replaceTask(result.task);
      if (result.output) setAgentLines(result.output);
      if (result.run) setAgentRuns((current) => [result.run!, ...current.filter((item) => item.id !== result.run!.id)]);
      const flags = result.task.decision.riskFlags || [];
      if (result.skipped) notify("上一轮分析仍在进行，已跳过本次触发");
      else if (result.route === "SUGGESTION_PENDING") notify(result.task.mode === "LIVE" ? "分析完成：请在弹窗中确认后才会下单" : "分析完成：已给出建议，观察模式不会下单");
      else if (result.task.status === "PAUSED" || result.task.status === "BLOCKED") notify(`分析暂停：${displayLabel(flags[0] || result.route || result.task.status, { ...riskLabels, ...routeLabels, ...statusMetaLabels }, "需要处理")}`);
      else notify(`分析完成：${displaySuggestion(result.task.decision.action)}`);
    } catch (error) {
      notify(`分析失败：${error instanceof Error ? error.message : "请检查目标连接与模型配置"}`);
    } finally { setBusyAction(null); }
  }

  function updateTarget(result: Partial<Task["target"]>) {
    if (!task) return;
    replaceTask({ ...task, target: { ...task.target, ...result } });
  }

  async function handleConnectorTest(payload: Record<string, unknown>) {
    if (!task) return;
    setBusyAction("connector");
    try {
      const result = await testConnector({ ...payload, taskId: task.id });
      const { credentialRef: _credentialRef, ...safeResult } = result;
      const targetType = safeResult.type || (payload.type === "app" ? "app" : "website");
      const targetValue = safeResult.target || String(payload.url || payload.installPath || "");
      updateTarget({ ...safeResult, type: targetType, name: safeResult.name || String(payload.name || task.target.name), url: targetType === "website" ? targetValue : "", installPath: targetType === "app" ? targetValue : "" });
      if (safeResult.loginStatus === "authenticated" && safeResult.ok) notify("目标登录态已确认，可进行只读分析");
      else if (safeResult.loginStatus === "reauth_required") notify("登录未确认，请重新检查账号和密码");
      else if (safeResult.loginStatus === "adapter_review_required") notify("目标已发现，等待适配器审核");
      else if (safeResult.connectionStatus === "readonly_ready") notify("只读适配器已就绪，登录态尚未确认");
      else notify("连接检查未完成，当前不会执行买卖");
    } catch (error) {
      notify(`连接测试未完成：${error instanceof Error ? error.message : "请检查目标配置"}`);
    } finally { setBusyAction(null); }
  }

  async function handleConnectorDiscover(payload: Record<string, unknown>) {
    if (!task) return;
    setBusyAction("discover");
    try {
      const result = await discoverConnector({ ...payload, taskId: task.id });
      const targetChanged = task.target.connectorId !== result.connectorId;
      replaceTask({ ...task, target: { ...task.target, type: result.type === "app" ? "app" : "website", name: result.name, url: result.type === "website" ? result.target : "", installPath: result.type === "app" ? result.target : "", connectorId: result.connectorId, adapterId: result.adapterId, adapterVersion: result.adapterVersion, discoveryStatus: result.discoveryStatus, adapterStatus: result.adapterStatus, connectionStatus: result.reviewStatus === "APPROVED" ? (result.adapterId === "haohan-readonly" ? "readonly_ready" : "disconnected") : "review_required", loginStatus: result.reviewStatus === "APPROVED" ? "credential_required" : "adapter_review_required", executionModes: result.executionModes, ...(targetChanged ? { credentialRef: "", accountLabel: "未配置", credentialStatus: "未配置", browserSessionId: undefined } : {}) } });
      notify(`目标已发现：${result.capabilities.length} 项能力，${result.reviewStatus === "APPROVED" ? "可进入凭据测试" : "等待适配器审核"}`);
    } catch (error) {
      notify(`目标发现失败：${error instanceof Error ? error.message : "请检查地址或安装路径"}`);
    } finally { setBusyAction(null); }
  }

  async function handleSkillSave(payload: Record<string, unknown>) {
    await withBusy("skill-save", async () => {
      try {
        const skill = await saveSkill(payload);
        setWorkspace((current) => ({ ...current, skills: [skill, ...current.skills] }));
        setModal(null);
        setView("skills");
        notify("已建立草稿 Skill，审核前不会影响自动裁决");
      } catch (error) {
        notify(`保存失败：${error instanceof Error ? error.message : "请稍后重试"}`);
        throw error;
      }
    });
  }

  async function handleSkillApprove(skill: Skill) {
    await withBusy(`skill-approve:${skill.id}`, async () => {
      try {
        const next = await approveSkill(skill.id);
        setWorkspace((current) => ({ ...current, skills: current.skills.map((item) => item.id === next.id ? next : item) }));
        notify(`${next.title} 已发布到 RAG 索引`);
      } catch (error) {
        notify(`发布失败：${error instanceof Error ? error.message : "需要管理后台权限"}`);
      }
    });
  }

  async function handleProviderSave(payload: Record<string, unknown>) {
    await withBusy("provider-save", async () => {
      try {
        const provider = await saveProvider(payload);
        setWorkspace((current) => ({ ...current, providers: [...current.providers.filter((item) => item.id !== provider.id), provider] }));
        setModal(null);
        if (task) {
          const next = await setTaskProvider(task.id, provider.id);
          replaceTask(next);
        }
        notify(task ? `${provider.name} 已保存，并设为当前分析模型` : "Provider 已加密保存到你的桌面账号");
      } catch (error) {
        notify(`保存失败：${error instanceof Error ? error.message : "请检查接口地址、模型和密钥"}`);
        throw error;
      }
    });
  }

  async function handleProviderTest(provider: Provider) {
    await withBusy(`provider-test:${provider.id}`, async () => {
      try {
        const next = await testProvider(provider.id);
        setWorkspace((current) => ({ ...current, providers: current.providers.map((item) => item.id === next.id ? next : item) }));
        notify(`${next.name}：${displayLabel(next.status, providerStatusLabels, "待确认")}`);
      } catch (error) {
        notify(`验证失败：${error instanceof Error ? error.message : "请检查接口地址和密钥"}`);
      }
    });
  }

  async function handleProviderDelete(provider: Provider) {
    if (!provider.owned) return;
    await withBusy(`provider-delete:${provider.id}`, async () => {
      try {
        await deleteProvider(provider.id);
        setWorkspace((current) => ({ ...current, providers: current.providers.filter((item) => item.id !== provider.id) }));
        notify(`已删除 ${provider.name}`);
      } catch (error) {
        notify(`删除失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      }
    });
  }

  async function handleTaskCreate(payload: Record<string, unknown>) {
    await withBusy("task-create", async () => {
      try {
        const created = await createTask(payload);
        try {
          const next = await fetchWorkspace();
          setWorkspace(next);
          const nextUser = next.auth?.user;
        if (nextUser) setUser((current) => (sameWorkspaceUser(current, nextUser) ? current : nextUser));
        } catch {
          setWorkspace((current) => ({ ...current, tasks: [created, ...current.tasks] }));
        }
        setModal(null);
        setView("console");
        notify(created.target.credentialStatus === "已托管" ? `任务已创建，登录凭据已保存到当前账号：${created.name}` : `任务已创建：${created.name}`);
      } catch (error) {
        notify(`创建失败：${error instanceof Error ? error.message : "请检查目标地址"}`);
        throw error;
      }
    });
  }

  if (!authChecked) return <><WindowResizeHandles /><div className="auth-screen"><div className="auth-panel auth-loading-panel"><RefreshCw size={18} /><span>正在验证桌面会话</span></div></div></>;
  if (!user) return <UserLogin onSignedIn={setUser} />;

  return (
    <div className={["app-shell", window.axiomDesktop ? "is-desktop" : "", window.axiomDesktop?.platform ? `platform-${window.axiomDesktop.platform}` : ""].filter(Boolean).join(" ")}>
      <WindowResizeHandles />
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><strong>axiom</strong><small>agent workspace</small></div>
        </div>
        <div className="workspace-switcher"><div className="avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</div><div><b>{user.displayName || user.username}</b><span>已分配 {user.assignedTaskIds.length} 个任务</span></div></div>
        <div className="nav-label">工作区</div>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.map(({ key, label, icon: Icon }) => <button key={key} className={view === key ? "nav-item active" : "nav-item"} onClick={() => { setView(key); setSidebarOpen(false); }}><Icon size={17} /><span>{label}</span>{key === "skills" && workspace.skills.some((skill) => skill.status === "REVIEW") && <em>{workspace.skills.filter((skill) => skill.status === "REVIEW").length}</em>}</button>)}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-label">系统</div>
        <button className="nav-item" onClick={() => { setView("connectors"); setSidebarOpen(false); }}><Settings2 size={17} /><span>连接器</span></button>
        <div className="sidebar-bottom">
          {(() => { const endpoint = serviceEndpointLabel(); return <div className="service-card"><span className="online-dot" /><div><b>{endpoint.title}</b><span>{endpoint.host}</span></div></div>; })()}
          <button type="button" className="user-row user-logout" onClick={handleLogout}>
            <div className="avatar avatar-small">{user.username.slice(0, 1).toUpperCase()}</div>
            <div><b>{user.displayName || user.username}</b><span>退出桌面端</span></div>
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <IconButton label="打开导航" onClick={() => setSidebarOpen((value) => !value)}><Menu size={18} /></IconButton>
          <div className="breadcrumbs"><span>Axiom</span><span>/</span><b>{view === "console" ? "任务控制台" : navItems.find((item) => item.key === view)?.label}</b></div>
          <div className="topbar-drag-region" aria-hidden="true" />
          <div className="topbar-actions">
            <button type="button" className="command-button" onClick={() => task && setStreamOpen(true)} disabled={!task}><Terminal size={15} /><span>查看 Agent 输出流</span></button>
            <DesktopUpdateControl state={updateState} busy={updateBusy} onAction={handleUpdateAction} />
            <WindowControls />
          </div>
        </header>

        <div className="content-scroll">
          {loadError && <div className="login-error page-error"><AlertTriangle size={14} />{loadError}</div>}
          {view === "console" && (task ? <ConsoleView task={task} workspace={workspace} isRunning={isRunning} busyAction={busyAction} onStart={handleStart} onStop={handleStop} onManual={handleManual} onAutoJudge={handleAutoJudge} onAnalyze={handleAnalyze} onOpenStream={() => setStreamOpen(true)} onConnectorTest={handleConnectorTest} onToggleAutoDecision={handleAutoDecisionToggle} onSelectProvider={handleSelectProvider} onSetMode={handleSetMode} onConfirmAction={handleConfirmAction} onTakeoverAction={handleTakeoverAction} /> : <EmptyTaskState onCreate={() => setModal("task")} />)}
          {view === "workflows" && (task ? <WorkflowsView task={task} onCreate={() => setModal("task")} onRun={handleStart} onStop={handleStop} busyAction={busyAction} /> : <EmptyTaskState onCreate={() => setModal("task")} />)}
          {view === "skills" && <SkillsView skills={workspace.skills} rag={workspace.rag} onCreate={() => setModal("skill")} onApprove={handleSkillApprove} />}
          {view === "connectors" && <ConnectorsView task={task} providers={workspace.providers} onConnectorTest={handleConnectorTest} onConnectorDiscover={handleConnectorDiscover} onProviderCreate={() => setModal("provider")} onProviderTest={handleProviderTest} onProviderDelete={handleProviderDelete} onSelectProvider={handleSelectProvider} onCreateTask={() => setModal("task")} busyAction={busyAction} />}
          {view === "runs" && <RunsView runs={workspace.runs} agentRuns={workspace.agentRuns || []} orders={workspace.orders || []} />}
        </div>
      </main>

      {streamOpen && task && <AgentOutputDrawer task={task} lines={agentLines} runs={agentRuns} onClose={() => setStreamOpen(false)} />}
      {task?.pendingAction && (task.pendingAction.status === "WAITING" || task.pendingAction.status === "SUBMITTING") && (
        <TradeConfirmModal task={task} pending={task.pendingAction} busyAction={busyAction} onConfirm={handleConfirmAction} onCancel={handleCancelAction} />
      )}
      {modal === "task" && <TaskModal onClose={() => setModal(null)} onCreate={handleTaskCreate} savedCredentials={workspace.credentials || []} />}
      {modal === "skill" && <SkillModal onClose={() => setModal(null)} onSave={handleSkillSave} />}
      {modal === "provider" && <ProviderModal onClose={() => setModal(null)} onSave={handleProviderSave} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function ConsoleView({ task, workspace, isRunning, busyAction, onStart, onStop, onManual, onAutoJudge, onAnalyze, onOpenStream, onConnectorTest, onToggleAutoDecision, onSelectProvider, onSetMode, onConfirmAction, onTakeoverAction }: { task: Task; workspace: Workspace; isRunning: boolean; busyAction: string | null; onStart: () => void; onStop: () => void; onManual: () => void; onAutoJudge: () => void; onAnalyze: () => void; onOpenStream: () => void; onConnectorTest: (payload: Record<string, unknown>) => void; onToggleAutoDecision: (enabled: boolean) => void; onSelectProvider: (providerId: string) => void; onSetMode: (mode: string) => void; onConfirmAction: () => void; onTakeoverAction: () => void }) {
  const pendingReview = task.rules.some((rule) => rule.status === "pending" && rule.mode === "REVIEW");
  const providers = configuredProviders(workspace.providers);
  const currentProviderId = selectedProviderId(task, workspace.providers);
  return <>
    <section className="page-heading console-heading"><div><div className="eyebrow"><span className="eyebrow-line" />实时任务</div><h1>任务工作台</h1><p>{task.name} <span className="heading-separator">·</span> {displayLabel(task.mode, modeLabels, "观察模式")} <span className="heading-separator">·</span> {task.timeframe} 周期</p></div><div className="heading-controls"><div className="last-sync"><span className="online-dot" />{task.market ? `${task.market.source} · ${formatTime(task.market.observedAt)}` : "等待数据采集"}</div><button className="button button-quiet" onClick={onOpenStream}><Terminal size={15} />输出流</button><button className="button button-secondary" onClick={onAnalyze} disabled={busyAction !== null}><BarChart3 size={15} />{busyAction === "analyze" ? "分析中" : "立即分析"}</button>{isRunning ? <button className="button button-danger" onClick={onStop} disabled={busyAction !== null}><Square size={15} />{busyAction === "stop" ? "正在停止" : "停止观察"}</button> : <button className="button button-primary" onClick={onStart} disabled={busyAction !== null}><Play size={15} />{busyAction === "start" ? "检查中" : "开始观察"}</button>}</div></section>
    <section className="status-strip"><div className="status-main"><StatusBadge status={task.status} />{task.monitoringEnabled && <span className="monitoring-intent"><Activity size={13} />持续监测中</span>}<span className="status-copy">{task.monitoringEnabled ? (task.status === "MONITORING" ? "Agent 正在持续读取行情，数据变化后启动新一轮分析" : "本轮出现问题，Agent 将继续重试，不会因单轮失败结束") : task.status === "MANUAL_CONTROL" ? "Agent 已释放控制权，账户由人工操作" : (task.decision.riskFlags || []).includes("REAUTH_REQUIRED") ? "登录态失效，需要重新登录" : "当前任务需要你的注意"}</span></div><div className="status-meta"><label className="provider-switch"><select aria-label="运行模式" value={task.mode} disabled={busyAction !== null} onChange={(event) => onSetMode(event.target.value)}><option value="PAPER">观察 / 建议</option><option value="SHADOW">影子记录</option><option value="LIVE">实盘（确认后下单）</option></select></label><label className="provider-switch"><Bot size={13} /><select aria-label="分析模型" value={currentProviderId} disabled={busyAction !== null || providers.length === 0} onChange={(event) => onSelectProvider(event.target.value)}>{providers.length ? providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>) : <option value="">未配置 Provider</option>}</select></label>{task.mode !== "LIVE" && <label className={`auto-decision-switch ${task.autoDecisionEnabled ? "on" : ""}`}><input type="checkbox" checked={task.autoDecisionEnabled === true} disabled={busyAction !== null} onChange={(event) => onToggleAutoDecision(event.target.checked)} /><span>自动决策 {task.autoDecisionEnabled ? "开" : "关"}</span></label>}<span><LockKeyhole size={13} />{task.mode === "LIVE" ? "下单 确认后" : "下单 已禁止"}</span><span><Clock3 size={13} />下次检查 {task.nextPollAt ? formatTime(task.nextPollAt) : "等待安排"}</span><span><Database size={13} />{workspace.rag?.indexedChunks || 0} 个索引切片</span></div></section>
    <div className="metrics-grid"><MetricCard label="账户权益" value={task.metrics.equity ? formatCurrency(task.metrics.equity) : "--"} detail={task.market?.account?.availableFunds != null ? `可用 ${formatCurrency(Number(task.market.account.availableFunds))}` : "以目标页面为准"} change={task.metrics.equity ? formatPercent(task.metrics.dayPnlPct) : "未采集"} tone="green" icon={<WalletIcon />} /><MetricCard label="今日盈亏" value={task.metrics.equity ? formatCurrency(task.metrics.dayPnl) : "--"} detail="只读" change={displayLabel(task.market?.trend, trendLabels, "未知")} tone="green" icon={<ArrowUpRight size={16} />} /><MetricCard label="当前敞口" value={`${task.metrics.exposurePct}%`} detail="上限 30%" change="观察" tone="blue" icon={<Gauge size={16} />} /><MetricCard label="风险预算" value={`${task.metrics.riskBudgetPct}%`} detail="剩余可用" change={displayAction(task.decision.action)} tone="amber" icon={<ShieldCheck size={16} />} /></div>
    <div className="console-grid"><MarketPanel task={task} /><DecisionPanel task={task} pendingReview={pendingReview} onAutoJudge={onAutoJudge} onManual={onManual} onConfirmAction={onConfirmAction} onTakeoverAction={onTakeoverAction} busyAction={busyAction} /></div>
    <WorkflowPanel task={task} onConnectorTest={onConnectorTest} busyAction={busyAction} />
    <RulesPanel rules={task.rules} pendingReview={pendingReview} onAutoJudge={onAutoJudge} busyAction={busyAction} />
  </>;
}

function MetricCard({ label, value, detail, change, tone, icon }: { label: string; value: string; detail: string; change: string; tone: string; icon: React.ReactNode }) {
  return <article className="metric-card"><div className={`metric-icon metric-${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong className="tabular">{value}</strong><small>{detail} <b className={`text-${tone}`}>{change}</b></small></div></article>;
}

const timeframeLabels: Record<string, string> = { fs: "分时", "1m": "1 分", "3m": "3 分", "5m": "5 分", "10m": "10 分", "15m": "15 分", "30m": "30 分", "1h": "60 分", "2h": "2 小时", "4h": "4 小时", "1d": "日线", "1w": "周线", "1mo": "月线" };
const marketNumber = (value: number | null | undefined, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--";

function CandleChart({ candles }: { candles: MarketCandle[] }) {
  const complete = candles.filter((candle) => [candle.open, candle.high, candle.low, candle.close].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0));
  const visible = complete.slice(-120);
  if (!visible.length) return <div className="chart-empty">当前周期没有完整 OHLC 数据，保留原始缺失标记</div>;
  const width = 760;
  const height = 250;
  const left = 12;
  const right = 12;
  const top = 12;
  const priceBottom = 182;
  const volumeTop = 198;
  const maxPrice = Math.max(...visible.map((candle) => candle.high as number));
  const minPrice = Math.min(...visible.map((candle) => candle.low as number));
  const range = Math.max(0.000001, maxPrice - minPrice);
  const maxVolume = Math.max(1, ...visible.map((candle) => candle.volume || 0));
  const step = (width - left - right) / visible.length;
  const candleWidth = Math.max(2, Math.min(10, step * 0.62));
  const y = (value: number) => top + ((maxPrice - value) / range) * (priceBottom - top);
  const x = (index: number) => left + step * index + step / 2;
  const first = visible[0];
  const last = visible[visible.length - 1];
  return <div className="market-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="真实历史 K 线图" preserveAspectRatio="none"><line x1={left} y1={priceBottom} x2={width - right} y2={priceBottom} className="chart-grid-line" />{visible.map((candle, index) => { const open = candle.open as number; const close = candle.close as number; const high = candle.high as number; const low = candle.low as number; const rising = close >= open; const bodyTop = y(Math.max(open, close)); const bodyHeight = Math.max(1, Math.abs(y(open) - y(close))); const volumeHeight = ((candle.volume || 0) / maxVolume) * 38; return <g key={`${candle.timestamp}-${index}`} className={rising ? "candle candle-up" : "candle candle-down"}><title>{new Date(candle.timestamp).toLocaleString("zh-CN")} 开 {marketNumber(open)} 高 {marketNumber(high)} 低 {marketNumber(low)} 收 {marketNumber(close)} 量 {marketNumber(candle.volume, 0)}</title><line x1={x(index)} y1={y(high)} x2={x(index)} y2={y(low)} /><rect x={x(index) - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} /><rect className="candle-volume" x={x(index) - candleWidth / 2} y={volumeTop + 38 - volumeHeight} width={candleWidth} height={Math.max(1, volumeHeight)} /></g>; })}</svg><div className="chart-axis"><span>{first ? new Date(first.timestamp).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "--"}</span><span>显示最近 {visible.length} 根</span><span>{last ? new Date(last.timestamp).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "--"}</span></div></div>;
}

function MarketPanel({ task }: { task: Task }) {
  const market = task.market;
  const books = market?.books?.length ? market.books : market ? [market] : [];
  const [selectedSymbol, setSelectedSymbol] = useState(market?.symbol || task.symbol);
  const [selectedTimeframe, setSelectedTimeframe] = useState(task.timeframe);
  useEffect(() => setSelectedSymbol(market?.symbol || task.symbol), [market?.symbol, market?.observedAt]);
  useEffect(() => setSelectedTimeframe(task.timeframe), [task.timeframe]);
  const selectedBook = books.find((book) => book.symbol === selectedSymbol) || books[0] || market;
  const timeframes = selectedBook?.timeframes || market?.timeframes || {};
  const timeframeKeys = Object.keys(timeframes).length ? Object.keys(timeframes) : [task.timeframe];
  const selected: MarketTimeframe | null = timeframes[selectedTimeframe] || timeframes[task.timeframe] || null;
  const candles = selected?.history || selectedBook?.history || market?.history || [];
  const price = selectedBook?.latest?.price ?? market?.latest.price;
  const change = selectedBook?.changePct ?? market?.changePct;
  const indicators = selected?.indicators || selectedBook?.indicators || market?.indicators;
  const indicatorNumber = (key: string) => typeof indicators?.[key as keyof typeof indicators] === "number" ? indicators[key as keyof typeof indicators] as number : null;
  const quality = selected?.dataQuality || selectedBook?.dataQuality || market?.dataQuality || "未知";
  const title = selectedBook?.symbolName || selectedBook?.symbol || task.symbol;
  return <section className="panel market-panel"><div className="panel-header"><div><div className="panel-kicker"><BarChart3 size={14} />市场状态</div><h2>{title}</h2></div><div className="market-header-actions"><span className={`market-quality ${quality === "VERIFIED" ? "quality-ok" : "quality-limited"}`}>{quality === "VERIFIED" ? "数据完整" : "数据受限"}</span><span className="market-meta">{selectedBook?.source || market?.source || "未采集"}</span></div></div><div className="market-quote"><div><strong className="quote-price tabular">{marketNumber(price, 4)}</strong>{change !== null && change !== undefined ? <span className={`quote-change ${change >= 0 ? "positive" : "negative"}`}>{change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {change >= 0 ? "+" : ""}{change.toFixed(2)}%</span> : null}</div><span className="quote-time">{market ? `${market.source} · ${books.length} 个盘 · ${formatTime(market.observedAt)}` : "等待首次只读采集"}</span></div>{books.length > 1 ? <div className="market-timeframe-tabs" role="tablist" aria-label="监测盘口">{books.map((book) => <button type="button" role="tab" aria-selected={selectedBook?.symbol === book.symbol} className={selectedBook?.symbol === book.symbol ? "active" : ""} key={book.symbol || book.symbolName} onClick={() => { setSelectedSymbol(book.symbol); setSelectedTimeframe(book.timeframe || task.timeframe); }}>{book.symbolName || book.symbol}</button>)}</div> : null}<div className="market-timeframe-tabs" role="tablist" aria-label="分析周期">{timeframeKeys.map((key) => <button type="button" role="tab" aria-selected={selectedTimeframe === key} className={selectedTimeframe === key ? "active" : ""} key={key} onClick={() => setSelectedTimeframe(key)}>{timeframes[key]?.label || timeframeLabels[key] || key}</button>)}</div><CandleChart candles={candles} /><div className="chart-summary"><span>{selected?.historyCount || selectedBook?.historyCount || market?.historyCount || 0} 根 {selected?.label || timeframeLabels[selectedTimeframe] || selectedTimeframe} K 线</span><span>完整 OHLC {selected?.completeHistoryCount || selectedBook?.completeHistoryCount || market?.completeHistoryCount || 0}</span><span>分时 {selectedBook?.ticks?.length || market?.ticks.length || 0} 条</span><span>趋势 {displayLabel(selected?.trend || selectedBook?.trend || market?.trend, trendLabels, "未知")}</span></div><div className="indicator-row"><Indicator label="EMA 20" value={marketNumber(indicatorNumber("ema20"))} tone="blue" /><Indicator label="RSI 14" value={marketNumber(indicatorNumber("rsi14"), 1)} tone="amber" /><Indicator label="ATR" value={marketNumber(indicatorNumber("atr14"))} tone="muted" /><Indicator label="量能比" value={indicatorNumber("volumeRatio") === null ? "--" : `${marketNumber(indicatorNumber("volumeRatio"), 2)}x`} tone="green" /></div></section>;
}

function Indicator({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="indicator"><span><i className={`indicator-dot ${tone}`} />{label}</span><b className="tabular">{value}</b></div>; }

function remainingSeconds(deadlineAt?: string | null) {
  if (!deadlineAt) return 0;
  const value = Math.ceil((new Date(deadlineAt).getTime() - Date.now()) / 1000);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function PendingActionCard({ pending }: { pending: PendingAction }) {
  const [remain, setRemain] = useState(() => remainingSeconds(pending.deadlineAt));
  useEffect(() => {
    setRemain(remainingSeconds(pending.deadlineAt));
    if (pending.status !== "WAITING" || !pending.deadlineAt) return;
    const timer = window.setInterval(() => setRemain(remainingSeconds(pending.deadlineAt)), 250);
    return () => window.clearInterval(timer);
  }, [pending.id, pending.status, pending.deadlineAt]);
  const waiting = pending.status === "WAITING";
  const actionText = pending.action === "BUY" ? "买入" : "卖出";
  return (
    <div className={`pending-action-card ${waiting ? "waiting" : ""}`}>
      <div className="pending-action-head">
        <strong>{waiting ? `${actionText}建议待确认` : pending.message}</strong>
        {waiting && pending.deadlineAt ? <span className="countdown-display tabular">{remain}s</span> : null}
      </div>
      <p>{pending.message}</p>
      <div className="pending-action-meta">
        <span>建议价 {pending.suggestedPrice ?? "--"}</span>
        <span>建议量 {pending.suggestedQty ?? "--"}</span>
        <span>{pending.formFilled ? "表单已填写" : "表单未填写"}</span>
      </div>
      {waiting ? <p className="pending-action-hint">确认窗口已弹出，确认后才会下单。</p> : null}
    </div>
  );
}

function DecisionPanel({ task, pendingReview, onAutoJudge, onManual, onConfirmAction, onTakeoverAction, busyAction }: { task: Task; pendingReview: boolean; onAutoJudge: () => void; onManual: () => void; onConfirmAction: () => void; onTakeoverAction: () => void; busyAction: string | null }) {
  const decision = task.decision;
  const analyzed = !decision.riskFlags.includes("NOT_ANALYZED");
  const actionText = analyzed ? displaySuggestion(decision.action) : "尚未分析";
  const pending = task.pendingAction;
  return (
    <section className="panel decision-panel">
      <div className="panel-header">
        <div><div className="panel-kicker"><Bot size={14} />Agent 判断</div><h2>当前建议</h2></div>
        <span className="decision-age"><span className="online-dot" />{analyzed ? `有效期 ${decision.ttlSec} 秒` : "未分析"}</span>
      </div>
      <div className={`decision-action action-${decision.action.toLowerCase()}`}>
        <div className="decision-symbol">{decision.action === "BUY" ? <ArrowUpRight size={24} /> : decision.action === "SELL" ? <ArrowDownRight size={24} /> : <Pause size={22} />}</div>
        <div><strong>{actionText}</strong><span>{analyzed ? `结构化意图 · ${Math.round(decision.confidence * 100)}% 置信度` : "点击「立即分析」读取目标并给出建议"}</span></div>
        <span className="decision-time">{analyzed ? formatTime(decision.createdAt) : "--"}</span>
      </div>
      <div className="confidence-bar"><div style={{ width: `${decision.confidence * 100}%` }} /><span>置信度 <b>{Math.round(decision.confidence * 100)}%</b></span></div>
      <div className="decision-stats"><div><span>目标仓位</span><b className="tabular">{decision.targetPositionPct}%</b></div><div><span>单笔上限</span><b className="tabular">{decision.maxOrderValuePct}%</b></div><div><span>证据</span><b className="tabular">{decision.evidenceIds.length} 条</b></div></div>
      <div className="reason-block">
        <span className="block-label">机器可验证依据</span>
        {decision.reasonCodes.length ? decision.reasonCodes.map((code) => <div className="reason-row" key={code}><CheckCircle2 size={14} /><span>{displayLabel(code, reasonLabels, "其他分析依据")}</span></div>) : <div className="reason-row"><CircleDashed size={14} /><span>还没有可引用的理由码</span></div>}
      </div>
      <div className="invalidation"><AlertTriangle size={14} /><span>失效条件：{decision.invalidation || "数据过期或风险超限时失效"}</span></div>
      {pending ? <PendingActionCard pending={pending} /> : pendingReview ? <div className="decision-actions"><button className="button button-primary button-full" onClick={onAutoJudge} disabled={busyAction !== null}><Check size={15} />{busyAction === "judge" ? "记录中" : "确认规则并继续"}</button><button className="button button-quiet button-full" onClick={onManual} disabled={busyAction !== null}><Hand size={15} />转人工处理</button></div> : <div className="decision-safe"><ShieldCheck size={14} /><span>{task.mode === "LIVE" ? "出现买卖建议时会弹窗确认，确认后才会下单" : "观察模式只记录建议，确认后也不会提交实盘"}</span></div>}
    </section>
  );
}

function WorkflowPanel({ task, onConnectorTest, busyAction }: { task: Task; onConnectorTest: (payload: Record<string, unknown>) => void; busyAction: string | null }) {
  return <section className="panel workflow-panel"><div className="panel-header"><div><div className="panel-kicker"><Workflow size={14} />工作流进度</div><h2>从连接到动作</h2></div><button className="text-button" onClick={() => onConnectorTest({ taskId: task.id, connectorId: task.target.connectorId, type: task.target.type, name: task.target.name, url: task.target.url, appId: task.target.appId, installPath: task.target.installPath })} disabled={busyAction !== null || !task.target.connectorId}><RefreshCw size={14} />重新测试连接</button></div><div className="workflow-rail">{task.workflow.map((step, index) => <div className={`workflow-step ${step.status}`} key={step.key}><div className="workflow-node">{step.status === "complete" ? <Check size={14} /> : step.status === "active" ? <span className="node-pulse" /> : <span>{index + 1}</span>}</div><div className="workflow-copy"><strong>{step.label}</strong><span>{step.detail}</span></div>{index < task.workflow.length - 1 && <div className={`workflow-connector ${step.status === "complete" ? "complete" : ""}`} />}</div>)}</div></section>;
}

function RulesPanel({ rules, pendingReview, onAutoJudge, busyAction }: { rules: Rule[]; pendingReview: boolean; onAutoJudge: () => void; busyAction: string | null }) {
  return <section className="panel rules-panel"><div className="panel-header"><div><div className="panel-kicker"><ListChecks size={14} />规则裁决</div><h2>执行前检查</h2></div><span className="count-badge">{rules.filter((rule) => rule.status === "passed").length}/{rules.length} 已通过</span></div><div className="rule-list">{rules.map((rule) => <div className="rule-row" key={rule.id}><span className={`rule-order rule-${rule.mode.toLowerCase()}`}>{String(rule.order).padStart(2, "0")}</span><div className="rule-copy"><strong>{rule.name}</strong><span>{rule.detail}</span></div><span className={`rule-mode mode-${rule.mode.toLowerCase()}`}>{rule.mode === "AUTO" ? "自动" : rule.mode === "REVIEW" ? "人工" : "红线"}</span><span className={`rule-status status-${rule.status}`}>{rule.status === "passed" ? <CheckCircle2 size={15} /> : rule.status === "pending" ? <CirclePause size={15} /> : <CircleDashed size={15} />}</span></div>)}</div>{pendingReview && <div className="review-callout"><div><AlertTriangle size={16} /><span>规则 3 需要人工判断，当前动作已暂停</span></div><button className="button button-small button-primary" onClick={onAutoJudge} disabled={busyAction !== null}><Check size={14} />确认</button></div>}</section>;
}

function WalletIcon() { return <span className="wallet-icon">¥</span>; }

function EmptyTaskState({ onCreate }: { onCreate: () => void }) {
  return <section className="panel empty-task"><div className="panel-kicker"><Workflow size={14} />尚未分配任务</div><h2>先创建或等待管理员分配任务</h2><p>桌面端只会显示当前账号被分配的任务。创建任务后即可连接目标网站、托管凭据，并执行一次只读分析。</p><button type="button" className="button button-primary" onClick={onCreate}><Plus size={16} />新建任务</button></section>;
}

function AgentOutputDrawer({ task, lines, runs, onClose }: { task: Task; lines: AgentOutputLine[]; runs: AgentRun[]; onClose: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const current = runs[0];
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);
  return (
    <div className="agent-drawer-backdrop" role="presentation">
      <aside className="agent-drawer" role="dialog" aria-label="Agent 输出流">
        <div className="panel-header">
          <div>
            <div className="panel-kicker"><Terminal size={14} />工作流输出</div>
            <h2>{task.name}</h2>
          </div>
          <IconButton label="关闭输出流" onClick={onClose}><X size={17} /></IconButton>
        </div>
        <div className="agent-run-meta">
          <span>{current ? `${displayLabel(current.status, runStatusLabels, "待确认")} · ${displayLabel(current.currentStage, stageLabels, "其他阶段")}` : "等待开始"}</span>
          <span>{current?.finalAction ? displaySuggestion(current.finalAction) : displayAction(task.decision.action)}</span>
          <span>{displayLabel(current?.route, routeLabels, "仅输出建议")}</span>
        </div>
        <div className="agent-output-list" ref={listRef}>
          {lines.length ? lines.map((line) => (
            <div className={`agent-line level-${line.level}`} key={line.id}>
              <span className="agent-time tabular">{formatTime(line.createdAt)}</span>
              <span className="agent-stage">{displayLabel(line.stage, stageLabels, "其他阶段")}</span>
              <span className="agent-message">{line.message}</span>
            </div>
          )) : <div className="empty-state"><CircleDashed size={16} />还没有输出。点击「立即分析」开始。</div>}
        </div>
      </aside>
    </div>
  );
}

function WorkflowsView({ task, onCreate, onRun, onStop, busyAction }: { task: Task; onCreate: () => void; onRun: () => void; onStop: () => void; busyAction: string | null }) {
  const isRunning = taskIsMonitoring(task);
  return <>
    <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />任务编排</div><h1>工作流</h1><p>把连接、采集、分析、规则和动作串成可追溯的运行链。</p></div><button className="button button-primary" onClick={onCreate}><Plus size={16} />新建任务</button></section>
    <section className="workflow-overview">
      <div className="workflow-overview-main">
        <div className="panel-kicker"><Workflow size={14} />当前工作流</div>
        <div className="overview-title-row"><h2>{task.name}</h2><StatusBadge status={task.status} />{taskIsMonitoring(task) && <span className="monitoring-intent"><Activity size={13} />后台持续监测</span>}</div>
        <p className="overview-description">{task.target.type === "website" ? "网站连接" : "桌面 App 连接"} · {task.target.name} · {task.symbol} · {task.timeframe} · {displayLabel(task.mode, modeLabels, "观察模式")}</p>
        <div className="large-flow">{task.workflow.map((step, index) => <div className={`large-step ${step.status}`} key={step.key}><div className="large-step-number">{step.status === "complete" ? <Check size={15} /> : index + 1}</div><div><strong>{step.label}</strong><span>{step.detail}</span></div>{index < task.workflow.length - 1 && <div className="large-step-line" />}</div>)}</div>
        <div className="overview-actions"><button className={`button ${isRunning ? "button-danger" : "button-primary"}`} onClick={isRunning ? onStop : onRun} disabled={busyAction !== null}>{isRunning ? <><Square size={15} />{busyAction === "stop" ? "正在停止" : "停止观察"}</> : <><Play size={15} />{busyAction === "start" ? "检查中" : "运行任务"}</>}</button></div>
      </div>
      <aside className="workflow-side"><div className="side-stat"><span>任务状态</span><strong>{statusMeta[task.status]?.label || "待确认"}</strong><small>{task.nextTrigger || "等待启动"}</small></div><div className="side-stat"><span>当前建议</span><strong className="tabular">{task.decision.riskFlags.includes("NOT_ANALYZED") ? "--" : displayAction(task.decision.action)}</strong><small>{task.mode === "LIVE" ? "确认后下单" : "观察模式不下单"}</small></div><div className="side-stat"><span>风险标记</span><strong className="tabular">{task.decision.riskFlags.length}</strong><small>{task.decision.riskFlags[0] ? displayLabel(task.decision.riskFlags[0], riskLabels, "待确认") : "无"}</small></div><div className="side-note"><ShieldCheck size={16} /><div><b>自动执行边界</b><span>{task.mode === "LIVE" ? "分析不会自动下单，必须弹窗确认" : "只给出买卖建议，不提交实盘"}</span></div></div></aside>
    </section>
  </>;
}

function SkillsView({ skills, rag, onCreate, onApprove }: { skills: Skill[]; rag?: Workspace["rag"]; onCreate: () => void; onApprove: (skill: Skill) => void }) {
  const [query, setQuery] = useState("");
  const approved = skills.filter((skill) => skill.status === "APPROVED").length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSkills = normalizedQuery
    ? skills.filter((skill) => [skill.title, skill.summary, skill.source, ...skill.tags].join(" ").toLocaleLowerCase().includes(normalizedQuery))
    : skills;
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />知识与约束</div><h1>经验与 Skills</h1><p>专家经验、规则和红线先审核，再进入 RAG 决策上下文。</p></div><button className="button button-primary" onClick={onCreate}><Upload size={16} />导入经验</button></section><div className="skill-summary"><SummaryTile label="已发布 Skills" value={String(approved)} icon={<BookOpen size={17} />} tone="green" /><SummaryTile label="待审核" value={String(skills.length - approved)} icon={<CirclePause size={17} />} tone="amber" /><SummaryTile label="RAG 切片" value={String(rag?.indexedChunks || 0)} icon={<Database size={17} />} tone="blue" /><SummaryTile label="检索模式" value="本地可替换" icon={<Search size={17} />} tone="muted" /></div><section className="panel skills-panel"><div className="panel-header"><div><div className="panel-kicker"><FileText size={14} />知识库版本</div><h2>初始化 Skills</h2></div><div className="panel-header-tools"><div className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选标题或标签" aria-label="筛选标题或标签" /></div></div></div><div className="skill-table"><div className="table-head"><span>名称</span><span>类型</span><span>来源与标签</span><span>版本</span><span>状态</span></div>{filteredSkills.length ? filteredSkills.map((skill) => <SkillRow key={skill.id} skill={skill} onApprove={onApprove} />) : <div className="empty-state"><CircleDashed size={16} />没有匹配的经验</div>}</div></section></>;
}

function SummaryTile({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone: string }) { return <article className="summary-tile"><span className={`summary-icon ${tone}`}>{icon}</span><div><span>{label}</span><strong className="tabular">{value}</strong></div></article>; }
function SkillRow({ skill, onApprove }: { skill: Skill; onApprove: (skill: Skill) => void }) { const kind = skill.kind === "guardrail" ? "红线" : skill.kind === "rule" ? "规则" : "专家经验"; return <div className="skill-row"><div className="skill-name"><span className={`skill-file ${skill.kind}`}><FileText size={16} /></span><div><strong>{skill.title}</strong><span>{skill.summary}</span></div></div><span className={`kind-label kind-${skill.kind}`}>{kind}</span><div className="skill-source"><span>{skill.source}</span><div className="tag-list">{skill.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}</div></div><span className="version-label tabular">{skill.version}<small>{skill.chunks} 个切片</small></span><div>{skill.status === "APPROVED" ? <span className="approval-label"><CheckCircle2 size={14} />已发布</span> : <button className="button button-small button-review" onClick={() => onApprove(skill)}><ShieldCheck size={13} />审核发布</button>}</div></div>; }

function ConnectorsView({ task, providers, onConnectorTest, onConnectorDiscover, onProviderCreate, onProviderTest, onProviderDelete, onSelectProvider, onCreateTask, busyAction }: { task: Task | null; providers: Provider[]; onConnectorTest: (payload: Record<string, unknown>) => void; onConnectorDiscover: (payload: Record<string, unknown>) => void; onProviderCreate: () => void; onProviderTest: (provider: Provider) => void; onProviderDelete: (provider: Provider) => void; onSelectProvider: (providerId: string) => void; onCreateTask: () => void; busyAction: string | null }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />外部能力</div><h1>连接器</h1><p>每个桌面账号自己添加 Provider 和目标凭据。后台只管账号分配，看不到密钥。</p></div><button className="button button-primary" onClick={onProviderCreate} disabled={busyAction !== null}><Plus size={16} />添加 Provider</button></section><div className="connector-grid">{task ? <TargetConnector task={task} onTest={onConnectorTest} onDiscover={onConnectorDiscover} busyAction={busyAction} /> : <section className="panel target-panel"><div className="panel-header"><div><div className="panel-kicker"><Waypoints size={14} />目标连接</div><h2>网站 / 桌面 App</h2></div></div><div className="empty-state"><CircleDashed size={16} />还没有任务。可先添加 AI Provider，再<button type="button" className="text-button" onClick={onCreateTask}>新建任务</button>连接目标。</div></section>}<section className="panel provider-panel"><div className="panel-header"><div><div className="panel-kicker"><Bot size={14} />模型接入</div><h2>AI Provider</h2></div><span className="secure-label"><LockKeyhole size={13} />服务端托管密钥</span></div><div className="provider-list">{providers.length ? providers.map((provider) => <ProviderRow key={provider.id} provider={provider} selected={Boolean(task) && selectedProviderId(task, providers) === provider.id} onTest={onProviderTest} onDelete={onProviderDelete} onSelect={onSelectProvider} canSelect={Boolean(task)} busy={busyAction !== null} testing={busyAction === `provider-test:${provider.id}`} />) : <div className="empty-state"><CircleDashed size={16} />还没有 Provider。点右上角「添加 Provider」写入自己的接口。</div>}</div><div className="provider-note"><ShieldCheck size={15} /><span>点「添加 Provider」写入你自己的 Endpoint 和密钥。只对当前桌面账号可见，保存在服务端数据库。{task ? "保存后可点「使用」作为本任务分析模型。" : "有任务后可点「使用」绑定分析模型。"}</span></div></section></div>{task && <section className="panel permissions-panel"><div className="panel-header"><div><div className="panel-kicker"><KeyRound size={14} />权限边界</div><h2>当前任务授权</h2></div><span className="mode-chip">{task.mode === "LIVE" ? "实盘确认后下单" : task.mode === "SHADOW" ? "影子记录" : "观察 / 建议"}</span></div><div className="permission-grid"><PermissionItem icon={<EyeIcon />} label="读取行情与历史数据" status="允许" tone="green" /><PermissionItem icon={<UserRound size={16} />} label="读取账户与持仓" status="允许" tone="green" /><PermissionItem icon={<ListChecks size={16} />} label="提出交易计划" status="受控" tone="amber" /><PermissionItem icon={<LockKeyhole size={16} />} label="提交订单" status={task.mode === "LIVE" ? "确认后允许" : "禁止"} tone={task.mode === "LIVE" ? "amber" : "red"} /><PermissionItem icon={<LockKeyhole size={16} />} label="修改风控与资金" status="禁止" tone="red" /></div></section>}</>;
}

function TargetConnector({ task, onTest, onDiscover, busyAction }: { task: Task; onTest: (payload: Record<string, unknown>) => void; onDiscover: (payload: Record<string, unknown>) => void; busyAction: string | null }) {
  const [type, setType] = useState<"website" | "app">(task.target.type);
  const [name, setName] = useState(task.target.name);
  const [url, setUrl] = useState(task.target.url || "");
  const [appId, setAppId] = useState(task.target.appId || "");
  const [installPath, setInstallPath] = useState(task.target.installPath || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const hosted = task.target.credentialStatus === "已托管";
  function submit(event: FormEvent) {
    event.preventDefault();
    const payload: Record<string, unknown> = { taskId: task.id, connectorId: task.target.connectorId, type, name, url, appId, installPath };
    if (password) {
      payload.username = username;
      payload.password = password;
    } else if (!hosted && username) {
      payload.username = username;
    }
    onTest(payload);
    setPassword("");
  }
  const connectionReady = ["connected", "readonly_ready", "browser_ready"].includes(task.target.connectionStatus);
  const connectionLabel = displayLabel(task.target.connectionStatus, connectionLabels, "待确认");
  return <section className="panel target-panel"><div className="panel-header"><div><div className="panel-kicker"><Waypoints size={14} />目标连接</div><h2>网站 / 桌面 App</h2></div><span className={`connection-state ${connectionReady ? "connected" : ""}`}><span />{connectionLabel}</span></div><div className="segmented-control"><button type="button" className={type === "website" ? "selected" : ""} onClick={() => setType("website")}><Globe2 size={14} />网站</button><button type="button" className={type === "app" ? "selected" : ""} onClick={() => setType("app")}><Laptop size={14} />桌面 App</button></div><form className="connector-form" onSubmit={submit}><label>目标名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>{type === "website" ? <label>网站地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" type="url" /></label> : <><label>安装路径<input value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="/Applications/App.app 或 C:\\Program Files\\App" /></label><label>应用标识<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="应用名称或 Bundle ID（可选）" /></label></>}<div className="target-discovery"><div><span className={`discovery-dot ${task.target.discoveryStatus === "已发现" ? "ready" : ""}`} /><div><b>{task.target.discoveryStatus || "未发现"}</b><small>{task.target.adapterStatus || "输入目标后自动发现连接器"}</small></div></div><button type="button" className="button button-small button-quiet" onClick={() => onDiscover({ taskId: task.id, type, name, url, installPath, appId })} disabled={busyAction !== null || (type === "website" ? !url : !installPath && !appId)}>{busyAction === "discover" ? "发现中" : "自动发现"}</button></div><label>登录账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder={hosted ? `已托管 ${task.target.accountLabel}，留空复用` : "当前账号的目标登录名"} /></label><label>登录密码<input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" type="password" placeholder={hosted ? "已托管，留空以复用当前账号凭据" : "写入当前账号的加密托管"} /></label><div className="credential-note"><LockKeyhole size={14} /><span>凭据绑定当前登录用户。同一网站下次创建任务或重新登录会自动复用，其他账号看不到。</span></div><button className="button button-secondary button-full" type="submit" disabled={busyAction !== null}><RefreshCw size={15} />{busyAction === "connector" ? "测试中" : "测试登录与连接"}</button></form></section>;
}

function ProviderRow({ provider, selected, onTest, onDelete, onSelect, canSelect, busy, testing }: { provider: Provider; selected: boolean; onTest: (provider: Provider) => void; onDelete: (provider: Provider) => void; onSelect: (providerId: string) => void; canSelect: boolean; busy: boolean; testing: boolean }) { const status = displayLabel(provider.status, providerStatusLabels, provider.configured ? "已配置" : "未配置"); return <div className={`provider-row ${selected ? "selected" : ""}`}><span className="provider-logo">{provider.name.slice(0, 1)}</span><div className="provider-copy"><strong>{provider.name}</strong><span>{provider.model} <i>·</i> {provider.baseUrl || "未设置接口地址"}</span></div><span className={`provider-status ${provider.configured ? "configured" : ""}`}><span />{status}</span><span className="key-preview"><KeyRound size={13} />{provider.keyPreview || "未配置密钥"}</span><div className="provider-actions"><button type="button" className={`button button-small ${selected ? "button-primary" : "button-quiet"}`} disabled={busy || !provider.configured || !canSelect} onClick={() => onSelect(provider.id)}>{selected ? "使用中" : "使用"}</button><button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => onTest(provider)}><RefreshCw size={13} />{testing ? "验证中" : "验证"}</button>{provider.owned ? <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => onDelete(provider)}><Trash2 size={13} />删除</button> : null}</div></div>; }
function PermissionItem({ icon, label, status, tone }: { icon: React.ReactNode; label: string; status: string; tone: string }) { return <div className="permission-item"><span className={`permission-icon ${tone}`}>{icon}</span><span>{label}</span><b className={`text-${tone}`}>{status}</b></div>; }
function EyeIcon() { return <Eye size={16} />; }

function RunsView({ runs, agentRuns, orders = [] }: { runs: Workspace["runs"]; agentRuns: AgentRun[]; orders?: Workspace["orders"] }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />可观测性</div><h1>运行记录</h1><p>每一轮分析、规则裁决和建议结果均可回放。</p></div></section><div className="run-summary"><SummaryTile label="Agent 运行" value={String(agentRuns.length)} icon={<Activity size={17} />} tone="green" /><SummaryTile label="总决策" value={runs.reduce((sum, run) => sum + run.decisions, 0).toString()} icon={<Bot size={17} />} tone="blue" /><SummaryTile label="交易订单" value={String(orders?.length || 0)} icon={<BarChart3 size={17} />} tone="muted" /><SummaryTile label="规则拦截" value={runs.reduce((sum, run) => sum + run.blocked, 0).toString()} icon={<ShieldCheck size={17} />} tone="amber" /></div><section className="panel runs-panel"><div className="panel-header"><div><div className="panel-kicker"><History size={14} />任务运行</div><h2>运行实例</h2></div></div><div className="run-table"><div className="table-head"><span>运行 ID</span><span>阶段</span><span>开始时间</span><span>建议</span><span>路由</span><span>状态</span></div>{agentRuns.length ? agentRuns.map((run) => <div className="run-row" key={run.id}><span className="run-id tabular">{run.id}</span><span>{displayLabel(run.currentStage, stageLabels, "其他阶段")}</span><span className="tabular">{formatTime(run.startedAt)}</span><span className="tabular">{run.finalAction ? displaySuggestion(run.finalAction) : "--"}</span><span className="tabular">{displayLabel(run.route, routeLabels, "仅输出建议")}</span><span className="approval-label">{displayLabel(run.status, runStatusLabels, "待确认")}</span></div>) : <div className="empty-state"><CircleDashed size={16} />还没有分析运行</div>}</div></section></>;
}

function TaskModal({ onClose, onCreate, savedCredentials = [] }: { onClose: () => void; onCreate: (payload: Record<string, unknown>) => Promise<void>; savedCredentials?: SavedCredential[] }) {
  const [name, setName] = useState("浩瀚数贸观察任务");
  const [targetType, setTargetType] = useState("website");
  const [targetName, setTargetName] = useState("浩瀚数贸");
  const [url, setUrl] = useState("https://smyw.haohandahan.cn/client/#/transcc");
  const [installPath, setInstallPath] = useState("");
  const [appId, setAppId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [symbol, setSymbol] = useState("DGJJ");
  const [timeframe, setTimeframe] = useState("15m");
  const [mode, setMode] = useState("LIVE");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const saved = savedCredentialForTarget(savedCredentials, targetType, url, installPath);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (!saved && (!username.trim() || !password)) return;
    lock.current = true;
    setBusy(true);
    try {
      await onCreate({ name, targetType, targetName, url, installPath, appId, username, password, symbol, timeframe, mode });
    } catch {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <ModalShell title="创建任务" subtitle="登录账号和 Provider 都保存在当前桌面用户下。同一账号再次登录会自动带出，其他用户互相隔离。" onClose={busy ? () => {} : onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>任务名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <div className="form-row">
          <label>目标类型<select value={targetType} onChange={(event) => setTargetType(event.target.value)}><option value="website">网站</option><option value="app">桌面 App</option></select></label>
          <label>运行模式<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="PAPER">观察 / 建议</option><option value="SHADOW">影子记录</option><option value="LIVE">实盘（弹窗确认后下单）</option></select></label>
        </div>
        <label>目标名称<input value={targetName} onChange={(event) => setTargetName(event.target.value)} /></label>
        {targetType === "website"
          ? <label>网站地址<input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://" /></label>
          : <><label>App 安装路径<input value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="/Applications/App.app 或 C:\\Program Files\\App" /></label><label>应用标识<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="应用名称或 Bundle ID（可选）" /></label></>}
        <div className="form-row">
          <label>交易品种<input value={symbol} onChange={(event) => setSymbol(event.target.value)} /></label>
          <label>分析周期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}><option value="15m">15 分钟</option><option value="1m">1 分钟</option><option value="1h">1 小时</option><option value="4h">4 小时</option></select></label>
        </div>
        <label>登录账号<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={saved ? `已保存 ${saved.accountLabel}，留空则复用` : "目标网站登录名"} autoComplete="username" required={!saved} /></label>
        <label>登录密码<input value={password} onChange={(event) => setPassword(event.target.value)} placeholder={saved ? "已保存到当前账号，留空则复用" : "加密保存到当前登录用户"} autoComplete="new-password" type="password" required={!saved} /></label>
        <div className="modal-footnote"><LockKeyhole size={14} />{saved ? "当前账号已有该网站凭据，密码留空会自动复用。Provider 也会按当前用户带出。" : "账号密码绑定当前登录用户，写入服务端加密托管。下次登录同一账号不用再填。"}</div>
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="button button-primary" disabled={busy}><Plus size={15} />{busy ? "创建中" : "创建任务"}</button>
        </div>
      </form>
    </ModalShell>
  );
}

function SkillModal({ onClose, onSave }: { onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) { const [title, setTitle] = useState(""); const [kind, setKind] = useState("expert"); const [tags, setTags] = useState("BTC/USDT,15m"); const [content, setContent] = useState(""); const [filename, setFilename] = useState("手动输入"); const [busy, setBusy] = useState(false); const lock = useRef(false); function chooseFile(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setFilename(file.name); file.text().then(setContent); if (!title) setTitle(file.name.replace(/\.[^.]+$/, "")); } async function submit(event: FormEvent) { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); try { await onSave({ title: title || filename, kind, tags, content, filename }); } catch { lock.current = false; setBusy(false); } } return <ModalShell title="导入专家经验" subtitle="文件或文本会保存为待审核草稿，不会立即影响决策。" onClose={busy ? () => {} : onClose}><form className="modal-form" onSubmit={submit}><div className="upload-drop"><Upload size={20} /><div><strong>拖入 Markdown / TXT</strong><span>或点击选择本地文件</span></div><input type="file" accept=".md,.txt,.markdown,.json" onChange={chooseFile} aria-label="选择经验文件" /></div><label>Skill 标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：趋势突破与回撤红线" /></label><div className="form-row"><label>知识类型<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="expert">专家经验</option><option value="rule">规则</option><option value="redline">红线</option></select></label><label>适用标签<input value={tags} onChange={(event) => setTags(event.target.value)} /></label></div><label>内容<textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="输入触发条件、建议动作、禁止动作、失效条件和证据来源..." rows={7} /></label><div className="modal-footnote"><ShieldCheck size={14} />审核发布后才会切片并进入 RAG 检索。</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy || !content.trim()}><FileText size={15} />{busy ? "保存中" : "保存草稿"}</button></div></form></ModalShell>; }

function ProviderModal({ onClose, onSave }: { onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState("auto");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await onSave({ name: name.trim() || "我的 Provider", baseUrl, model, apiKey, apiFormat: apiFormat === "auto" ? undefined : apiFormat });
    } catch {
      lock.current = false;
      setBusy(false);
    }
  }
  return <ModalShell title="添加自己的 AI Provider" subtitle="每个桌面账号独立保存。密钥加密进数据库，后台管理员看不到明文。" onClose={busy ? () => {} : onClose}><form className="modal-form" onSubmit={submit}><label>名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="例如：自建网关" disabled={busy} /></label><label>接口地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" type="url" required disabled={busy} /></label><div className="form-row"><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="your-model" required disabled={busy} /></label><label>协议<select value={apiFormat} onChange={(event) => setApiFormat(event.target.value)} disabled={busy}><option value="auto">自动识别</option><option value="openai_responses">OpenAI Responses</option><option value="openai_chat">Chat Completions</option></select></label></div><label>API Key<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="只保存在服务端" type="password" autoComplete="new-password" required disabled={busy} /></label><div className="modal-footnote"><LockKeyhole size={14} />根地址（无路径或 /）走 Responses；带 /v1 的地址走 Chat Completions。也可在协议里手动指定。</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy}><KeyRound size={15} />{busy ? "保存中" : "保存到我的账号"}</button></div></form></ModalShell>;
}

function TradeConfirmModal({ task, pending, busyAction, onConfirm, onCancel }: { task: Task; pending: PendingAction; busyAction: string | null; onConfirm: () => void; onCancel: () => void }) {
  const live = task.mode === "LIVE";
  const actionText = pending.action === "BUY" ? "买入" : "卖出";
  const submitting = pending.status === "SUBMITTING" || busyAction === "confirm";
  return (
    <div className="modal-backdrop trade-confirm-backdrop" role="presentation">
      <section className="modal-shell trade-confirm-shell" role="alertdialog" aria-modal="true" aria-labelledby="trade-confirm-title">
        <div className="modal-header">
          <div>
            <h2 id="trade-confirm-title">确认{actionText}建议</h2>
            <p>{live ? "确认后将在已登录的目标页面提交订单，分析过程不会自动下单。" : "观察模式只确认这条建议，不会提交实盘订单。"}</p>
          </div>
        </div>
        <div className="trade-confirm-facts">
          <div><span>品种</span><b>{task.market?.symbol || task.symbol}</b></div>
          <div><span>方向</span><b>{actionText}</b></div>
          <div><span>建议价</span><b className="tabular">{pending.suggestedPrice ?? "--"}</b></div>
          <div><span>建议量</span><b className="tabular">{pending.suggestedQty ?? "--"}</b></div>
        </div>
        {live ? <div className="invalidation trade-confirm-warn"><AlertTriangle size={14} /><span>请核对价格和数量。点「确认并下单」后才会提交{pending.action === "BUY" ? "买入订立" : "卖出转让"}。</span></div> : null}
        <p className="trade-confirm-message">{pending.message}</p>
        <div className="modal-actions trade-confirm-actions">
          <button type="button" className="button button-quiet" onClick={onCancel} disabled={busyAction !== null}>暂不下单</button>
          <button type="button" className="button button-primary" onClick={onConfirm} disabled={busyAction !== null}>
            <Check size={15} />{submitting ? "提交中" : live ? "确认并下单" : `确认${actionText}建议`}
          </button>
        </div>
      </section>
    </div>
  );
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" role="presentation"><section className="modal-shell" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><IconButton label="关闭" onClick={onClose}><X size={17} /></IconButton></div>{children}</section></div>; }

export default App;
