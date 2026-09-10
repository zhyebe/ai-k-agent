import type { AgentOutputLine, AgentRun, EventItem, Provider, Skill, Task, Workspace, WorkspaceUser } from "../types";

const configuredApiBaseUrl = String((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || "").replace(/\/$/, "");
let apiBaseUrl = window.axiomDesktop?.apiBaseUrl || configuredApiBaseUrl;

function normalizeApiBaseUrl(value: string) {
  const input = String(value || "").trim();
  if (!input) throw new Error("API_URL_REQUIRED");
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error("API_URL_INVALID"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("API_URL_INVALID");
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname === "/api" || parsed.pathname.endsWith("/api")) {
    parsed.pathname = parsed.pathname.replace(/\/api\/?$/, "") || "/";
  }
  return parsed.toString().replace(/\/$/, "");
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function configureApiBaseUrl(value: string) {
  const next = normalizeApiBaseUrl(value);
  if (window.axiomDesktop?.api?.setBaseUrl) await window.axiomDesktop.api.setBaseUrl(next);
  if (next !== apiBaseUrl) {
    window.sessionStorage.removeItem("axiom.admin.token");
    window.sessionStorage.removeItem("axiom.user.token");
  }
  apiBaseUrl = next;
  return apiBaseUrl;
}

function authHeaders(): Record<string, string> {
  const adminToken = window.sessionStorage.getItem("axiom.admin.token");
  const userToken = window.sessionStorage.getItem("axiom.user.token");
  return {
    ...(adminToken ? { "x-admin-token": adminToken } : {}),
    ...(userToken ? { "x-user-token": userToken } : {}),
  };
}

const mutatingInFlight = new Map<string, Promise<unknown>>();

function mutationKey(path: string, options?: RequestInit) {
  const method = String(options?.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return "";
  return `${method} ${path} ${typeof options?.body === "string" ? options.body : ""}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const key = mutationKey(path, options);
  const existing = key ? mutatingInFlight.get(key) : undefined;
  if (existing) return existing as Promise<T>;
  const headers = new Headers({ ...authHeaders(), ...(options?.headers || {}) });
  if (options?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const pending = (async () => {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
    return response.json() as Promise<T>;
  })();
  if (key) {
    mutatingInFlight.set(key, pending);
    pending.finally(() => { if (mutatingInFlight.get(key) === pending) mutatingInFlight.delete(key); });
  }
  return pending;
}

export async function fetchApiHealth() {
  return request<{ ok: boolean; service: string; persistence?: { mode: string; available: boolean; detail?: string } }>("/api/health");
}

export async function adminLogin(username: string, password: string) {
  return request<{ token: string; username: string; expiresAt: string }>("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export async function adminSession() {
  return request<{ authenticated: boolean; username: string; expiresAt: string }>("/api/admin/session");
}

export async function adminLogout() {
  return request<{ ok: boolean }>("/api/admin/logout", { method: "POST", body: "{}" });
}

export async function userLogin(username: string, password: string) {
  return request<{ token: string; user: WorkspaceUser; expiresAt: string }>("/api/user/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export async function userSession() {
  return request<{ authenticated: boolean; user: WorkspaceUser; expiresAt: string }>("/api/user/session");
}

export async function userLogout() {
  return request<{ ok: boolean }>("/api/user/logout", { method: "POST", body: "{}" });
}

export async function listAdminUsers() {
  return request<{ users: Array<{ id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] }> }>("/api/admin/users");
}

export type AdminAccount = { id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] };
export type AdminTaskSummary = { id: string; name: string; status: string; assignedUserCount: number; updatedAt?: string };
export type AdminSummary = {
  scope: "accounts_assignments_audit";
  users: number;
  activeUsers: number;
  disabledUsers: number;
  activeTasks: number;
  totalTasks: number;
  assignedTasks: number;
  unassignedTasks: number;
  assignments: number;
  auditEvents: number;
  accounts: AdminAccount[];
  tasks: AdminTaskSummary[];
  events: EventItem[];
  persistence: { mode: string; available: boolean; detail?: string };
};

export async function fetchAdminSummary(): Promise<AdminSummary> {
  return request<AdminSummary>("/api/admin/summary");
}

export async function createAdminUser(payload: Record<string, unknown>) {
  return request<{ user: { id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] } }>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateAdminUser(userId: string, payload: Record<string, unknown>) {
  return request<{ user: { id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] } }>(`/api/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function assignAdminTask(userId: string, taskId: string) {
  return request<{ user: { id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] } }>(`/api/admin/users/${encodeURIComponent(userId)}/tasks`, { method: "POST", body: JSON.stringify({ taskId }) });
}

export async function unassignAdminTask(userId: string, taskId: string) {
  return request<{ user: { id: string; username: string; displayName: string; status: string; assignedTaskIds: string[] } }>(`/api/admin/users/${encodeURIComponent(userId)}/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export async function fetchWorkspace(): Promise<Workspace> {
  return request<Workspace>("/api/workspace");
}

export async function loadWorkspace(): Promise<Workspace> {
  return fetchWorkspace();
}

export async function startTask(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/start`, { method: "POST", body: "{}" })).task;
}

export async function createTask(payload: Record<string, unknown>): Promise<Task> {
  return (await request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(payload) })).task;
}

