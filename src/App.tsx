import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
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
  ChevronDown,
  CircleAlert,
  CircleDashed,
  CirclePause,
  CirclePlay,
  Clock3,
  Code2,
  Database,
  Download,
  Eye,
  FileKey2,
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
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Upload,
  UserRound,
  Waypoints,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import {
  approveSkill,
  autoJudge,
  claimManual,
  createTask,
  discoverConnector,
  fetchWorkspace,
  loadWorkspace,
  saveProvider,
  saveSkill,
  startTask,
  stopTask,
  testConnector,
  testProvider,
} from "./lib/api";
import { demoTask, demoWorkspace } from "./data/demo";
import type { DesktopUpdateState, EventItem, Provider, Rule, Skill, Task, TaskStatus, ViewKey, Workspace } from "./types";

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
  STOPPING: { label: "停止与撤单", tone: "red", icon: Square },
  MANUAL_CONTROL: { label: "人工接管", tone: "amber", icon: Hand },
  PAUSED: { label: "已暂停", tone: "amber", icon: CirclePause },
  BLOCKED: { label: "启动被阻断", tone: "red", icon: CircleAlert },
  ERROR: { label: "异常已保护", tone: "red", icon: AlertTriangle },
};

const formatCurrency = (value: number) => `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatPercent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

function StatusBadge({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  const meta = statusMeta[status] || statusMeta.ERROR;
  const Icon = meta.icon;
  return <span className={`status-badge tone-${meta.tone} ${compact ? "compact" : ""}`}><Icon size={compact ? 12 : 14} />{meta.label}</span>;
}

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return <button className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function DesktopUpdateControl({ state, busy, onAction }: { state: DesktopUpdateState | null; busy: boolean; onAction: () => void }) {
  if (!state || ["disabled", "unsupported"].includes(state.status)) return null;
  const actionLabel = state.status === "downloaded"
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
  const disabled = busy || ["checking", "downloading", "installing", "not-available"].includes(state.status);
  return <button type="button" className={`update-control update-${state.status}`} onClick={onAction} disabled={disabled} title={`桌面版 v${state.currentVersion} · ${state.error || actionLabel}`}><Download size={14} /><span>{actionLabel}</span></button>;
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace>(demoWorkspace);
  const [view, setView] = useState<ViewKey>("console");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<"task" | "skill" | "provider" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  const task = workspace.tasks[0] || demoWorkspace.tasks[0];
  const isRunning = ["STARTING", "MONITORING", "ANALYZING", "RISK_CHECK", "EXECUTING", "STOPPING"].includes(task.status);

  useEffect(() => {
    loadWorkspace().then(setWorkspace);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      fetchWorkspace().then((next) => { if (active) setWorkspace(next); }).catch(() => {});
    };
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

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

  const notify = (message: string) => setToast(message);
  const replaceTask = (nextTask: Task) => setWorkspace((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === nextTask.id ? nextTask : item) }));

  async function handleUpdateAction() {
    const bridge = window.axiomDesktop?.updates;
    if (!bridge || !updateState) return;
    setUpdateBusy(true);
    try {
      const next = updateState.status === "downloaded"
        ? await bridge.install()
        : updateState.status === "available"
          ? await bridge.download()
          : await bridge.check();
      setUpdateState(next);
      if (next.status === "error") notify(`更新失败：${next.error || "请稍后重试"}`);
    } catch (error) {
      notify(`更新失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally { setUpdateBusy(false); }
  }

  async function handleStart() {
    setBusyAction("start");
    try {
      const next = await startTask(task.id).catch(() => ({ ...task, status: "BLOCKED" as TaskStatus, stopLocked: true }));
      replaceTask(next);
      notify(next.status === "MONITORING" ? "启动检查通过，Agent 已进入持续监控" : "启动未通过，自动动作保持锁定");
    } catch (error) {
      notify(`启动失败：${error instanceof Error ? error.message : "请检查任务配置"}`);
    } finally { setBusyAction(null); }
  }

  async function handleStop() {
    setBusyAction("stop");
    replaceTask({ ...task, status: "STOPPING" });
    try {
      const next = await stopTask(task.id).catch(() => ({ ...task, status: "MANUAL_CONTROL" as TaskStatus, stopLocked: true }));
      replaceTask(next);
      notify("已停止自动控制，任务进入人工接管");
    } catch (error) {
      notify(`停止失败：${error instanceof Error ? error.message : "服务端仍保持禁止下单"}`);
    } finally { setBusyAction(null); }
  }

  async function handleManual() {
    setBusyAction("manual");
    try {
      const next = await claimManual(task.id).catch(() => ({ ...task, status: "MANUAL_CONTROL" as TaskStatus, stopLocked: true }));
      replaceTask(next);
      notify("人工接管已确认，Agent 不会自动买卖");
    } finally { setBusyAction(null); }
  }

  async function handleAutoJudge() {
    setBusyAction("judge");
    try {
      const next = await autoJudge(task.id).catch(() => ({ ...task, rules: task.rules.map((rule) => rule.id === "rule_03" ? { ...rule, status: "passed" as const, detail: "人工确认通过，已记录审计" } : rule) }));
      replaceTask(next);
      notify("规则已确认，结果写入审计链");
    } finally { setBusyAction(null); }
  }

  function updateTarget(result: Partial<Task["target"]>) {
    replaceTask({ ...task, target: { ...task.target, ...result } });
  }

  async function handleConnectorTest(payload: Record<string, unknown>) {
    setBusyAction("connector");
    try {
      const result = await testConnector({ ...payload, taskId: task.id });
      updateTarget(result);
      notify(result.loginStatus === "simulation_ready" ? "目标适配器已就绪，模拟流程可运行" : result.loginStatus === "adapter_review_required" ? "目标已发现，等待适配器审核" : "目标连接已保存，请补充凭据");
    } catch (error) {
      notify(`连接测试未完成：${error instanceof Error ? error.message : "请检查目标配置"}`);
    } finally { setBusyAction(null); }
  }

  async function handleConnectorDiscover(payload: Record<string, unknown>) {
    setBusyAction("discover");
    try {
      const result = await discoverConnector({ ...payload, taskId: task.id });
      const targetChanged = task.target.connectorId !== result.connectorId;
      replaceTask({ ...task, target: { ...task.target, type: result.type === "app" ? "app" : "website", name: result.name, url: result.type === "website" ? result.target : "", installPath: result.type === "app" ? result.target : "", connectorId: result.connectorId, adapterId: result.adapterId, adapterVersion: result.adapterVersion, discoveryStatus: result.discoveryStatus, adapterStatus: result.adapterStatus, connectionStatus: result.reviewStatus === "APPROVED" ? "connected" : "review_required", loginStatus: result.reviewStatus === "APPROVED" ? "credential_required" : "adapter_review_required", executionModes: result.executionModes, ...(targetChanged ? { credentialRef: "", accountLabel: "未配置", credentialStatus: "未配置" } : {}) } });
      notify(`目标已发现：${result.capabilities.length} 项能力，${result.reviewStatus === "APPROVED" ? "可进入凭据测试" : "等待适配器审核"}`);
    } catch (error) {
      notify(`目标发现失败：${error instanceof Error ? error.message : "请检查地址或安装路径"}`);
    } finally { setBusyAction(null); }
  }

  async function handleSkillSave(payload: Record<string, unknown>) {
    const skill = await saveSkill(payload).catch(() => ({
      id: `skill_local_${Date.now()}`,
      title: String(payload.title || "未命名专家经验"),
      kind: (payload.kind || "expert") as Skill["kind"],
      source: String(payload.filename || "手动输入"),
      status: "REVIEW" as const,
      version: "draft-1",
      tags: String(payload.tags || "").split(",").map((item) => item.trim()).filter(Boolean),
      chunks: 0,
      updatedAt: new Date().toISOString(),
      summary: String(payload.content || "").slice(0, 120),
      content: String(payload.content || ""),
    }));
    setWorkspace((current) => ({ ...current, skills: [skill, ...current.skills] }));
    setModal(null);
    setView("skills");
    notify("已建立草稿 Skill，审核前不会影响自动裁决");
  }

  async function handleSkillApprove(skill: Skill) {
    const next = await approveSkill(skill.id).catch(() => ({ ...skill, status: "APPROVED" as const, version: "v1.0", chunks: Math.max(1, skill.chunks || 1) }));
    setWorkspace((current) => ({ ...current, skills: current.skills.map((item) => item.id === next.id ? next : item) }));
    notify(`${next.title} 已发布到 RAG 索引`);
  }

  async function handleProviderSave(payload: Record<string, unknown>) {
    const provider = await saveProvider(payload).catch(() => ({
      id: String(payload.id || `provider_local_${Date.now()}`),
      name: String(payload.name || "自定义 Provider"),
      model: String(payload.model || "default"),
      baseUrl: String(payload.baseUrl || ""),
      configured: Boolean(payload.apiKey),
      keyPreview: payload.apiKey ? `${String(payload.apiKey).slice(0, 3)}***${String(payload.apiKey).slice(-3)}` : "未配置",
      status: payload.apiKey ? "待验证" : "未配置",
    }));
    setWorkspace((current) => ({ ...current, providers: [...current.providers.filter((item) => item.id !== provider.id), provider] }));
    setModal(null);
    notify("Provider 已保存，密钥仅在服务端保存");
  }

  async function handleProviderTest(provider: Provider) {
    const next = await testProvider(provider.id).catch(() => ({ ...provider, status: provider.configured ? "已配置，待真实请求验证" : "未配置" }));
    setWorkspace((current) => ({ ...current, providers: current.providers.map((item) => item.id === next.id ? next : item) }));
    notify(`${next.name}：${next.status}`);
  }

  async function handleTaskCreate(payload: Record<string, unknown>) {
    const created = await createTask(payload).catch(() => ({
      ...demoTask,
      id: `task_local_${Date.now()}`,
      name: String(payload.name || "新建自动驾驶任务"),
      status: "READY" as TaskStatus,
      mode: (payload.mode === "LIVE" ? "LIVE" : payload.mode === "SHADOW" ? "SHADOW" : "PAPER") as Task["mode"],
      symbol: String(payload.symbol || "BTC/USDT"),
      timeframe: String(payload.timeframe || "15m"),
      target: { ...demoTask.target, type: payload.targetType === "app" ? "app" as const : "website" as const, name: String(payload.targetName || "未命名目标"), url: String(payload.url || ""), appId: String(payload.appId || ""), installPath: String(payload.installPath || ""), accountLabel: String(payload.accountLabel || "未配置"), credentialStatus: "未配置", connectionStatus: "disconnected", discoveryStatus: "未发现", adapterStatus: "待发现" },
    }));
    setWorkspace((current) => ({ ...current, tasks: [created, ...current.tasks] }));
    setModal(null);
    setView("console");
    notify(`任务已创建：${created.name}`);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><strong>axiom</strong><small>agent workspace</small></div>
        </div>
        <div className="workspace-switcher"><div className="avatar">Q</div><div><b>Quant Lab</b><span>个人工作区</span></div><ChevronDown size={14} /></div>
        <div className="nav-label">工作区</div>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.map(({ key, label, icon: Icon }) => <button key={key} className={view === key ? "nav-item active" : "nav-item"} onClick={() => { setView(key); setSidebarOpen(false); }}><Icon size={17} /><span>{label}</span>{key === "skills" && workspace.skills.some((skill) => skill.status === "REVIEW") && <em>2</em>}</button>)}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-label">系统</div>
        <button className="nav-item" onClick={() => { setView("connectors"); setSidebarOpen(false); }}><Settings2 size={17} /><span>偏好设置</span></button>
        <div className="sidebar-bottom">
          <div className="service-card"><span className="online-dot" /><div><b>本地服务在线</b><span>API · 127.0.0.1:8787</span></div><MoreHorizontal size={15} /></div>
          <div className="user-row"><div className="avatar avatar-small">Y</div><div><b>Yong Zhang</b><span>管理员</span></div><LogOutIcon /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <IconButton label="打开导航" onClick={() => setSidebarOpen((value) => !value)}><Menu size={18} /></IconButton>
          <div className="breadcrumbs"><span>Quant Lab</span><span>/</span><b>{view === "console" ? "任务控制台" : navItems.find((item) => item.key === view)?.label}</b></div>
          <div className="topbar-actions"><button className="command-button"><Search size={15} /><span>搜索任务、Skill 或事件</span><kbd>⌘ K</kbd></button><DesktopUpdateControl state={updateState} busy={updateBusy} onAction={handleUpdateAction} /><IconButton label="查看通知"><CircleAlert size={17} /></IconButton><div className="top-avatar">YZ</div></div>
        </header>

        <div className="content-scroll">
          {view === "console" && <ConsoleView task={task} workspace={workspace} isRunning={isRunning} busyAction={busyAction} onStart={handleStart} onStop={handleStop} onManual={handleManual} onAutoJudge={handleAutoJudge} onConnectorTest={handleConnectorTest} />}
          {view === "workflows" && <WorkflowsView task={task} onCreate={() => setModal("task")} onRun={handleStart} busyAction={busyAction} />}
          {view === "skills" && <SkillsView skills={workspace.skills} rag={workspace.rag} onCreate={() => setModal("skill")} onApprove={handleSkillApprove} />}
          {view === "connectors" && <ConnectorsView task={task} providers={workspace.providers} onConnectorTest={handleConnectorTest} onConnectorDiscover={handleConnectorDiscover} onProviderCreate={() => setModal("provider")} onProviderTest={handleProviderTest} busyAction={busyAction} />}
          {view === "runs" && <RunsView runs={workspace.runs} events={workspace.events} />}
        </div>
      </main>

      {modal === "task" && <TaskModal onClose={() => setModal(null)} onCreate={handleTaskCreate} />}
      {modal === "skill" && <SkillModal onClose={() => setModal(null)} onSave={handleSkillSave} />}
      {modal === "provider" && <ProviderModal onClose={() => setModal(null)} onSave={handleProviderSave} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function LogOutIcon() { return <span className="logout-icon" aria-hidden="true"><ArrowDownRight size={15} /></span>; }

function ConsoleView({ task, workspace, isRunning, busyAction, onStart, onStop, onManual, onAutoJudge, onConnectorTest }: { task: Task; workspace: Workspace; isRunning: boolean; busyAction: string | null; onStart: () => void; onStop: () => void; onManual: () => void; onAutoJudge: () => void; onConnectorTest: (payload: Record<string, unknown>) => void }) {
  const pendingReview = task.rules.some((rule) => rule.status === "pending" && rule.mode === "REVIEW");
  return <>
    <section className="page-heading console-heading"><div><div className="eyebrow"><span className="eyebrow-line" />实时任务</div><h1>自动驾驶任务</h1><p>{task.name} <span className="heading-separator">·</span> {task.mode === "PAPER" ? "模拟盘" : task.mode} <span className="heading-separator">·</span> {task.timeframe} 周期</p></div><div className="heading-controls"><div className="last-sync"><span className="online-dot" />数据同步正常 <span>刚刚</span></div>{isRunning ? <button className="button button-danger" onClick={onStop} disabled={busyAction !== null}><Square size={15} />{busyAction === "stop" ? "正在停止" : "停止自动驾驶"}</button> : <button className="button button-primary" onClick={onStart} disabled={busyAction !== null}><Play size={15} />{busyAction === "start" ? "检查中" : "开始自动驾驶"}</button>}</div></section>
    <section className="status-strip"><div className="status-main"><StatusBadge status={task.status} /><span className="status-copy">{task.status === "MANUAL_CONTROL" ? "Agent 已释放控制权，账户由人工操作" : task.status === "MONITORING" ? "Agent 正在等待下一根 K 线收盘" : "当前任务需要你的注意"}</span></div><div className="status-meta"><span><LockKeyhole size={13} />停止锁 {task.stopLocked ? "已启用" : "待命"}</span><span><Clock3 size={13} />租约 {task.leaseExpiresAt ? `${Math.max(0, Math.round((new Date(task.leaseExpiresAt).getTime() - Date.now()) / 60000))}m` : "未建立"}</span><span><Database size={13} />{workspace.rag?.indexedChunks || 0} 个索引切片</span></div></section>
    <div className="metrics-grid"><MetricCard label="账户权益" value={formatCurrency(task.metrics.equity)} detail="较昨日" change={formatPercent(task.metrics.dayPnlPct)} tone="green" icon={<WalletIcon />} /><MetricCard label="今日盈亏" value={formatCurrency(task.metrics.dayPnl)} detail="模拟盘" change="+1.24%" tone="green" icon={<ArrowUpRight size={16} />} /><MetricCard label="当前敞口" value={`${task.metrics.exposurePct}%`} detail="上限 30%" change="安全" tone="blue" icon={<Gauge size={16} />} /><MetricCard label="风险预算" value={`${task.metrics.riskBudgetPct}%`} detail="剩余可用" change="62 / 100" tone="amber" icon={<ShieldCheck size={16} />} /></div>
    <div className="console-grid"><MarketPanel task={task} /><DecisionPanel task={task} pendingReview={pendingReview} onAutoJudge={onAutoJudge} onManual={onManual} busyAction={busyAction} /></div>
    <WorkflowPanel task={task} onConnectorTest={onConnectorTest} busyAction={busyAction} />
    <div className="lower-grid"><RulesPanel rules={task.rules} pendingReview={pendingReview} onAutoJudge={onAutoJudge} busyAction={busyAction} /><EventsPanel events={workspace.events} /></div>
  </>;
}

function MetricCard({ label, value, detail, change, tone, icon }: { label: string; value: string; detail: string; change: string; tone: string; icon: React.ReactNode }) {
  return <article className="metric-card"><div className={`metric-icon metric-${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong className="tabular">{value}</strong><small>{detail} <b className={`text-${tone}`}>{change}</b></small></div></article>;
}

function MarketPanel({ task }: { task: Task }) {
  const market = task.market;
  const price = market?.latest.price ?? 68420.5;
  const change = market?.changePct ?? 2.18;
  const indicators = market?.indicators;
  return <section className="panel market-panel"><div className="panel-header"><div><div className="panel-kicker"><BarChart3 size={14} />市场状态</div><h2>{task.symbol}</h2></div><div className="market-header-actions"><div className="select-like">{task.timeframe} <ChevronDown size={13} /></div><div className="select-like">现货 <ChevronDown size={13} /></div><IconButton label="展开图表"><MoreHorizontal size={17} /></IconButton></div></div><div className="market-quote"><div><strong className="quote-price tabular">{price.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong><span className={`quote-change ${change >= 0 ? "positive" : "negative"}`}>{change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {change >= 0 ? "+" : ""}{change.toFixed(2)}%</span></div><span className="quote-time">{market ? `${market.source === "paper-simulation" ? "本地回放" : "外部数据"} · ${formatTime(market.observedAt)}` : "等待数据采集"}</span></div><TrendChart /><div className="indicator-row"><Indicator label="EMA 20" value={indicators ? indicators.ema20.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "67,820.2"} tone="blue" /><Indicator label="RSI 14" value={indicators ? indicators.rsi14.toFixed(1) : "62.4"} tone="amber" /><Indicator label="ATR" value={indicators ? indicators.atr14.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "842.6"} tone="muted" /><Indicator label="量能比" value={indicators ? `${indicators.volumeRatio.toFixed(2)}x` : "1.42x"} tone="green" /></div></section>;
}

function TrendChart() {
  const points = [28, 34, 31, 43, 40, 48, 46, 58, 52, 62, 59, 72, 68, 78, 73, 88, 84, 96, 90, 105, 101, 116, 111, 126, 121, 138, 132, 146, 143, 158, 151, 168, 162, 176, 170, 184, 178, 194, 188, 204, 199, 214, 209, 226, 218, 232, 226, 242];
  const line = points.map((point, index) => `${index * 16 + 20},${250 - point}`).join(" ");
  const area = `20,250 ${line} 772,250`;
  return <div className="chart-wrap"><svg viewBox="0 0 800 250" role="img" aria-label="BTC USDT 15 分钟趋势图，当前处于上行趋势"><g className="chart-grid"><line x1="20" y1="42" x2="780" y2="42" /><line x1="20" y1="100" x2="780" y2="100" /><line x1="20" y1="158" x2="780" y2="158" /><line x1="20" y1="216" x2="780" y2="216" /></g><polygon className="chart-area" points={area} /><polyline className="chart-line" points={line} /><line className="trigger-line" x1="20" y1="126" x2="780" y2="126" /><circle className="chart-point" cx="756" cy="8" r="4" /><text x="670" y="118" className="trigger-label">EMA20 67,820</text></svg><div className="chart-axis"><span>08:00</span><span>08:30</span><span>09:00</span><span>09:30</span></div></div>;
}

function Indicator({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="indicator"><span><i className={`indicator-dot ${tone}`} />{label}</span><b className="tabular">{value}</b></div>; }

function DecisionPanel({ task, pendingReview, onAutoJudge, onManual, busyAction }: { task: Task; pendingReview: boolean; onAutoJudge: () => void; onManual: () => void; busyAction: string | null }) {
  const decision = task.decision;
  return <section className="panel decision-panel"><div className="panel-header"><div><div className="panel-kicker"><Bot size={14} />Agent 判断</div><h2>当前决策</h2></div><span className="decision-age"><span className="online-dot" />{decision.ttlSec}s TTL</span></div><div className={`decision-action action-${decision.action.toLowerCase()}`}><div className="decision-symbol">{decision.action === "BUY" ? <ArrowUpRight size={24} /> : decision.action === "SELL" ? <ArrowDownRight size={24} /> : <Pause size={22} />}</div><div><strong>{decision.action === "BUY" ? "建议买入" : decision.action === "SELL" ? "建议卖出" : "保持观望"}</strong><span>结构化意图 · {Math.round(decision.confidence * 100)}% 置信度</span></div><span className="decision-time">09:30</span></div><div className="confidence-bar"><div style={{ width: `${decision.confidence * 100}%` }} /><span>置信度 <b>{Math.round(decision.confidence * 100)}%</b></span></div><div className="decision-stats"><div><span>目标仓位</span><b className="tabular">{decision.targetPositionPct}%</b></div><div><span>单笔上限</span><b className="tabular">{decision.maxOrderValuePct}%</b></div><div><span>证据</span><b className="tabular">{decision.evidenceIds.length} 条</b></div></div><div className="reason-block"><span className="block-label">机器可验证依据</span>{decision.reasonCodes.map((code) => <div className="reason-row" key={code}><CheckCircle2 size={14} /><span>{code === "EMA_SLOPE_POSITIVE" ? "EMA20 斜率为正" : code === "VOLUME_CONFIRMATION" ? "成交量确认突破" : code}</span><a href="#evidence">查看证据</a></div>)}</div><div className="invalidation"><AlertTriangle size={14} /><span>失效条件：{decision.invalidation}</span></div>{pendingReview ? <div className="decision-actions"><button className="button button-primary button-full" onClick={onAutoJudge} disabled={busyAction !== null}><Check size={15} />{busyAction === "judge" ? "记录中" : "确认规则并继续"}</button><button className="button button-quiet button-full" onClick={onManual} disabled={busyAction !== null}><Hand size={15} />转人工处理</button></div> : <div className="decision-safe"><ShieldCheck size={14} /><span>硬风控已接管执行权限</span></div>}</section>;
}

function WorkflowPanel({ task, onConnectorTest, busyAction }: { task: Task; onConnectorTest: (payload: Record<string, unknown>) => void; busyAction: string | null }) {
  return <section className="panel workflow-panel"><div className="panel-header"><div><div className="panel-kicker"><Workflow size={14} />工作流进度</div><h2>从连接到动作</h2></div><button className="text-button" onClick={() => onConnectorTest({ taskId: task.id, connectorId: task.target.connectorId, type: task.target.type, name: task.target.name, url: task.target.url, appId: task.target.appId, installPath: task.target.installPath, credentialRef: task.target.credentialRef })} disabled={busyAction !== null || !task.target.credentialRef}><RefreshCw size={14} />重新测试连接</button></div><div className="workflow-rail">{task.workflow.map((step, index) => <div className={`workflow-step ${step.status}`} key={step.key}><div className="workflow-node">{step.status === "complete" ? <Check size={14} /> : step.status === "active" ? <span className="node-pulse" /> : <span>{index + 1}</span>}</div><div className="workflow-copy"><strong>{step.label}</strong><span>{step.detail}</span></div>{index < task.workflow.length - 1 && <div className={`workflow-connector ${step.status === "complete" ? "complete" : ""}`} />}</div>)}</div></section>;
}

function RulesPanel({ rules, pendingReview, onAutoJudge, busyAction }: { rules: Rule[]; pendingReview: boolean; onAutoJudge: () => void; busyAction: string | null }) {
  return <section className="panel rules-panel"><div className="panel-header"><div><div className="panel-kicker"><ListChecks size={14} />规则裁决</div><h2>执行前检查</h2></div><span className="count-badge">{rules.filter((rule) => rule.status === "passed").length}/{rules.length} 已通过</span></div><div className="rule-list">{rules.map((rule) => <div className="rule-row" key={rule.id}><span className={`rule-order rule-${rule.mode.toLowerCase()}`}>{String(rule.order).padStart(2, "0")}</span><div className="rule-copy"><strong>{rule.name}</strong><span>{rule.detail}</span></div><span className={`rule-mode mode-${rule.mode.toLowerCase()}`}>{rule.mode === "AUTO" ? "自动" : rule.mode === "REVIEW" ? "人工" : "红线"}</span><span className={`rule-status status-${rule.status}`}>{rule.status === "passed" ? <CheckCircle2 size={15} /> : rule.status === "pending" ? <CirclePause size={15} /> : <CircleDashed size={15} />}</span></div>)}</div>{pendingReview && <div className="review-callout"><div><AlertTriangle size={16} /><span>规则 3 需要人工判断，当前动作已暂停</span></div><button className="button button-small button-primary" onClick={onAutoJudge} disabled={busyAction !== null}><Check size={14} />确认</button></div>}</section>;
}

function EventsPanel({ events }: { events: EventItem[] }) {
  const visible = events.length ? events : demoWorkspace.events;
  return <section className="panel events-panel" id="evidence"><div className="panel-header"><div><div className="panel-kicker"><Clock3 size={14} />实时事件</div><h2>审计时间线</h2></div><button className="text-button">查看全部 <ArrowUpRight size={14} /></button></div><div className="event-list">{visible.slice(0, 5).map((event) => <div className="event-row" key={event.id}><EventDot type={event.type} /><div className="event-copy"><strong>{event.message}</strong><span>{formatTime(event.createdAt)} <i>·</i> {event.type === "decision" ? "Agent" : event.type === "risk" ? "风控引擎" : "数据服务"}</span></div></div>)}</div></section>;
}

function EventDot({ type }: { type: string }) { const tone = type === "risk" ? "amber" : type === "decision" ? "blue" : type === "paper_order" ? "green" : "muted"; return <span className={`event-dot ${tone}`}><span /></span>; }
function WalletIcon() { return <span className="wallet-icon">¥</span>; }

function WorkflowsView({ task, onCreate, onRun, busyAction }: { task: Task; onCreate: () => void; onRun: () => void; busyAction: string | null }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />任务编排</div><h1>工作流</h1><p>把连接、采集、分析、规则和动作串成可审计的运行链。</p></div><button className="button button-primary" onClick={onCreate}><Plus size={16} />新建任务</button></section><section className="workflow-overview"><div className="workflow-overview-main"><div className="panel-kicker"><Workflow size={14} />当前运行模板</div><div className="overview-title-row"><h2>{task.name}</h2><StatusBadge status={task.status} /></div><p className="overview-description">{task.target.type === "website" ? "网站连接" : "桌面 App 连接"} · {task.target.name} · {task.symbol} · {task.timeframe} · {task.mode === "PAPER" ? "模拟盘" : task.mode}</p><div className="large-flow">{task.workflow.map((step, index) => <div className={`large-step ${step.status}`} key={step.key}><div className="large-step-number">{step.status === "complete" ? <Check size={15} /> : index + 1}</div><div><strong>{step.label}</strong><span>{step.detail}</span></div>{index < task.workflow.length - 1 && <div className="large-step-line" />}</div>)}</div><div className="overview-actions"><button className={`button ${task.status === "MONITORING" ? "button-danger" : "button-primary"}`} onClick={task.status === "MONITORING" ? () => undefined : onRun} disabled={busyAction !== null}>{task.status === "MONITORING" ? <><Activity size={15} />运行中</> : <><Play size={15} />运行任务</>}</button><button className="button button-quiet"><Settings2 size={15} />编辑配置</button></div></div><aside className="workflow-side"><div className="side-stat"><span>运行时长</span><strong className="tabular">04:18:32</strong><small>本次任务</small></div><div className="side-stat"><span>已完成决策</span><strong className="tabular">38</strong><small>过去 24 小时</small></div><div className="side-stat"><span>规则拦截</span><strong className="tabular text-amber">3</strong><small>全部已记录</small></div><div className="side-note"><ShieldCheck size={16} /><div><b>自动执行边界</b><span>仅限模拟盘与已批准规则</span></div></div></aside></section><section className="template-section"><div className="section-title-row"><div><div className="panel-kicker"><Zap size={14} />快捷模板</div><h2>从已验证流程开始</h2></div><button className="text-button">管理模板 <ArrowUpRight size={14} /></button></div><div className="template-grid"><TemplateCard icon={<Globe2 size={18} />} title="网站行情监控" description="登录、采集、趋势分析、规则裁决" tag="推荐" /><TemplateCard icon={<Laptop size={18} />} title="桌面 App 观察" description="启动 App、读取界面、人工接管" tag="受控" /><TemplateCard icon={<Terminal size={18} />} title="数据准备任务" description="执行白名单命令并生成分析输入" tag="诊断" /></div></section></>;
}

function TemplateCard({ icon, title, description, tag }: { icon: React.ReactNode; title: string; description: string; tag: string }) { return <button className="template-card"><span className="template-icon">{icon}</span><span className="template-copy"><strong>{title}</strong><span>{description}</span></span><span className="template-tag">{tag}</span><ArrowUpRight size={15} /></button>; }

function SkillsView({ skills, rag, onCreate, onApprove }: { skills: Skill[]; rag?: Workspace["rag"]; onCreate: () => void; onApprove: (skill: Skill) => void }) {
  const approved = skills.filter((skill) => skill.status === "APPROVED").length;
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />知识与约束</div><h1>经验与 Skills</h1><p>专家经验、规则和红线先审核，再进入 RAG 决策上下文。</p></div><button className="button button-primary" onClick={onCreate}><Upload size={16} />导入经验</button></section><div className="skill-summary"><SummaryTile label="已发布 Skills" value={String(approved)} icon={<BookOpen size={17} />} tone="green" /><SummaryTile label="待审核" value={String(skills.length - approved)} icon={<CirclePause size={17} />} tone="amber" /><SummaryTile label="RAG 切片" value={String(rag?.indexedChunks || 0)} icon={<Database size={17} />} tone="blue" /><SummaryTile label="检索模式" value="本地可替换" icon={<Search size={17} />} tone="muted" /></div><section className="panel skills-panel"><div className="panel-header"><div><div className="panel-kicker"><FileText size={14} />知识库版本</div><h2>初始化 Skills</h2></div><div className="panel-header-tools"><div className="search-field"><Search size={14} /><input placeholder="筛选标题或标签" aria-label="筛选标题或标签" /></div><IconButton label="更多知识库操作"><MoreHorizontal size={17} /></IconButton></div></div><div className="skill-table"><div className="table-head"><span>名称</span><span>类型</span><span>来源与标签</span><span>版本</span><span>状态</span><span /></div>{skills.map((skill) => <SkillRow key={skill.id} skill={skill} onApprove={onApprove} />)}</div></section></>;
}

function SummaryTile({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone: string }) { return <article className="summary-tile"><span className={`summary-icon ${tone}`}>{icon}</span><div><span>{label}</span><strong className="tabular">{value}</strong></div></article>; }
function SkillRow({ skill, onApprove }: { skill: Skill; onApprove: (skill: Skill) => void }) { const kind = skill.kind === "guardrail" ? "红线" : skill.kind === "rule" ? "规则" : "专家经验"; return <div className="skill-row"><div className="skill-name"><span className={`skill-file ${skill.kind}`}><FileText size={16} /></span><div><strong>{skill.title}</strong><span>{skill.summary}</span></div></div><span className={`kind-label kind-${skill.kind}`}>{kind}</span><div className="skill-source"><span>{skill.source}</span><div className="tag-list">{skill.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}</div></div><span className="version-label tabular">{skill.version}<small>{skill.chunks} chunks</small></span><div>{skill.status === "APPROVED" ? <span className="approval-label"><CheckCircle2 size={14} />已发布</span> : <button className="button button-small button-review" onClick={() => onApprove(skill)}><ShieldCheck size={13} />审核发布</button>}</div><IconButton label={`查看 ${skill.title}`}><ArrowUpRight size={15} /></IconButton></div>; }

function ConnectorsView({ task, providers, onConnectorTest, onConnectorDiscover, onProviderCreate, onProviderTest, busyAction }: { task: Task; providers: Provider[]; onConnectorTest: (payload: Record<string, unknown>) => void; onConnectorDiscover: (payload: Record<string, unknown>) => void; onProviderCreate: () => void; onProviderTest: (provider: Provider) => void; busyAction: string | null }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />外部能力</div><h1>连接器</h1><p>网站、桌面 App 与 AI Provider 的凭据和权限边界。</p></div><button className="button button-primary" onClick={onProviderCreate}><Plus size={16} />添加 Provider</button></section><div className="connector-grid"><TargetConnector task={task} onTest={onConnectorTest} onDiscover={onConnectorDiscover} busyAction={busyAction} /><section className="panel provider-panel"><div className="panel-header"><div><div className="panel-kicker"><Bot size={14} />模型接入</div><h2>AI Provider</h2></div><span className="secure-label"><LockKeyhole size={13} />服务端托管密钥</span></div><div className="provider-list">{providers.map((provider) => <ProviderRow key={provider.id} provider={provider} onTest={onProviderTest} />)}</div><div className="provider-note"><ShieldCheck size={15} /><span>模型只能提出结构化意图，不能直接调用下单、提现或修改风控工具。</span></div></section></div><section className="panel permissions-panel"><div className="panel-header"><div><div className="panel-kicker"><KeyRound size={14} />权限边界</div><h2>当前任务授权</h2></div><span className="mode-chip">模拟盘模式</span></div><div className="permission-grid"><PermissionItem icon={<EyeIcon />} label="读取行情与历史数据" status="允许" tone="green" /><PermissionItem icon={<UserRound size={16} />} label="读取账户与持仓" status="允许" tone="green" /><PermissionItem icon={<ListChecks size={16} />} label="提出交易计划" status="受控" tone="amber" /><PermissionItem icon={<LockKeyhole size={16} />} label="直接提交订单" status="禁止" tone="red" /><PermissionItem icon={<LockKeyhole size={16} />} label="修改风控与资金" status="禁止" tone="red" /></div></section></>;
}

function TargetConnector({ task, onTest, onDiscover, busyAction }: { task: Task; onTest: (payload: Record<string, unknown>) => void; onDiscover: (payload: Record<string, unknown>) => void; busyAction: string | null }) {
  const [type, setType] = useState<"website" | "app">(task.target.type);
  const [name, setName] = useState(task.target.name);
  const [url, setUrl] = useState(task.target.url || "");
  const [appId, setAppId] = useState(task.target.appId || "");
  const [installPath, setInstallPath] = useState(task.target.installPath || "");
  const [username, setUsername] = useState(task.target.accountLabel);
  const [password, setPassword] = useState("");
  function submit(event: FormEvent) { event.preventDefault(); onTest({ taskId: task.id, connectorId: task.target.connectorId, type, name, url, appId, installPath, username, password, credentialRef: task.target.credentialRef }); setPassword(""); }
  const connectionLabel = task.target.connectionStatus === "connected" ? (task.target.loginStatus === "simulation_ready" ? "模拟就绪" : "已连接") : task.target.connectionStatus === "review_required" ? "待审核" : "未连接";
  return <section className="panel target-panel"><div className="panel-header"><div><div className="panel-kicker"><Waypoints size={14} />目标连接</div><h2>网站 / 桌面 App</h2></div><span className={`connection-state ${task.target.connectionStatus === "connected" ? "connected" : ""}`}><span />{connectionLabel}</span></div><div className="segmented-control"><button type="button" className={type === "website" ? "selected" : ""} onClick={() => setType("website")}><Globe2 size={14} />网站</button><button type="button" className={type === "app" ? "selected" : ""} onClick={() => setType("app")}><Laptop size={14} />桌面 App</button></div><form className="connector-form" onSubmit={submit}><label>目标名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>{type === "website" ? <label>网站地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" type="url" /></label> : <><label>安装路径<input value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="/Applications/App.app 或 C:\\Program Files\\App" /></label><label>应用标识<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="应用名称或 Bundle ID（可选）" /></label></>}<div className="target-discovery"><div><span className={`discovery-dot ${task.target.discoveryStatus === "已发现" ? "ready" : ""}`} /><div><b>{task.target.discoveryStatus || "未发现"}</b><small>{task.target.adapterStatus || "输入目标后自动发现连接器"}</small></div></div><button type="button" className="button button-small button-quiet" onClick={() => onDiscover({ taskId: task.id, type, name, url, installPath, appId })} disabled={busyAction !== null || (type === "website" ? !url : !installPath && !appId)}>{busyAction === "discover" ? "发现中" : "自动发现"}</button></div><label>登录账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>登录密码<input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" type="password" placeholder={task.target.credentialRef ? "已托管，留空以复用" : "只写入安全托管，不展示"} /></label><div className="credential-note"><LockKeyhole size={14} /><span>密码写入本地加密 Vault；日志和模型上下文只使用 credentialRef。</span></div><button className="button button-secondary button-full" type="submit" disabled={busyAction !== null}><RefreshCw size={15} />{busyAction === "connector" ? "测试中" : "测试登录与连接"}</button></form></section>;
}

function ProviderRow({ provider, onTest }: { provider: Provider; onTest: (provider: Provider) => void }) { return <div className="provider-row"><span className="provider-logo">{provider.name.slice(0, 1)}</span><div className="provider-copy"><strong>{provider.name}</strong><span>{provider.model} <i>·</i> {provider.baseUrl || "未设置 Endpoint"}</span></div><span className={`provider-status ${provider.configured ? "configured" : ""}`}><span />{provider.status}</span><span className="key-preview"><KeyRound size={13} />{provider.keyPreview}</span><button className="button button-small button-quiet" onClick={() => onTest(provider)}><RefreshCw size={13} />验证</button></div>; }
function PermissionItem({ icon, label, status, tone }: { icon: React.ReactNode; label: string; status: string; tone: string }) { return <div className="permission-item"><span className={`permission-icon ${tone}`}>{icon}</span><span>{label}</span><b className={`text-${tone}`}>{status}</b></div>; }
function EyeIcon() { return <Eye size={16} />; }

function RunsView({ runs, events }: { runs: Workspace["runs"]; events: EventItem[] }) {
  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />可观测性</div><h1>运行记录</h1><p>每一轮分析、规则裁决和动作结果均可回放。</p></div><button className="button button-secondary"><FileText size={15} />导出审计</button></section><div className="run-summary"><SummaryTile label="运行中任务" value={String(runs.filter((run) => run.status === "running").length)} icon={<Activity size={17} />} tone="green" /><SummaryTile label="总决策" value={runs.reduce((sum, run) => sum + run.decisions, 0).toString()} icon={<Bot size={17} />} tone="blue" /><SummaryTile label="模拟订单" value={runs.reduce((sum, run) => sum + run.orders, 0).toString()} icon={<BarChart3 size={17} />} tone="muted" /><SummaryTile label="规则拦截" value={runs.reduce((sum, run) => sum + run.blocked, 0).toString()} icon={<ShieldCheck size={17} />} tone="amber" /></div><section className="panel runs-panel"><div className="panel-header"><div><div className="panel-kicker"><History size={14} />任务运行</div><h2>运行实例</h2></div><div className="search-field"><Search size={14} /><input placeholder="搜索运行 ID" aria-label="搜索运行 ID" /></div></div><div className="run-table"><div className="table-head"><span>运行 ID</span><span>任务</span><span>开始时间</span><span>决策</span><span>订单</span><span>状态</span></div>{runs.map((run) => <div className="run-row" key={run.id}><span className="run-id tabular">{run.id}</span><span>BTC/USDT 趋势观察</span><span className="tabular">{formatTime(run.startedAt)}</span><span className="tabular">{run.decisions}</span><span className="tabular">{run.orders}</span><span className="approval-label"><span className="online-dot" />运行中</span></div>)}</div></section><section className="panel audit-panel"><div className="panel-header"><div><div className="panel-kicker"><FileKey2 size={14} />审计日志</div><h2>最近事件</h2></div><button className="text-button">筛选 <ChevronDown size={14} /></button></div><div className="audit-list">{events.map((event) => <div className="audit-row" key={event.id}><EventDot type={event.type} /><span className="audit-time tabular">{formatTime(event.createdAt)}</span><strong>{event.message}</strong><code>{event.type}</code><button className="text-button">详情</button></div>)}</div></section></>;
}

function TaskModal({ onClose, onCreate }: { onClose: () => void; onCreate: (payload: Record<string, unknown>) => void }) { const [name, setName] = useState("新建自动驾驶任务"); const [targetType, setTargetType] = useState("website"); const [targetName, setTargetName] = useState("Northstar Exchange"); const [url, setUrl] = useState("https://demo.exchange.local"); const [installPath, setInstallPath] = useState(""); const [appId, setAppId] = useState(""); const [accountLabel, setAccountLabel] = useState(""); const [symbol, setSymbol] = useState("BTC/USDT"); const [timeframe, setTimeframe] = useState("15m"); const [mode, setMode] = useState("PAPER"); return <ModalShell title="创建任务" subtitle="先保存配置，再执行启动前检查。" onClose={onClose}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); onCreate({ name, targetType, targetName, url, installPath, appId, accountLabel, symbol, timeframe, mode }); }}><label>任务名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><div className="form-row"><label>目标类型<select value={targetType} onChange={(event) => setTargetType(event.target.value)}><option value="website">网站</option><option value="app">桌面 App</option></select></label><label>运行模式<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="PAPER">模拟盘</option><option value="SHADOW">影子交易</option><option value="LIVE">小资金实盘（需额外审批）</option></select></label></div><label>目标名称<input value={targetName} onChange={(event) => setTargetName(event.target.value)} /></label>{targetType === "website" ? <label>网站地址<input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://" /></label> : <><label>App 安装路径<input value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="/Applications/App.app 或 C:\\Program Files\\App" /></label><label>应用标识<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="应用名称或 Bundle ID（可选）" /></label></>}<div className="form-row"><label>交易品种<input value={symbol} onChange={(event) => setSymbol(event.target.value)} /></label><label>分析周期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}><option value="15m">15 分钟</option><option value="1h">1 小时</option><option value="4h">4 小时</option></select></label></div><label>账号标识<input value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} placeholder="登录后将脱敏显示" autoComplete="username" /></label><div className="modal-footnote"><LockKeyhole size={14} />密码和 API Key 在连接器页面托管，创建任务不会把明文写入任务配置。</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="submit" className="button button-primary"><Plus size={15} />创建任务</button></div></form></ModalShell>; }

function SkillModal({ onClose, onSave }: { onClose: () => void; onSave: (payload: Record<string, unknown>) => void }) { const [title, setTitle] = useState(""); const [kind, setKind] = useState("expert"); const [tags, setTags] = useState("BTC/USDT,15m"); const [content, setContent] = useState(""); const [filename, setFilename] = useState("手动输入"); function chooseFile(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setFilename(file.name); file.text().then(setContent); if (!title) setTitle(file.name.replace(/\.[^.]+$/, "")); } return <ModalShell title="导入专家经验" subtitle="文件或文本会保存为待审核草稿，不会立即影响决策。" onClose={onClose}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSave({ title: title || filename, kind, tags, content, filename }); }}><div className="upload-drop"><Upload size={20} /><div><strong>拖入 Markdown / TXT</strong><span>或点击选择本地文件</span></div><input type="file" accept=".md,.txt,.markdown,.json" onChange={chooseFile} aria-label="选择经验文件" /></div><label>Skill 标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：趋势突破与回撤红线" /></label><div className="form-row"><label>知识类型<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="expert">专家经验</option><option value="rule">规则</option><option value="redline">红线</option></select></label><label>适用标签<input value={tags} onChange={(event) => setTags(event.target.value)} /></label></div><label>内容<textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="输入触发条件、建议动作、禁止动作、失效条件和证据来源..." rows={7} /></label><div className="modal-footnote"><ShieldCheck size={14} />审核发布后才会切片并进入 RAG 检索。</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={!content.trim()}><FileText size={15} />保存草稿</button></div></form></ModalShell>; }

function ProviderModal({ onClose, onSave }: { onClose: () => void; onSave: (payload: Record<string, unknown>) => void }) { const [name, setName] = useState("自定义 OpenAI Compatible"); const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState(""); const [apiKey, setApiKey] = useState(""); return <ModalShell title="添加 AI Provider" subtitle="兼容 OpenAI Chat Completions 的服务均可接入。" onClose={onClose}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSave({ name, baseUrl, model, apiKey }); }}><label>Provider 名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label>Endpoint<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" type="url" /></label><div className="form-row"><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model-name" /></label><label>API Key<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." type="password" autoComplete="new-password" /></label></div><div className="modal-footnote"><LockKeyhole size={14} />密钥只发送到本地 API 服务端，前端只显示脱敏预览。</div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="submit" className="button button-primary"><KeyRound size={15} />保存 Provider</button></div></form></ModalShell>; }

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" role="presentation"><section className="modal-shell" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><IconButton label="关闭" onClick={onClose}><X size={17} /></IconButton></div>{children}</section></div>; }

export default App;
