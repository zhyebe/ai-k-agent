import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Database,
  FileKey2,
  FileText,
  History,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Upload,
  Waypoints,
  X,
} from "lucide-react";
import { adminLogin, adminLogout, adminSession, approveSkill, fetchWorkspace, loadWorkspace, saveProvider, saveSkill, testProvider } from "./lib/api";
import { demoWorkspace } from "./data/demo";
import type { EventItem, Provider, Skill, Workspace } from "./types";

type AdminTab = "overview" | "knowledge" | "connectors" | "audit";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

export default function AdminApp() {
  const [workspace, setWorkspace] = useState<Workspace>(demoWorkspace);
  const [tab, setTab] = useState<AdminTab>("overview");
  const [signedIn, setSignedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { loadWorkspace().then(setWorkspace); }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => { fetchWorkspace().then((next) => { if (active) setWorkspace(next); }).catch(() => {}); };
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
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

  const reviewCount = workspace.skills.filter((skill) => skill.status === "REVIEW").length;
  const updateSkill = (next: Skill) => setWorkspace((current) => ({ ...current, skills: current.skills.map((skill) => skill.id === next.id ? next : skill) }));
  const updateProvider = (next: Provider) => setWorkspace((current) => ({ ...current, providers: current.providers.map((provider) => provider.id === next.id ? next : provider) }));

  async function handleApprove(skill: Skill) {
    try {
      const next = await approveSkill(skill.id);
      updateSkill(next);
      setToast(`${next.title} 已发布到 RAG`);
    } catch (error) { setToast(`发布失败：${errorMessage(error)}`); }
  }

  async function handleSaveSkill(payload: Record<string, unknown>) {
    try {
      const next = await saveSkill(payload);
      setWorkspace((current) => ({ ...current, skills: [next, ...current.skills] }));
      setToast("草稿已进入审核队列");
    } catch (error) { setToast(`保存失败：${errorMessage(error)}`); }
  }

  async function handleProviderTest(provider: Provider) {
    try {
      const next = await testProvider(provider.id);
      updateProvider(next);
      setToast(`${next.name}：${next.status}`);
    } catch (error) { setToast(`验证失败：${errorMessage(error)}`); }
  }

  async function handleProviderSave(payload: Record<string, unknown>) {
    try {
      const next = await saveProvider(payload);
      setWorkspace((current) => ({ ...current, providers: [...current.providers.filter((provider) => provider.id !== next.id), next] }));
      setToast("Provider 已保存");
    } catch (error) { setToast(`保存失败：${errorMessage(error)}`); }
  }

  async function handleRefresh() {
    const next = await fetchWorkspace();
    setWorkspace(next);
    setToast("状态已刷新");
  }

  async function handleLogout() {
    await adminLogout().catch(() => {});
    window.sessionStorage.removeItem("axiom.admin.token");
    setSignedIn(false);
  }

  const tabs: Array<{ key: AdminTab; label: string; icon: typeof LayoutDashboard }> = [
    { key: "overview", label: "总览", icon: LayoutDashboard },
    { key: "knowledge", label: "知识与审核", icon: BookOpen },
    { key: "connectors", label: "连接器配置", icon: Waypoints },
    { key: "audit", label: "审计日志", icon: History },
  ];

  return <div className="admin-shell"><aside className="admin-sidebar"><div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><div><strong>axiom</strong><small>admin console</small></div></div><div className="admin-role"><ShieldCheck size={15} /><div><b>管理后台</b><span>知识与运行治理</span></div></div><div className="nav-label">管理</div><nav className="admin-nav" aria-label="后台导航">{tabs.map(({ key, label, icon: Icon }) => <button type="button" key={key} className={tab === key ? "nav-item active" : "nav-item"} onClick={() => setTab(key)}><Icon size={17} /><span>{label}</span>{key === "knowledge" && reviewCount > 0 && <em>{reviewCount}</em>}</button>)}</nav><div className="admin-sidebar-foot"><div className="admin-health"><span className="online-dot" /><span>API 服务在线</span><code>127.0.0.1:8787</code></div><button type="button" className="admin-user" onClick={handleLogout} title="退出管理后台"><div className="avatar avatar-small">A</div><div><b>Admin</b><span>退出管理后台</span></div><LogOut size={14} /></button></div></aside><main className="admin-main"><header className="admin-topbar"><div><span className="admin-breadcrumb">Axiom / Admin</span><h1>{tabs.find((item) => item.key === tab)?.label}</h1></div><div className="admin-top-actions"><button type="button" className="admin-link" onClick={() => window.open("/", "_blank", "noopener,noreferrer")}><ArrowUpRight size={14} />打开用户端</button><button type="button" className="admin-icon" onClick={handleLogout} aria-label="退出管理后台" title="退出管理后台"><LogOut size={17} /></button><div className="top-avatar">A</div></div></header><div className="admin-content">{tab === "overview" && <AdminOverview workspace={workspace} onReview={() => setTab("knowledge")} onRefresh={handleRefresh} onConnectors={() => setTab("connectors")} onAudit={() => setTab("audit")} />}{tab === "knowledge" && <AdminKnowledge skills={workspace.skills} onApprove={handleApprove} onSave={handleSaveSkill} />}{tab === "connectors" && <AdminConnectors providers={workspace.providers} onTest={handleProviderTest} onSave={handleProviderSave} />}{tab === "audit" && <AdminAudit events={workspace.events} />}</div></main>{toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button type="button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={14} /></button></div>}</div>;
}

function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) { const [account, setAccount] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); async function submit(event: FormEvent) { event.preventDefault(); if (!account.trim() || !password.trim()) { setError("请输入管理账号和密码"); return; } setBusy(true); setError(""); try { const session = await adminLogin(account, password); window.sessionStorage.setItem("axiom.admin.token", session.token); onSignedIn(); } catch (reason) { setError(reason instanceof Error && reason.message === "ADMIN_CREDENTIALS_INVALID" ? "账号或密码不正确" : "管理服务不可用"); } finally { setBusy(false); } } return <div className="admin-login"><div className="admin-login-panel"><div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><div><strong>axiom</strong><small>admin console</small></div></div><div className="login-heading"><span className="eyebrow"><span className="eyebrow-line" />后台管理</span><h1>进入治理工作台</h1><p>管理 Skills、规则红线、连接器和审计记录。</p></div><form onSubmit={submit} className="admin-login-form"><label>管理账号<input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" autoFocus /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>{error && <div className="login-error"><AlertTriangle size={14} />{error}</div>}<button className="button button-primary button-full" type="submit" disabled={busy}><LogIn size={15} />{busy ? "验证中" : "登录管理后台"}</button></form><div className="login-security"><LockKeyhole size={14} /><span>服务端会话认证；生产环境请替换为企业 SSO。</span></div></div></div>; }

function AdminOverview({ workspace, onReview, onRefresh, onConnectors, onAudit }: { workspace: Workspace; onReview: () => void; onRefresh: () => void | Promise<void>; onConnectors: () => void; onAudit: () => void }) { const review = workspace.skills.filter((skill) => skill.status === "REVIEW"); const active = workspace.tasks.filter((task) => ["MONITORING", "ANALYZING", "EXECUTING"].includes(task.status)).length; return <><section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />治理总览</span><h2>系统状态</h2><p>关注审核队列、连接器健康与运行审计。</p></div><button type="button" className="button button-secondary" onClick={onRefresh}><RefreshCw size={15} />刷新状态</button></section><div className="admin-metrics"><AdminMetric icon={<Activity size={17} />} label="运行中任务" value={String(active)} tone="green" detail="用户端" /><AdminMetric icon={<BookOpen size={17} />} label="待审核 Skills" value={String(review.length)} tone="amber" detail="需要治理" /><AdminMetric icon={<Database size={17} />} label="RAG 索引切片" value={String(workspace.rag?.indexedChunks || 0)} tone="blue" detail="已发布版本" /><AdminMetric icon={<FileKey2 size={17} />} label="审计事件" value={String(workspace.events.length)} tone="muted" detail="最近 24 小时" /></div><div className="admin-two-col"><section className="admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><ShieldCheck size={14} />需要处理</span><h3>审核队列</h3></div><button type="button" className="text-button" onClick={onReview}>查看全部 <ArrowUpRight size={14} /></button></div>{review.length ? review.map((skill) => <div className="review-item" key={skill.id}><span className="review-icon"><FileText size={16} /></span><div><strong>{skill.title}</strong><span>{skill.source} · {skill.kind === "guardrail" ? "红线" : skill.kind === "rule" ? "规则" : "专家经验"}</span></div><span className="review-time">待审核</span></div>) : <EmptyState label="审核队列为空" />}</section><section className="admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><Waypoints size={14} />连接器</span><h3>运行健康</h3></div><button type="button" className="text-button" onClick={onConnectors}>配置 <Settings2 size={14} /></button></div>{workspace.providers.map((provider) => <div className="health-row" key={provider.id}><span className="provider-logo">{provider.name.slice(0, 1)}</span><div><strong>{provider.name}</strong><span>{provider.model}</span></div><span className={`provider-status ${provider.configured ? "configured" : ""}`}><span />{provider.status}</span></div>)}<div className="health-note"><Database size={14} /><span>持久化：{workspace.health?.db || "memory"} · {workspace.health?.dbAvailable ? "可用" : "待连接"}</span></div></section></div><section className="admin-panel admin-recent"><div className="admin-panel-head"><div><span className="panel-kicker"><History size={14} />最近活动</span><h3>审计事件</h3></div><button type="button" className="text-button" onClick={onAudit}>打开日志 <ArrowUpRight size={14} /></button></div>{workspace.events.slice(0, 4).map((event) => <AuditLine event={event} key={event.id} />)}</section></>; }
function AdminMetric({ icon, label, value, tone, detail }: { icon: ReactNode; label: string; value: string; tone: string; detail: string }) { return <div className="admin-metric"><span className={`summary-icon ${tone}`}>{icon}</span><div><span>{label}</span><strong className="tabular">{value}</strong><small>{detail}</small></div></div>; }
function EmptyState({ label }: { label: string }) { return <div className="empty-state"><CheckCircle2 size={16} />{label}</div>; }

function AdminKnowledge({ skills, onApprove, onSave }: { skills: Skill[]; onApprove: (skill: Skill) => void; onSave: (payload: Record<string, unknown>) => void }) { const [content, setContent] = useState(""); const [title, setTitle] = useState(""); const [tags, setTags] = useState("BTC/USDT,15m"); const [filename, setFilename] = useState("管理后台输入"); const [kind, setKind] = useState<Skill["kind"]>("expert"); const [query, setQuery] = useState(""); const [fileError, setFileError] = useState(""); function choose(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setFileError(""); setFilename(file.name); file.text().then(setContent).catch(() => setFileError("文档读取失败，请重试")); if (!title) setTitle(file.name.replace(/\.[^.]+$/, "")); } const filtered = useMemo(() => { const value = query.trim().toLowerCase(); return value ? skills.filter((skill) => `${skill.title} ${skill.summary} ${skill.tags.join(" ")}`.toLowerCase().includes(value)) : skills; }, [query, skills]); return <><section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />知识治理</span><h2>Skills 与红线</h2><p>上传或输入专家经验，审核发布后进入 RAG。</p></div><div className="admin-heading-actions"><label className="button button-secondary file-button"><Upload size={15} />上传文档<input type="file" accept=".md,.txt,.markdown,.json" onChange={choose} /></label></div></section><div className="knowledge-layout"><section className="admin-panel ingest-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><Plus size={14} />初始化知识</span><h3>创建草稿</h3></div><span className="draft-label">REVIEW</span></div><div className="admin-form"><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="专家经验或红线名称" /></label><label>知识类型<select value={kind} onChange={(event) => setKind(event.target.value as Skill["kind"])}><option value="expert">专家经验</option><option value="rule">规则</option><option value="guardrail">红线</option></select></label><label>适用标签<input value={tags} onChange={(event) => setTags(event.target.value)} /></label><label>内容<textarea value={content} onChange={(event) => setContent(event.target.value)} rows={10} placeholder="输入触发条件、建议动作、禁止动作、失效条件和证据来源..." /></label>{fileError && <div className="login-error"><AlertTriangle size={14} />{fileError}</div>}<button type="button" className="button button-primary button-full" disabled={!content.trim()} onClick={() => { onSave({ title: title || filename, content, tags, filename, kind }); setContent(""); setTitle(""); }}><FileText size={15} />保存待审核草稿</button></div><div className="ingest-note"><ShieldCheck size={14} /><span>草稿不会影响自动执行；发布时自动切片并更新索引版本。</span></div></section><section className="admin-panel knowledge-list"><div className="admin-panel-head"><div><span className="panel-kicker"><BookOpen size={14} />版本列表</span><h3>已导入内容</h3></div><div className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选" aria-label="筛选 Skills" /></div></div><div className="admin-skill-list">{filtered.length ? filtered.map((skill) => <div className="admin-skill-row" key={skill.id}><span className={`skill-file ${skill.kind}`}><FileText size={16} /></span><div className="admin-skill-copy"><strong>{skill.title}</strong><span>{skill.summary}</span><small>{skill.source} · {skill.version} · {skill.chunks} chunks</small></div>{skill.status === "APPROVED" ? <span className="approval-label"><CheckCircle2 size={14} />已发布</span> : <button type="button" className="button button-small button-review" onClick={() => onApprove(skill)}><ShieldCheck size={13} />审核发布</button>}<button type="button" className="admin-icon" aria-label={`打开 ${skill.title}`} title={`打开 ${skill.title}`}><ArrowUpRight size={15} /></button></div>) : <EmptyState label="没有匹配的 Skill" />}</div></section></div></>; }

function AdminConnectors({ providers, onTest, onSave }: { providers: Provider[]; onTest: (provider: Provider) => void; onSave: (payload: Record<string, unknown>) => void }) { const [open, setOpen] = useState(false); const [name, setName] = useState("自定义 Provider"); const [baseUrl, setBaseUrl] = useState(""); const [model, setModel] = useState(""); const [apiKey, setApiKey] = useState(""); return <><section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />接入治理</span><h2>连接器与 Provider</h2><p>管理目标连接、模型 Endpoint 和服务端密钥。</p></div><button type="button" className="button button-primary" onClick={() => setOpen((value) => !value)}><Plus size={15} />添加 Provider</button></section><section className="admin-panel connector-admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><KeyRound size={14} />AI Provider</span><h3>已配置服务</h3></div><span className="secure-label"><LockKeyhole size={13} />密钥脱敏</span></div><div className="admin-provider-list">{providers.map((provider) => <div className="admin-provider-row" key={provider.id}><span className="provider-logo">{provider.name.slice(0, 1)}</span><div><strong>{provider.name}</strong><span>{provider.baseUrl || "未设置 Endpoint"} · {provider.model}</span></div><span className="key-preview"><KeyRound size={13} />{provider.keyPreview}</span><span className={`provider-status ${provider.configured ? "configured" : ""}`}><span />{provider.status}</span><button type="button" className="button button-small button-quiet" onClick={() => onTest(provider)}><RefreshCw size={13} />验证</button></div>)}</div></section>{open && <section className="admin-panel provider-form-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><Plus size={14} />新接入</span><h3>OpenAI Compatible Provider</h3></div><button type="button" className="admin-icon" onClick={() => setOpen(false)} aria-label="关闭表单"><X size={16} /></button></div><form className="admin-form provider-admin-form" onSubmit={(event) => { event.preventDefault(); onSave({ name, baseUrl, model, apiKey }); setOpen(false); }}><div className="admin-form-row"><label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model-name" required /></label></div><label>Endpoint<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" type="url" required /></label><label>API Key<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" /></label><button className="button button-primary" type="submit"><KeyRound size={15} />保存密钥</button></form></section>}</>; }

function AdminAudit({ events }: { events: EventItem[] }) { const [type, setType] = useState("all"); const [range, setRange] = useState("24h"); const [selected, setSelected] = useState<EventItem | null>(null); const types = useMemo(() => [...new Set(events.map((event) => event.type))].sort(), [events]); const filtered = useMemo(() => { const cutoff = range === "24h" ? Date.now() - 24 * 60 * 60 * 1000 : range === "7d" ? Date.now() - 7 * 24 * 60 * 60 * 1000 : 0; return events.filter((event) => (type === "all" || event.type === type) && new Date(event.createdAt).getTime() >= cutoff); }, [events, range, type]); function exportAudit() { const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `axiom-audit-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); } return <><section className="admin-page-heading"><div><span className="eyebrow"><span className="eyebrow-line" />可追溯性</span><h2>审计日志</h2><p>记录知识发布、规则裁决、连接器和任务控制事件。</p></div><button type="button" className="button button-secondary" onClick={exportAudit}><FileText size={15} />导出日志</button></section><section className="admin-panel audit-admin-panel"><div className="admin-panel-head"><div><span className="panel-kicker"><FileKey2 size={14} />事件流</span><h3>{filtered.length} 条记录</h3></div><div className="audit-filters"><select className="select-like" value={type} onChange={(event) => setType(event.target.value)} aria-label="按类型筛选"><option value="all">全部类型</option>{types.map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="select-like" value={range} onChange={(event) => setRange(event.target.value)} aria-label="按时间筛选"><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部时间</option></select></div></div><div className="admin-audit-list">{filtered.length ? filtered.map((event) => <AuditLine event={event} detailed key={event.id} onOpen={setSelected} />) : <EmptyState label="暂无匹配审计事件" />}</div>{selected && <div className="audit-detail"><div><strong>{selected.message}</strong><span>{selected.type} · {selected.createdAt}</span></div><button type="button" className="admin-icon" onClick={() => setSelected(null)} aria-label="关闭事件详情"><X size={14} /></button><pre>{JSON.stringify(selected.metadata, null, 2)}</pre></div>}</section></>; }
function AuditLine({ event, detailed = false, onOpen }: { event: EventItem; detailed?: boolean; onOpen?: (event: EventItem) => void }) { const tone = event.type.includes("risk") || event.type.includes("blocked") ? "amber" : event.type.includes("decision") || event.type.includes("analysis") ? "blue" : "muted"; return <div className={`audit-line ${detailed ? "detailed" : ""}`}><span className={`event-dot ${tone}`}><span /></span><span className="audit-time tabular">{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><div><strong>{event.message}</strong><span>{event.type} · 服务端审计</span></div>{detailed && <code>{event.id}</code>}{onOpen && <button type="button" className="admin-icon" onClick={() => onOpen(event)} aria-label="查看事件详情"><ArrowUpRight size={14} /></button>}</div>; }
