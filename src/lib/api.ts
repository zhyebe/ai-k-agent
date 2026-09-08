import { demoWorkspace } from "../data/demo";
import type { Provider, Skill, Task, Workspace } from "../types";

const apiBaseUrl = window.axiomDesktop?.apiBaseUrl || "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const adminToken = window.sessionStorage.getItem("axiom.admin.token");
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(adminToken ? { "x-admin-token": adminToken } : {}), ...(options?.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
  return response.json() as Promise<T>;
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

export async function loadWorkspace(): Promise<Workspace> {
  try {
    return await fetchWorkspace();
  } catch {
    return demoWorkspace;
  }
}

export async function fetchWorkspace(): Promise<Workspace> {
  return request<Workspace>("/api/workspace");
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

export async function testConnector(payload: Record<string, unknown>) {
  return request<{ ok: boolean; connectorId: string; adapterId: string; adapterVersion: string; connectionStatus: string; loginStatus: string; credentialStatus: string; credentialRef: string; accountLabel: string; capabilities: string[]; executionModes: string[] }>("/api/connectors/test", { method: "POST", body: JSON.stringify(payload) });
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
