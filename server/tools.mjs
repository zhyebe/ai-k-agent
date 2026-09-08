import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { adapterCanLogin, getConnectorAdapter } from "./connectors.mjs";
import { getCredential, initVault } from "./vault.mjs";

const browserSessions = new Map();

function valuesFromEnv(name, fallback) {
  const value = process.env[name];
  return new Set((value ? value.split(",") : fallback).map((item) => item.trim()).filter(Boolean));
}

function isAllowedDomain(value) {
  let hostname;
  try { hostname = new URL(value).hostname; } catch { return false; }
  const domains = valuesFromEnv("BROWSER_ALLOWED_DOMAINS", ["localhost", "127.0.0.1"]);
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export async function browserNavigate({ url, sessionId = "default" }) {
  if (!isAllowedDomain(url)) return { ok: false, code: "DOMAIN_NOT_ALLOWED", message: "目标域名不在浏览器白名单中" };
  try {
    const { chromium } = await import("playwright");
    let session = browserSessions.get(sessionId);
    if (!session) {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      session = { browser, page: await context.newPage() };
      browserSessions.set(sessionId, session);
    }
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return { ok: true, sessionId, url: session.page.url(), title: await session.page.title() };
  } catch (error) {
    return { ok: false, code: "BROWSER_RUNTIME_UNAVAILABLE", message: error.message, hint: "安装 Playwright 浏览器运行时后重试" };
  }
}

export async function browserExtract({ sessionId = "default", selector = "body" }) {
  const session = browserSessions.get(sessionId);
  if (!session) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
  try {
    const text = await session.page.locator(selector).innerText({ timeout: 10000 });
    return { ok: true, sessionId, selector, text: text.slice(0, 12000), capturedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, code: "EXTRACT_FAILED", message: error.message };
  }
}

export async function browserLogin({ sessionId = "default", credentialRef, adapterId }) {
  if (!credentialRef) return { ok: false, code: "CREDENTIAL_REF_REQUIRED", message: "登录必须引用托管凭据，不能传入明文密码" };
  await initVault();
  const session = browserSessions.get(sessionId);
  if (!session) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
  const credential = getCredential(credentialRef);
  if (!credential && credentialRef !== "credential:demo") return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND", message: "托管凭据不存在或无法解密" };
  const resolvedAdapterId = adapterId || credential?.target?.adapterId;
  const adapter = getConnectorAdapter(resolvedAdapterId);
  if (!adapterCanLogin(resolvedAdapterId) || adapter.reviewStatus !== "APPROVED") return { ok: false, code: "LOGIN_FLOW_REQUIRES_TARGET_ADAPTER", message: "目标站点登录字段需要已审核的连接器适配器", adapterId: resolvedAdapterId || "" };
  const currentUrl = session.page.url();
  let adapterMatchesCurrentPage = false;
  try { adapterMatchesCurrentPage = Boolean(adapter.match({ type: "website", url: currentUrl })); } catch {}
  if (!adapterMatchesCurrentPage) return { ok: false, code: "LOGIN_TARGET_MISMATCH", message: "当前浏览器页面与连接器适配器目标不一致", adapterId: adapter.id, url: currentUrl };
  if (credential?.target?.url) {
    try {
      if (new URL(currentUrl).hostname !== new URL(credential.target.url).hostname) return { ok: false, code: "CREDENTIAL_TARGET_MISMATCH", message: "凭据目标与当前浏览器页面不一致" };
    } catch { return { ok: false, code: "CREDENTIAL_TARGET_INVALID", message: "凭据目标地址无效" }; }
  }
  try {
    const username = credential?.username || "demo";
    const password = credential?.password || "demo";
    await session.page.locator(adapter.login.usernameSelector).fill(username);
    await session.page.locator(adapter.login.passwordSelector).fill(password);
    await session.page.locator(adapter.login.submitSelector).click();
    if (adapter.login.successSelector) await session.page.locator(adapter.login.successSelector).waitFor({ state: "visible", timeout: 10000 });
    return { ok: true, credentialRef, adapterId: adapter.id, authenticated: true, url: session.page.url() };
  } catch (error) {
    return { ok: false, code: "LOGIN_FAILED", message: error.message, credentialRef, adapterId: adapter.id };
  }
}

function runProcess(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, env: { ...process.env, AXIOM_TOOL: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, code: "COMMAND_TIMEOUT", stdout, stderr, exitCode: null });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, code: "COMMAND_FAILED", message: error.message, stdout, stderr }); });
    child.on("close", (exitCode) => { clearTimeout(timer); resolve({ ok: exitCode === 0, exitCode, stdout: stdout.slice(0, 12000), stderr: stderr.slice(0, 12000) }); });
  });
}

