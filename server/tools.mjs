import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { adapterCanLogin, getConnectorAdapter } from "./connectors.mjs";
import { getBrowserPage, openBrowserPage, readVisiblePage } from "./browser.mjs";
import { getCredential, initVault } from "./vault.mjs";

function valuesFromEnv(name, fallback) {
  const value = process.env[name];
  return new Set((value ? value.split(",") : fallback).map((item) => item.trim()).filter(Boolean));
}

function isAllowedDomain(value) {
  let hostname;
  try { hostname = new URL(value).hostname; } catch { return false; }
  const domains = valuesFromEnv("BROWSER_ALLOWED_DOMAINS", ["localhost", "127.0.0.1", "smyw.haohandahan.cn"]);
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isLoginUrl(value) {
  return /#\/login(?:[/?#]|$)/i.test(String(value || ""));
}

function hostnameOf(value) {
  try { return new URL(String(value || "")).hostname; } catch { return ""; }
}

async function pageHasSessionAuth(page, adapter) {
  const keys = Array.isArray(adapter?.login?.sessionStorageKeys) ? adapter.login.sessionStorageKeys.map(String).filter(Boolean) : [];
  if (!keys.length || typeof page.evaluate !== "function") return false;
  try {
    return await page.evaluate((requiredKeys) => requiredKeys.every((key) => String(sessionStorage.getItem(key) || "").trim()), keys);
  } catch {
    return false;
  }
}

async function pageHasLoginSuccess(page, adapter) {
  if (!page || !adapter?.login) return false;
  const currentUrl = page.url();
  if (isLoginUrl(currentUrl)) return false;
  if (adapter.login.successUrlPattern && new RegExp(adapter.login.successUrlPattern, "i").test(currentUrl)) return true;
  if (adapter.login.successSelector) {
    try {
      if (await page.locator(adapter.login.successSelector).first().isVisible({ timeout: 800 })) return true;
    } catch {}
  }
  if (adapter.login.successTextPattern) {
    try {
      const text = await page.locator("body").innerText({ timeout: 800 });
      if (new RegExp(adapter.login.successTextPattern, "i").test(text)) return true;
    } catch {}
  }
  return pageHasSessionAuth(page, adapter);
}

async function prepareLoginForm(page, adapter) {
  const selector = String(adapter?.login?.consentSelector || "").trim();
  if (!selector) return;
  const consent = page.locator(selector).first();
  if (await consent.count() < 1) return;
  let checked = false;
  try { checked = await consent.isChecked({ timeout: 1200 }); } catch {}
  if (checked) return;
  try {
    await consent.evaluate((element) => element.click());
  } catch {}
  try { checked = await consent.isChecked({ timeout: 1200 }); } catch {}
  if (checked) return;
  const visibleControl = consent.locator("xpath=ancestor::*[self::label or @role='checkbox'][1]").locator(".el-checkbox__inner, [role='checkbox']").first();
  try {
    if (await visibleControl.count() > 0) await visibleControl.click({ timeout: 1500 });
  } catch {}
  try { checked = await consent.isChecked({ timeout: 1200 }); } catch {}
  if (!checked) throw new Error("LOGIN_CONSENT_REQUIRED");
}

async function loginErrorText(page, adapter) {
  const selectors = Array.isArray(adapter?.login?.errorSelectors) && adapter.login.errorSelectors.length
    ? adapter.login.errorSelectors
    : [".el-form-item__error", ".el-message", ".el-notification", '[role="alert"]'];
  const messages = [];
  for (const selector of selectors) {
    try {
      const values = await page.locator(selector).allTextContents();
      for (const value of values) {
        const normalized = String(value || "").replace(/\s+/g, " ").trim();
        if (normalized && !messages.includes(normalized)) messages.push(normalized);
      }
    } catch {}
  }
  return messages.join("；").slice(0, 240);
}

function targetUrlForCredential(credential, requestedUrl = "") {
  const value = String(requestedUrl || credential?.target?.url || "").trim();
  if (!value || isLoginUrl(value)) return "";
  try {
    const parsed = new URL(value);
    if (!isAllowedDomain(parsed.toString())) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

async function navigateAfterLogin(page, adapter, credential, requestedUrl = "") {
  const targetUrl = targetUrlForCredential(credential, requestedUrl);
  if (!targetUrl || hostnameOf(targetUrl) !== hostnameOf(page.url())) return { targetUrl: "", targetReached: false };
  await page.waitForTimeout(1200);
  try { await page.waitForLoadState("domcontentloaded", { timeout: 3000 }); } catch {}
  try {
    if (safeUrl(page.url()) !== safeUrl(targetUrl)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
    }
  } catch {}
  const entry = adapter?.login?.postLoginEntry;
  const reachedPattern = entry?.urlPattern && new RegExp(entry.urlPattern, "i").test(page.url());
  if (!reachedPattern && entry?.selector && entry?.text) {
    const menu = page.locator(entry.selector).filter({ hasText: entry.text }).first();
    try {
      if (await menu.count() > 0) {
        await menu.click({ force: true, timeout: 2500 });
        await page.waitForTimeout(1200);
      }
    } catch {}
  }
  return { targetUrl, targetReached: Boolean(entry?.urlPattern ? new RegExp(entry.urlPattern, "i").test(page.url()) : safeUrl(page.url()) === safeUrl(targetUrl)) };
}

export async function browserLoginStatus({ sessionId = "default", adapterId = "" } = {}) {
  const page = await getBrowserPage(sessionId);
  const adapter = getConnectorAdapter(adapterId);
  if (!page || !adapter) return { ok: false, authenticated: false, code: "BROWSER_SESSION_NOT_FOUND" };
  let matchesTarget = false;
  try { matchesTarget = Boolean(adapter.match({ type: adapter.type, url: page.url() })); } catch {}
  if (!matchesTarget) return { ok: false, authenticated: false, code: "LOGIN_TARGET_MISMATCH", url: page.url() };
  return { ok: true, authenticated: await pageHasLoginSuccess(page, adapter), url: page.url() };
}

export async function browserNavigate({ url, sessionId = "default" }) {
  if (!isAllowedDomain(url)) return { ok: false, code: "DOMAIN_NOT_ALLOWED", message: "目标域名不在浏览器白名单中" };
  return openBrowserPage({ url, sessionId });
}

export async function browserExtract({ sessionId = "default", selector = "body" }) {
  const snapshot = await readVisiblePage(sessionId);
  if (!snapshot.ok) return snapshot;
  try {
    if (selector === "body") return { ...snapshot, selector, text: snapshot.visibleText.slice(0, 12000), capturedAt: new Date(snapshot.capturedAt).toISOString() };
    const page = await getBrowserPage(sessionId);
    if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
    const text = await page.locator(selector).innerText({ timeout: 10000 });
    return { ok: true, sessionId, selector, text: String(text).slice(0, 12000), capturedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, code: "EXTRACT_FAILED", message: error.message };
  }
}

export async function browserLogin({ sessionId = "default", credentialRef, adapterId, targetUrl = "", ownerUserId = "", ownerUserIds = [], automationAuthorized = true, submit = true }) {
  if (!credentialRef) return { ok: false, code: "CREDENTIAL_REF_REQUIRED", message: "登录必须引用托管凭据，不能传入明文密码" };
  await initVault();
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
  const credential = getCredential(credentialRef, { ownerUserId, ownerUserIds });
  if (!credential) return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND", message: "托管凭据不存在或无法解密" };
  const resolvedAdapterId = adapterId || credential?.target?.adapterId;
  const adapter = getConnectorAdapter(resolvedAdapterId);
  if (!adapterCanLogin(resolvedAdapterId) || adapter.reviewStatus !== "APPROVED") return { ok: false, code: "LOGIN_FLOW_REQUIRES_TARGET_ADAPTER", message: "目标站点登录字段需要已审核的连接器适配器", adapterId: resolvedAdapterId || "" };
  const currentUrl = page.url();
  let adapterMatchesCurrentPage = false;
  try { adapterMatchesCurrentPage = Boolean(adapter.match({ type: "website", url: currentUrl })); } catch {}
  if (!adapterMatchesCurrentPage) return { ok: false, code: "LOGIN_TARGET_MISMATCH", message: "当前浏览器页面与连接器适配器目标不一致", adapterId: adapter.id, url: currentUrl };
  if (credential?.target?.url) {
    try {
      if (new URL(currentUrl).hostname !== new URL(credential.target.url).hostname) return { ok: false, code: "CREDENTIAL_TARGET_MISMATCH", message: "凭据目标与当前浏览器页面不一致" };
    } catch { return { ok: false, code: "CREDENTIAL_TARGET_INVALID", message: "凭据目标地址无效" }; }
  }
  try {
    await page.locator(adapter.login.usernameSelector).first().fill(credential.username);
    await page.locator(adapter.login.passwordSelector).first().fill(credential.password);
    await prepareLoginForm(page, adapter);
    if (submit === false) return { ok: true, credentialRef, adapterId: adapter.id, authenticated: false, requiresApproval: false, code: "LOGIN_FILLED_NOT_SUBMITTED", url: currentUrl };
    await page.locator(adapter.login.submitSelector).first().click();
    const deadline = Date.now() + Math.max(5000, Number(adapter.login.successTimeoutMs) || 20000);
    let authenticated = false;
    while (Date.now() < deadline) {
      authenticated = await pageHasLoginSuccess(page, adapter);
      if (authenticated) break;
      await page.waitForTimeout(250);
    }
    if (!authenticated) {
      const detail = await loginErrorText(page, adapter);
      return { ok: false, code: "LOGIN_NOT_CONFIRMED", message: detail ? `登录提交后仍未确认：${detail}` : "登录提交后未确认进入目标页面", credentialRef, adapterId: adapter.id, url: page.url() };
    }
    const navigation = await navigateAfterLogin(page, adapter, credential, targetUrl);
    return { ok: true, credentialRef, adapterId: adapter.id, authenticated: true, url: page.url(), ...navigation };
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
    description: "Fill and submit a connector-specific login using a credential reference; never accepts plaintext passwords. Set submit=false for fill-only.",
    inputSchema: { type: "object", required: ["credentialRef"], properties: { sessionId: { type: "string" }, credentialRef: { type: "string" }, adapterId: { type: "string" }, submit: { type: "boolean", default: true } } },
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

export const FORBIDDEN_TRADE_CONTROL = /买入订立|卖出转让|确认买入|确认卖出|立即下单|提交委托|下单/;

export function isForbiddenTradeControl(text) {
  return FORBIDDEN_TRADE_CONTROL.test(String(text || "").replace(/\s+/g, ""));
}

export function suggestionFormLabels(action) {
  return action === "SELL"
    ? { price: "卖价", quantity: "卖量" }
    : { price: "买价", quantity: "买量" };
}

export async function fillSuggestionForm({ sessionId = "default", action, price, quantity } = {}) {
  if (action !== "BUY" && action !== "SELL") {
    return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false, fields: [] };
  }
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false, fields: [] };
  const labels = suggestionFormLabels(action);
  try {
    const result = await page.evaluate(({ labels: fieldLabels, priceValue, quantityValue }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, "");
      const forbidden = /买入订立|卖出转让|确认买入|确认卖出|立即下单|提交委托/;
      function findInput(labelText) {
        const nodes = Array.from(document.querySelectorAll("label, span, div, p, th, td, strong, b"));
        const match = nodes.find((node) => {
          const text = normalize(node.textContent);
          return text === normalize(labelText) || text.startsWith(normalize(labelText));
        });
        if (!match) return null;
        const container = match.closest(".el-form-item, .el-input, li, tr, label, .form-item") || match.parentElement;
        return container?.querySelector("input:not([type='checkbox']):not([type='radio']):not([type='hidden'])") || null;
      }
      function assignValue(input, value) {
        if (!input || value == null) return false;
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        descriptor?.set?.call(input, String(value));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      const filled = [];
      if (assignValue(findInput(fieldLabels.price), priceValue)) filled.push(fieldLabels.price);
      if (assignValue(findInput(fieldLabels.quantity), quantityValue)) filled.push(fieldLabels.quantity);
      const forbiddenButtons = Array.from(document.querySelectorAll("button, [role='button'], a")).
        filter((node) => forbidden.test(normalize(node.textContent))).
        map((node) => normalize(node.textContent));
      return { filled, forbiddenButtons, submitted: false };
    }, { labels, priceValue: price, quantityValue: quantity });
    return {
      ok: result.filled.length > 0,
      code: result.filled.length ? "FORM_FILLED_NOT_SUBMITTED" : "FORM_FIELDS_NOT_FOUND",
      filled: result.filled.length > 0,
      submitted: false,
      fields: result.filled,
      forbiddenButtons: result.forbiddenButtons || [],
    };
  } catch (error) {
    return { ok: false, code: "FORM_FILL_FAILED", message: error.message, filled: false, submitted: false, fields: [] };
  }
}

export async function submitSuggestionForm({ sessionId = "default", action, price, quantity } = {}) {
  if (action !== "BUY" && action !== "SELL") {
    return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false };
  }
  if (price == null || quantity == null || !Number(quantity)) {
    return { ok: false, code: "ORDER_PREVIEW_INCOMPLETE", message: "缺少建议价格或数量，无法下单", filled: false, submitted: false };
  }
  const filled = await fillSuggestionForm({ sessionId, action, price, quantity });
  if (!filled.ok) return { ...filled, submitted: false };
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: filled.filled, submitted: false };
  const submitLabel = action === "SELL" ? "卖出转让" : "买入订立";
  try {
    const writeWait = page.waitForResponse((response) => {
      try {
        return /\/intraday-trade\/trade\/(make|marketTake)/.test(response.url());
      } catch {
        return false;
      }
    }, { timeout: 12000 }).catch(() => null);
    const clicked = await page.evaluate(({ buttonLabel }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, "");
      function acceptAgreement() {
        const nodes = Array.from(document.querySelectorAll("label, span, div, p"));
        const match = nodes.find((node) => /订单商品销售协议|我已同意签署/.test(node.textContent || ""));
        if (!match) return false;
        const root = match.closest("label") || match.closest(".el-checkbox") || match;
        const input = root.querySelector?.("input[type='checkbox']") || root.parentElement?.querySelector?.("input[type='checkbox']");
        if (input && !input.checked) {
          input.click();
          if (typeof root.click === "function") root.click();
          return true;
        }
        if (input?.checked) return true;
        if (typeof root.click === "function") root.click();
        return true;
      }
      acceptAgreement();
      const button = Array.from(document.querySelectorAll("button, [role='button'], a")).find((node) => {
        const text = normalize(node.textContent);
        return text.includes(normalize(buttonLabel)) && !node.disabled;
      });
      if (!button) return { clicked: false, reason: "SUBMIT_BUTTON_NOT_FOUND" };
      button.click();
      return { clicked: true, label: normalize(button.textContent) };
    }, { buttonLabel: submitLabel });
    if (!clicked.clicked) {
      return { ok: false, code: clicked.reason || "SUBMIT_BUTTON_NOT_FOUND", message: "目标页未找到下单按钮", filled: true, submitted: false };
    }
    const response = await writeWait;
    let responseOk = null;
    if (response) {
      responseOk = response.ok();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pageHint = await page.evaluate(() => {
      const toast = document.querySelector(".el-message, .el-notification__content, .el-message-box__message");
      return String(toast?.textContent || "").trim();
    });
    if (responseOk === false || /失败|不足|错误|拒绝/.test(pageHint)) {
      return { ok: false, code: "TRADE_REJECTED", message: pageHint || "交易所拒绝下单", filled: true, submitted: true, responseOk };
    }
    return {
      ok: true,
      code: response ? "TRADE_SUBMITTED" : "TRADE_CLICKED",
      message: pageHint || (response ? "已提交交易请求" : "已点击下单按钮"),
      filled: true,
      submitted: true,
      responseOk,
    };
  } catch (error) {
    return { ok: false, code: "TRADE_SUBMIT_FAILED", message: error.message, filled: true, submitted: false };
  }
}

export async function callTool(name, input) {
  if (name === "browser_navigate") return browserNavigate(input || {});
  if (name === "browser_extract_text") return browserExtract(input || {});
  if (name === "browser_login") return browserLogin(input || {});
  if (name === "browser_fill_suggestion") return fillSuggestionForm(input || {});
  if (name === "desktop_open_app") return openDesktopApp(input || {});
  if (name === "desktop_discover_app") return desktopDiscover(input || {});
  if (name === "shell_run") return runShell(input || {});
  return { ok: false, code: "TOOL_NOT_FOUND", message: `未知工具：${name}` };
}
