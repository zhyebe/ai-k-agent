import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Database,
  FileKey2,
  FileText,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { adminLogin, adminLogout, adminSession, createAdminUser, deleteAdminUser, fetchAdminSummary, getApiBaseUrl, listAdminUsers, updateAdminUser } from "./lib/api";
import type { AdminAccount, AdminSummary } from "./lib/api";
import type { EventItem } from "./types";

type AdminTab = "overview" | "accounts" | "audit";
type AdminUser = AdminAccount;

const emptySummary: AdminSummary = {
  scope: "accounts_audit",
  users: 0,
  activeUsers: 0,
  disabledUsers: 0,
  auditEvents: 0,
  accounts: [],
  events: [],
  persistence: { mode: "unknown", available: false },
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

function accountStatusLabel(status: string) {
  return status === "ACTIVE" ? "启用" : status === "DISABLED" ? "停用" : status;
}

export default function AdminApp() {
  const [summary, setSummary] = useState<AdminSummary>(emptySummary);
  const [tab, setTab] = useState<AdminTab>("overview");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const refresh = () => {
      fetchAdminSummary().then((next) => {
        if (!active) return;
        setSummary(next);
        setUsers(next.accounts);
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [signedIn]);

  useEffect(() => {
    let active = true;
    adminSession()
      .then(() => { if (active) setSignedIn(true); })
      .catch(() => { window.sessionStorage.removeItem("axiom.admin.token"); })
      .finally(() => { if (active) setAuthChecked(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!authChecked) return <div className="admin-login"><div className="admin-login-panel login-loading"><RefreshCw size={18} /><span>正在验证管理会话</span></div></div>;
  if (!signedIn) return <AdminLogin onSignedIn={() => setSignedIn(true)} />;

  const apiAddress = getApiBaseUrl().replace(/^https?:\/\//, "") || `${window.location.hostname}:${window.location.port || "80"}`;

  async function handleRefresh() {
    try {
      const next = await fetchAdminSummary();
      setSummary(next);
      setUsers(next.accounts);
      setToast("状态已刷新");
    } catch (error) {
      setToast(`刷新失败：${errorMessage(error)}`);
    }
  }

  async function handleLogout() {
    await adminLogout().catch(() => {});
    window.sessionStorage.removeItem("axiom.admin.token");
    setSignedIn(false);
  }

  const tabs: Array<{ key: AdminTab; label: string; icon: typeof LayoutDashboard }> = [
    { key: "overview", label: "总览", icon: LayoutDashboard },
    { key: "accounts", label: "账号管理", icon: UserRound },
    { key: "audit", label: "审计日志", icon: History },
  ];

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><div><strong>axiom</strong><small>admin console</small></div></div>
      <div className="admin-role"><ShieldCheck size={15} /><div><b>管理后台</b><span>账号授权与日志</span></div></div>
      <div className="nav-label">管理</div>
      <nav className="admin-nav" aria-label="后台导航">
        {tabs.map(({ key, label, icon: Icon }) => <button type="button" key={key} className={tab === key ? "nav-item active" : "nav-item"} aria-label={label} title={label} onClick={() => setTab(key)}><Icon size={17} /><span>{label}</span></button>)}
      </nav>
      <div className="admin-sidebar-foot">
        <div className="admin-health"><span className="online-dot" /><span>API 服务在线</span><code>{apiAddress}</code></div>
        <button type="button" className="admin-user" onClick={handleLogout} title="退出管理后台"><div className="avatar avatar-small">A</div><div><b>Admin</b><span>退出管理后台</span></div><LogOut size={14} /></button>
      </div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar">
        <div><span className="admin-breadcrumb">Axiom / Admin</span><h1>{tabs.find((item) => item.key === tab)?.label}</h1></div>
        <div className="admin-top-actions"><button type="button" className="admin-icon" onClick={handleLogout} aria-label="退出管理后台" title="退出管理后台"><LogOut size={17} /></button><div className="top-avatar">A</div></div>
      </header>
      <div className="admin-content">
        {tab === "overview" && <AdminOverview summary={summary} users={users} apiAddress={apiAddress} onAccounts={() => setTab("accounts")} onRefresh={handleRefresh} onAudit={() => setTab("audit")} />}
        {tab === "accounts" && <AdminUsers users={users} onChanged={setUsers} onToast={setToast} />}
        {tab === "audit" && <AdminAudit events={summary.events} />}
      </div>
    </main>
    {toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button type="button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={14} /></button></div>}
  </div>;
}

function AdminUsers({ users, onChanged, onToast }: { users: AdminUser[]; onChanged: (users: AdminUser[]) => void; onToast: (message: string) => void }) {
  const [username, setUsername] = useState("operator");
  const [displayName, setDisplayName] = useState("观察员");
  const [password, setPassword] = useState("");
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function refresh() {
    const result = await listAdminUsers();
    onChanged(result.users);
  }

  async function create() {
    try {
      await createAdminUser({ username, displayName, password });
      setPassword("");
      await refresh();
      onToast(`已创建用户 ${username}`);
    } catch (error) {
      onToast(`创建失败：${errorMessage(error)}`);
    }
  }

  async function toggle(user: AdminUser) {
    if (user.status === "ACTIVE" && !window.confirm(`停用 ${user.username} 后，该账号会立即退出桌面端并停止使用。确定继续吗？`)) return;
    setBusyAction(`toggle:${user.id}`);
    try {
      await updateAdminUser(user.id, { status: user.status === "ACTIVE" ? "DISABLED" : "ACTIVE" });
      await refresh();
      onToast(`${user.username} 已${user.status === "ACTIVE" ? "停用" : "启用"}`);
    } catch (error) {
      onToast(`更新失败：${errorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function resetPassword(userId: string) {
    const nextPassword = passwordDrafts[userId] || "";
    if (nextPassword.length < 8) {
      onToast("密码至少 8 位");
      return;
    }
    setBusyAction(`password:${userId}`);
    try {
      await updateAdminUser(userId, { password: nextPassword });
      await refresh();
      setPasswordDrafts((current) => ({ ...current, [userId]: "" }));
      setResetUserId(null);
      onToast("桌面端登录密码已更新");
    } catch (error) {
      onToast(`密码更新失败：${errorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function remove(user: AdminUser) {
    if (deleteConfirmation !== user.username) {
      onToast(`请输入用户名 ${user.username} 完成二次确认`);
      return;
    }
    setBusyAction(`delete:${user.id}`);
    try {
      await deleteAdminUser(user.id, deleteConfirmation);
      await refresh();
      setDeleteUserId(null);
      setDeleteConfirmation("");
      onToast(`${user.username} 及其全部账号数据已永久删除`);
    } catch (error) {
      onToast(`删除失败：${errorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return <>
    <section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />账号治理</span><h2>桌面账号</h2><p>创建登录账号、重置密码、启停授权或永久删除账号。用户业务数据由用户自己管理。</p></div></section>
    <section className="admin-panel" style={{ marginBottom: 16 }}>
      <div className="admin-panel-head"><div><span className="panel-kicker"><UserRound size={14} />新建账号</span><h3>创建桌面端登录</h3></div></div>
      <div className="admin-form admin-account-form">
        <div className="admin-form-row">
          <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        </div>
        <label>初始密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="至少 8 位" autoComplete="new-password" /></label>
        <button type="button" className="button button-primary" onClick={create} disabled={password.length < 8}><Plus size={15} />创建用户</button>
      </div>
    </section>
    <section className="admin-panel">
      <div className="admin-panel-head"><div><span className="panel-kicker"><ShieldCheck size={14} />账号列表</span><h3>{users.length} 个桌面账号</h3></div></div>
      {users.length ? users.map((user) => {
        return <div className="admin-skill-row admin-user-row" key={user.id}>
          <span className="skill-file"><UserRound size={16} /></span>
          <div className="admin-skill-copy">
            <strong>{user.displayName} · {user.username}</strong>
            <span>{accountStatusLabel(user.status)} · {user.status === "ACTIVE" ? "可登录桌面端" : "已锁定，无法登录"}</span>
            {resetUserId === user.id && <div className="admin-password-reset"><input type="password" value={passwordDrafts[user.id] || ""} onChange={(event) => setPasswordDrafts((current) => ({ ...current, [user.id]: event.target.value }))} placeholder="新密码，至少 8 位" aria-label={`为 ${user.username} 设置新密码`} autoComplete="new-password" /><button type="button" className="button button-small button-secondary" onClick={() => resetPassword(user.id)} disabled={busyAction === `password:${user.id}`}><CheckCircle2 size={13} />保存密码</button><button type="button" className="admin-icon" onClick={() => { setResetUserId(null); setPasswordDrafts((current) => ({ ...current, [user.id]: "" })); }} aria-label="取消重置密码" title="取消重置密码"><X size={14} /></button></div>}
            {deleteUserId === user.id && <div className="admin-delete-confirm"><div><AlertTriangle size={15} /><span>将永久清空该账号的任务、运行记录、Provider、Skill、连接器、凭据和会话，无法恢复。</span></div><label>输入用户名 <b>{user.username}</b> 二次确认<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoFocus aria-label={`输入 ${user.username} 确认删除`} /></label><div><button type="button" className="button button-small button-quiet" onClick={() => { setDeleteUserId(null); setDeleteConfirmation(""); }} disabled={busyAction !== null}>取消</button><button type="button" className="button button-small button-danger" onClick={() => remove(user)} disabled={busyAction !== null || deleteConfirmation !== user.username}><Trash2 size={13} />{busyAction === `delete:${user.id}` ? "删除中" : "永久删除"}</button></div></div>}
          </div>
          <div className="admin-user-actions">
            <button type="button" className="button button-small button-quiet" onClick={() => toggle(user)} disabled={busyAction !== null}>{user.status === "ACTIVE" ? "停用" : "启用"}</button>
            <button type="button" className="button button-small button-quiet" onClick={() => setResetUserId((current) => current === user.id ? null : user.id)} disabled={busyAction !== null}>{resetUserId === user.id ? "收起" : "重置密码"}</button>
            <button type="button" className="button button-small button-danger" onClick={() => { setDeleteUserId(user.id); setDeleteConfirmation(""); setResetUserId(null); }} disabled={busyAction !== null || deleteUserId === user.id}><Trash2 size={13} />删除</button>
          </div>
        </div>;
      }) : <EmptyState label="还没有桌面用户" />}
    </section>
  </>;
}

function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [account, setAccount] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account.trim() || !password.trim()) {
      setError("请输入管理账号和密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = await adminLogin(account, password);
      window.sessionStorage.setItem("axiom.admin.token", session.token);
      onSignedIn();
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "ADMIN_CREDENTIALS_INVALID" ? "账号或密码不正确" : "管理服务不可用");
    } finally {
      setBusy(false);
    }
  }

  return <div className="admin-login"><div className="admin-login-panel">
    <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><div><strong>axiom</strong><small>admin console</small></div></div>
    <div className="login-heading"><span className="eyebrow"><span className="eyebrow-line" />后台管理</span><h1>进入账号管理</h1><p>管理桌面端账号授权和账号审计日志。</p></div>
    <form onSubmit={submit} className="admin-login-form"><label>管理账号<input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" autoFocus /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>{error && <div className="login-error"><AlertTriangle size={14} />{error}</div>}<button className="button button-primary button-full" type="submit" disabled={busy}><LogIn size={15} />{busy ? "验证中" : "登录管理后台"}</button></form>
    <div className="login-security"><LockKeyhole size={14} /><span>后台不配置用户端连接器、模型或 Skills；生产环境请替换管理凭据。</span></div>
  </div></div>;
}

function AdminOverview({ summary, users, apiAddress, onAccounts, onRefresh, onAudit }: { summary: AdminSummary; users: AdminUser[]; apiAddress: string; onAccounts: () => void; onRefresh: () => void | Promise<void>; onAudit: () => void }) {
  const activeUsers = users.filter((user) => user.status === "ACTIVE").length;
  const disabledUsers = users.filter((user) => user.status === "DISABLED").length;
  const recentUsers = users.slice(0, 6);
  const recentEvents = summary.events.slice(0, 5);
  return <>
    <section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />平台运维</span><h2>账号授权概览</h2><p>统一管理桌面端账号的使用授权和账号操作记录。</p></div><button type="button" className="button button-secondary" onClick={onRefresh}><RefreshCw size={15} />刷新状态</button></section>
    <div className="admin-metrics">
      <AdminMetric icon={<UserRound size={17} />} label="桌面账号" value={String(users.length)} tone="green" detail={`${activeUsers} 个启用 · ${disabledUsers} 个停用`} />
      <AdminMetric icon={<Activity size={17} />} label="已启用" value={String(activeUsers)} tone="blue" detail="可登录桌面端使用" />
      <AdminMetric icon={<LockKeyhole size={17} />} label="已停用" value={String(disabledUsers)} tone="amber" detail="账号已锁定" />
      <AdminMetric icon={<FileKey2 size={17} />} label="审计事件" value={String(summary.auditEvents)} tone="muted" detail="服务端记录" />
    </div>
    <div className="admin-two-col">
      <section className="admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><UserRound size={14} />账号授权</span><h3>桌面端访问状态</h3></div><button type="button" className="text-button" onClick={onAccounts}>管理账号 <ArrowUpRight size={14} /></button></div>{recentUsers.length ? <div className="admin-account-summary-list">{recentUsers.map((user) => <div className="admin-account-summary-row" key={user.id}><span className="summary-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName} · {user.username}</strong><span>{user.status === "ACTIVE" ? "可登录桌面端" : "已锁定，无法登录"}</span></div><span className={`account-status ${user.status === "ACTIVE" ? "active" : "disabled"}`}>{accountStatusLabel(user.status)}</span></div>)}</div> : <EmptyState label="还没有桌面账号" />}</section>
      <section className="admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><Database size={14} />服务状态</span><h3>管理服务健康</h3></div><span className={`service-health ${summary.persistence.available ? "ready" : "offline"}`}><span />{summary.persistence.available ? "正常" : "不可用"}</span></div><div className="admin-service-list"><div className="admin-service-row"><span className="service-icon green"><ShieldCheck size={15} /></span><div><strong>管理 API</strong><span>{apiAddress}</span></div><b>在线</b></div><div className="admin-service-row"><span className="service-icon blue"><Database size={15} /></span><div><strong>持久化数据库</strong><span>{summary.persistence.detail || summary.persistence.mode}</span></div><b className={summary.persistence.available ? "ok" : "warn"}>{summary.persistence.available ? "已连接" : "待连接"}</b></div></div><div className="health-note"><ShieldCheck size={14} /><span>后台只维护账号授权，不读取或管理用户的任务、连接器、模型密钥和 Skills。</span></div></section>
    </div>
    <section className="admin-panel admin-recent"><div className="admin-panel-head"><div><span className="panel-kicker"><History size={14} />最近活动</span><h3>审计事件</h3></div><button type="button" className="text-button" onClick={onAudit}>打开日志 <ArrowUpRight size={14} /></button></div>{recentEvents.length ? recentEvents.map((event) => <AuditLine event={event} key={event.id} />) : <EmptyState label="暂无审计事件" />}</section>
  </>;
}

function AdminMetric({ icon, label, value, tone, detail }: { icon: ReactNode; label: string; value: string; tone: string; detail: string }) {
  return <div className="admin-metric"><span className={`summary-icon ${tone}`}>{icon}</span><div><span>{label}</span><strong className="tabular">{value}</strong><small>{detail}</small></div></div>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state"><CheckCircle2 size={16} />{label}</div>;
}

function AdminAudit({ events }: { events: EventItem[] }) {
  const [type, setType] = useState("all");
  const [range, setRange] = useState("24h");
  const [selected, setSelected] = useState<EventItem | null>(null);
  const types = useMemo(() => [...new Set(events.map((event) => event.type))].sort(), [events]);
  const filtered = useMemo(() => {
    const cutoff = range === "24h" ? Date.now() - 24 * 60 * 60 * 1000 : range === "7d" ? Date.now() - 7 * 24 * 60 * 60 * 1000 : 0;
    return events.filter((event) => (type === "all" || event.type === type) && new Date(event.createdAt).getTime() >= cutoff);
  }, [events, range, type]);

  function exportAudit() {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `axiom-audit-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <>
    <section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />可追溯性</span><h2>审计日志</h2><p>仅记录账号登录、创建、启停、改密和删除等账号治理事件。</p></div><button type="button" className="button button-secondary" onClick={exportAudit}><FileText size={15} />导出日志</button></section>
    <section className="admin-panel audit-admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><FileKey2 size={14} />事件流</span><h3>{filtered.length} 条记录</h3></div><div className="audit-filters"><select className="select-like" value={type} onChange={(event) => setType(event.target.value)} aria-label="按类型筛选"><option value="all">全部类型</option>{types.map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="select-like" value={range} onChange={(event) => setRange(event.target.value)} aria-label="按时间筛选"><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部时间</option></select></div></div><div className="admin-audit-list">{filtered.length ? filtered.map((event) => <AuditLine event={event} detailed key={event.id} onOpen={setSelected} />) : <EmptyState label="暂无匹配审计事件" />}</div>{selected && <div className="audit-detail"><div><strong>{selected.message}</strong><span>{selected.type} · {selected.createdAt}</span></div><button type="button" className="admin-icon" onClick={() => setSelected(null)} aria-label="关闭事件详情"><X size={14} /></button><pre>{JSON.stringify(selected.metadata, null, 2)}</pre></div>}</section>
  </>;
}

function AuditLine({ event, detailed = false, onOpen }: { event: EventItem; detailed?: boolean; onOpen?: (event: EventItem) => void }) {
  const tone = event.type.includes("risk") || event.type.includes("blocked") ? "amber" : event.type.includes("decision") || event.type.includes("analysis") ? "blue" : "muted";
  return <div className={`audit-line ${detailed ? "detailed" : ""}`}><span className={`event-dot ${tone}`}><span /></span><span className="audit-time tabular">{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><div><strong>{event.message}</strong><span>{event.type} · 服务端审计</span></div>{detailed && <code>{event.id}</code>}{onOpen && <button type="button" className="admin-icon" onClick={() => onOpen(event)} aria-label="查看事件详情"><ArrowUpRight size={14} /></button>}</div>;
}