export async function runShell({ command, args = [], cwd = process.cwd(), approved = false, timeoutMs = 15000 }) {
  const allowed = valuesFromEnv("SHELL_ALLOWED_COMMANDS", ["pwd", "ls", "rg", "node", "npm", "docker", "bash", "sh"]);
  if (!allowed.has(command)) return { ok: false, code: "COMMAND_NOT_ALLOWED", message: `命令不在白名单：${command}`, allowed: [...allowed] };
  if (!approved) return { ok: false, code: "APPROVAL_REQUIRED", requiresApproval: true, message: "本地命令需要用户确认后执行" };
  const resolvedCwd = path.resolve(cwd);
  const allowedCwds = [...valuesFromEnv("SHELL_ALLOWED_CWDS", [process.env.AXIOM_WORKSPACE || process.cwd()])].map((item) => path.resolve(item));
  const cwdAllowed = allowedCwds.some((root) => resolvedCwd === root || resolvedCwd.startsWith(`${root}${path.sep}`));
  if (!cwdAllowed) return { ok: false, code: "CWD_NOT_ALLOWED", message: "工作目录不在 Shell 白名单中" };
  return runProcess(command, Array.isArray(args) ? args.map(String) : [], resolvedCwd, Math.min(60000, Number(timeoutMs) || 15000));
}

function allowedDesktopPath(value) {
  const resolved = path.resolve(value);
  const configured = [...valuesFromEnv("DESKTOP_ALLOWED_PATHS", [
    process.platform === "darwin" ? "/Applications" : process.platform === "win32" ? "C:\\Program Files" : "/usr/share/applications",
    process.platform === "darwin" ? path.join(os.homedir(), "Applications") : process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"),
  ])].map((item) => path.resolve(item));
  return configured.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function desktopDiscover({ installPath = "", appId = "" }) {
  const target = String(installPath || appId || "").trim();
  if (!target) return { ok: false, code: "INSTALL_PATH_REQUIRED", message: "需要安装路径或应用标识" };
  const resolved = installPath ? path.resolve(target) : target;
  return { ok: true, target, resolved, exists: installPath ? fs.existsSync(resolved) : null, platform: process.platform, allowed: installPath ? allowedDesktopPath(target) : valuesFromEnv("DESKTOP_ALLOWED_APPS", ["Calculator", "TextEdit", "notepad"]).has(target) };
}

export async function openDesktopApp({ appId, installPath, approved = false }) {
  const target = String(installPath || appId || "").trim();
  if (!target) return { ok: false, code: "APP_ID_REQUIRED", message: "需要应用标识或安装路径" };
  const isPath = Boolean(installPath);
  const allowed = isPath ? allowedDesktopPath(target) : valuesFromEnv("DESKTOP_ALLOWED_APPS", ["Calculator", "TextEdit", "notepad"]).has(target);
  if (!allowed) return { ok: false, code: "APP_NOT_ALLOWED", message: "App 不在白名单中，请配置 DESKTOP_ALLOWED_PATHS 或 DESKTOP_ALLOWED_APPS" };
  if (isPath && !fs.existsSync(path.resolve(target))) return { ok: false, code: "APP_PATH_NOT_FOUND", message: "安装路径不存在" };
  if (!approved) return { ok: false, code: "APPROVAL_REQUIRED", requiresApproval: true, message: "启动桌面 App 需要用户确认" };
  if (process.platform === "darwin") return execute("open", isPath ? [target] : ["-a", target]);
  if (process.platform === "win32") return execute("cmd.exe", ["/c", "start", "", target]);
  return execute("xdg-open", [target]);
}

function execute(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code || 0, stdout, stderr, message: error?.message }));
  });
}

export const toolDefinitions = [
  {
    name: "browser_navigate",
    description: "Navigate controlled browser to an allowlisted URL.",
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" }, sessionId: { type: "string" } } },
  },
  {
    name: "browser_extract_text",
    description: "Extract visible text from a controlled browser session.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" }, selector: { type: "string" } } },
  },
  {
    name: "browser_login",
    description: "Request a connector-specific login using a credential reference; never accepts plaintext passwords.",
    inputSchema: { type: "object", required: ["credentialRef"], properties: { sessionId: { type: "string" }, credentialRef: { type: "string" }, adapterId: { type: "string" } } },
  },
  {
    name: "desktop_open_app",
    description: "Open an allowlisted desktop application or installation path after user approval.",
    inputSchema: { type: "object", properties: { appId: { type: "string" }, installPath: { type: "string" }, approved: { type: "boolean" } } },
  },
  {
    name: "desktop_discover_app",
    description: "Inspect a desktop application path without launching it.",
    inputSchema: { type: "object", properties: { appId: { type: "string" }, installPath: { type: "string" } } },
  },
  {
    name: "shell_run",
    description: "Run an allowlisted local command with argv and explicit approval.",
    inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string" }, args: { type: "array" }, cwd: { type: "string" }, approved: { type: "boolean" } } },
  },
];

export async function callTool(name, input) {
  if (name === "browser_navigate") return browserNavigate(input || {});
  if (name === "browser_extract_text") return browserExtract(input || {});
  if (name === "browser_login") return browserLogin(input || {});
  if (name === "desktop_open_app") return openDesktopApp(input || {});
  if (name === "desktop_discover_app") return desktopDiscover(input || {});
  if (name === "shell_run") return runShell(input || {});
  return { ok: false, code: "TOOL_NOT_FOUND", message: `未知工具：${name}` };
}