export async function stopTask(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/stop`, { method: "POST", body: "{}" })).task;
}

export async function claimManual(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/manual`, { method: "POST", body: "{}" })).task;
}

export async function autoJudge(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/auto-judge`, { method: "POST", body: "{}" })).task;
}

export async function setAutoDecision(taskId: string, enabled: boolean, countdownSec?: number): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/auto-decision`, { method: "POST", body: JSON.stringify({ enabled, countdownSec }) })).task;
}

export async function setTaskProvider(taskId: string, providerId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/provider`, { method: "POST", body: JSON.stringify({ providerId }) })).task;
}

export async function setTaskMode(taskId: string, mode: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/mode`, { method: "POST", body: JSON.stringify({ mode }) })).task;
}

export async function confirmPendingAction(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/pending-action/confirm`, { method: "POST", body: "{}" })).task;
}

export async function cancelPendingAction(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/pending-action/cancel`, { method: "POST", body: "{}" })).task;
}

export async function takeoverPendingAction(taskId: string): Promise<Task> {
  return (await request<{ task: Task }>(`/api/tasks/${taskId}/pending-action/takeover`, { method: "POST", body: "{}" })).task;
}

export async function analyzeTask(taskId: string, providerId?: string) {
  return request<{ task: Task; run?: AgentRun; route?: string; output?: AgentOutputLine[]; skipped?: boolean }>(`/api/tasks/${taskId}/analyze`, { method: "POST", body: JSON.stringify(providerId ? { providerId } : {}) });
}

export async function fetchAgentOutput(taskId: string, runId = "") {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return request<{ runs: AgentRun[]; output: AgentOutputLine[] }>(`/api/tasks/${taskId}/agent-output${query}`);
}

export function agentStreamUrl(taskId: string, runId = "") {
  const userToken = window.sessionStorage.getItem("axiom.user.token") || "";
  const params = new URLSearchParams();
  if (runId) params.set("runId", runId);
  if (userToken) params.set("userToken", userToken);
  return `${apiBaseUrl}/api/tasks/${taskId}/agent-stream?${params.toString()}`;
}

export async function testConnector(payload: Record<string, unknown>) {
  return request<{ ok: boolean; connectorId: string; type: "website" | "app"; name: string; target: string; adapterId: string; adapterVersion: string; connectionStatus: string; loginStatus: string; credentialStatus: string; credentialRef: string; accountLabel: string; observedUrl?: string; browserMode?: string; liveExecution: boolean; capabilities: string[]; executionModes: string[] }>("/api/connectors/test", { method: "POST", body: JSON.stringify(payload) });
}

export async function discoverConnector(payload: Record<string, unknown>) {
  return request<{ connectorId: string; type: string; target: string; name: string; adapterId: string; adapterVersion: string; status: string; discoveryStatus: string; adapterStatus: string; reviewStatus: string; capabilities: string[]; actionMapping: string; executionModes: string[]; liveExecution: boolean }>("/api/connectors/discover", { method: "POST", body: JSON.stringify(payload) });
}

export async function saveSkill(payload: Record<string, unknown>): Promise<Skill> {
  return (await request<{ skill: Skill }>("/api/skills", { method: "POST", body: JSON.stringify(payload) })).skill;
}

export async function approveSkill(skillId: string): Promise<Skill> {
  return (await request<{ skill: Skill }>(`/api/skills/${skillId}/approve`, { method: "POST", body: "{}" })).skill;
}

export async function saveProvider(payload: Record<string, unknown>): Promise<Provider> {
  return (await request<{ provider: Provider }>("/api/providers", { method: "POST", body: JSON.stringify(payload) })).provider;
}

export async function testProvider(providerId: string): Promise<Provider> {
  return (await request<{ provider: Provider; verification?: { ok: boolean; code: string; httpStatus?: number } }>(`/api/providers/${providerId}/test`, { method: "POST", body: "{}" })).provider;
}

export async function deleteProvider(providerId: string) {
  return request<{ ok: boolean }>(`/api/providers/${providerId}`, { method: "DELETE" });
}
