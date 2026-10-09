import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { adapterCanLogin, getConnectorAdapter } from "./connectors.mjs";
import { getBrowserPage, openBrowserPage, readVisiblePage, selectPageBoardInstrument } from "./browser.mjs";
import { getCredential, initVault } from "./vault.mjs";
import { clickPositionTransfer, clickTradeEntry, completeTradeDialogs, fillTradeFields, prepareEntryAgreement, preparePositionRows, prepareTradeEntry } from "./trade-controls.mjs";

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
  const credential = getCredential(credentialRef, { ownerUserId, ownerUserIds });
  if (!credential) return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND", message: "托管凭据不存在或无法解密" };
  return browserLoginWithCredential({ sessionId, credentialRef, adapterId, targetUrl, submit }, credential);
}

// Desktop receives an owner-checked credential for this call only; never persist it locally.
export async function browserLoginWithCredential({ sessionId = "default", credentialRef, adapterId, targetUrl = "", submit = true }, credential) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
  if (!credential) return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND" };
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

export const FORBIDDEN_TRADE_CONTROL = /买入订立|卖出订立|买入转让|卖出转让|确认买入|确认卖出|立即下单|提交委托|下单/;

export function isForbiddenTradeControl(text) {
  return FORBIDDEN_TRADE_CONTROL.test(String(text || "").replace(/\s+/g, ""));
}

export function suggestionFormLabels(action, { exitType } = {}) {
  if (exitType) {
    return action === "BUY"
      ? { price: "买价", quantity: "买量", extras: ["转让价", "转让量", "订立价", "订立量", "价格", "数量"] }
      : { price: "卖价", quantity: "卖量", extras: ["转让价", "转让量", "订立价", "订立量", "价格", "数量"] };
  }
  return action === "SELL"
    ? { price: "卖价", quantity: "卖量", extras: ["订立价", "订立量", "价格", "数量"] }
    : { price: "买价", quantity: "买量", extras: ["订立价", "订立量", "价格", "数量"] };
}

export function tradePaneLabel({ exitType } = {}) {
  return exitType ? "转让" : "订立";
}

export function tradeSubmitLabels({ action, exitType } = {}) {
  if (exitType) return action === "BUY" ? ["买入转让", "买转让"] : ["卖出转让", "卖转让"];
  return action === "SELL" ? ["卖出订立", "卖订立"] : ["买入订立", "买订立"];
}

export function positionListExitLabels({ exitType } = {}) {
  return ["转让"];
}

export function isPositionListExitControlText(text, label) {
  const compact = String(text || "").replace(/\s+/g, "");
  const wanted = String(label || "").replace(/\s+/g, "");
  if (!compact || !wanted) return false;
  if (compact === wanted) return true;
  return false;
}

export function isTradeWriteResponse(url, method) {
  if (String(method || "GET").toUpperCase() !== "POST") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "smyw.haohandahan.cn"
      && /\/intraday-trade\/trade\/(?!cancel(?:All)?(?:\/|$))[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function watchTradeResponse(page) {
  let matched = null;
  const listener = (response) => {
    if (matched || !isTradeWriteResponse(response.url(), response.request?.().method?.())) return;
    matched = response;
  };
  page.on("response", listener);
  return {
    peek: () => matched,
    dispose: () => page.off("response", listener),
  };
}

async function markTradePageHints(page) {
  const token = `${Date.now()}-${Math.random()}`;
  await page.evaluate((value) => {
    for (const node of document.querySelectorAll(".el-message, .el-notification__content, .el-message-box__message")) {
      node.dataset.axiomNoticeBaseline = value;
      node.dataset.axiomNoticeText = String(node.textContent || "").trim();
    }
  }, token);
  return token;
}

async function readTradePageHint(page, baselineToken = "") {
  return page.evaluate((token) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const notices = Array.from(document.querySelectorAll(".el-message, .el-notification__content, .el-message-box__message"));
    return String(notices.find((node) => visible(node) && (!token || node.dataset.axiomNoticeBaseline !== token || node.dataset.axiomNoticeText !== String(node.textContent || "").trim()))?.textContent || "").trim();
  }, baselineToken);
}

function tradePageHintKind(hint) {
  if (/失败|不足|错误|拒绝|无效|未成功/.test(hint)) return "rejected";
  if (/成功|已受理|已提交|提交完成/.test(hint)) return "submitted";
  return "";
}

async function observeTradeFeedback(page, writeResponse, baselineToken) {
  const deadline = Date.now() + 8000;
  let responseAt = null;
  while (Date.now() < deadline) {
    const response = writeResponse.peek();
    if (response && responseAt === null) responseAt = Date.now();
    const hint = await readTradePageHint(page, baselineToken).catch(() => "");
    if (hint && tradePageHintKind(hint)) return { response, pageHint: hint };
    if (responseAt !== null && Date.now() - responseAt >= 1200) return { response, pageHint: "" };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { response: writeResponse.peek(), pageHint: "" };
}

function compactControlLabel(value) {
  return String(value || "").replace(/\s+/g, "").slice(0, 40);
}

export function tradeControlLabels(controls = {}) {
  const labels = [];
  for (const item of [...(controls.buttons || []), ...(controls.fields || []), ...(controls.rowActions || [])]) {
    const label = compactControlLabel(item?.label || item);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function normalizeBrowserPlan(plan, controls = {}, { action = "", exitType = null } = {}) {
  const allowed = tradeControlLabels(controls);
  const allowedSubmitLabels = action && !exitType ? tradeSubmitLabels({ action }) : [];
  const actions = [];
  for (const item of Array.isArray(plan?.actions) ? plan.actions : []) {
    if (actions.length >= 8) break;
    const type = String(item?.type || "").toLowerCase();
    if (type === "accept_agreement") {
      actions.push({ type: "accept_agreement" });
      continue;
    }
    const label = compactControlLabel(item?.label);
    if (!label || !allowed.some((item) => item === label || item.includes(label) || label.includes(item))) continue;
    if (type === "click" && allowedSubmitLabels.includes(label) && !actions.some((action) => action.type === "click")) actions.push({ type: "click", label });
    if (type === "fill") {
      const value = item.value == null ? "" : String(item.value).slice(0, 32);
      if (value) actions.push({ type: "fill", label, value });
    }
  }
  return { ok: actions.length > 0, goal: String(plan?.goal || ""), actions: [...actions.filter((item) => item.type !== "click"), ...actions.filter((item) => item.type === "click")] };
}

export async function readTradeControls({ sessionId = "default", symbol = "", symbolName = "", instrumentId = "", targetPositionIds = [], exitType = null } = {}) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", buttons: [], fields: [], rowActions: [] };
  if (!exitType && !targetPositionIds.length && (symbol || symbolName || instrumentId)) {
    const selected = await selectPageBoardInstrument(sessionId, { symbol: String(symbol || ""), symbolName: String(symbolName || ""), instrumentId: String(instrumentId || "") });
    if (!selected) return { ok: false, code: "TARGET_BOARD_NOT_FOUND", buttons: [], fields: [], rowActions: [] };
  }
  const ids = (Array.isArray(targetPositionIds) ? targetPositionIds : []).map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
  try {
    const snapshot = await page.evaluate(({ targetIds }) => {
      const compact = (value) => String(value || "").replace(/\s+/g, "").slice(0, 40);
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button'], [role='tab'], a, .el-tabs__item, .el-radio-button__inner, .trade_btn, .header_l_item"))
        .filter(visible)
        .map((node) => compact(node.value || node.getAttribute("aria-label") || node.textContent))
        .filter((label) => label.length >= 2 && label.length <= 16)
        .filter((label, index, list) => list.indexOf(label) === index)
        .slice(0, 40)
        .map((label) => ({ label }));
      const fields = Array.from(document.querySelectorAll("label, .el-form-item__label, th, span"))
        .filter(visible)
        .map((node) => compact(node.textContent))
        .filter((label) => /价|量|数量/.test(label) && label.length <= 8)
        .filter((label, index, list) => list.indexOf(label) === index)
        .slice(0, 20)
        .map((label) => ({ label }));
      const rowKey = (value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase();
      const rows = Array.from(document.querySelectorAll("tr, [role='row'], .el-table__row")).filter(visible);
      const rowActions = [];
      for (const row of rows) {
        const cells = [...row.querySelectorAll("td, [role='cell']")].map((cell) => rowKey(cell.textContent));
        if (targetIds.length && !targetIds.some((value) => cells.includes(value))) continue;
        const actions = Array.from(row.querySelectorAll("button, [role='button'], a, span"))
          .filter(visible)
          .map((node) => compact(node.textContent))
          .filter((label) => label === "转让" || label === "止盈" || label === "止损" || compact(label).replace(/[|/]/g, "") === "止盈止损")
          .filter((label, index, list) => list.indexOf(label) === index);
        if (actions.length) rowActions.push(...actions.map((label) => ({ label })));
      }
      return { buttons, fields, rowActions: rowActions.slice(0, 12) };
    }, { targetIds: ids });
    return { ok: true, ...snapshot };
  } catch (error) {
    return { ok: false, code: "TRADE_CONTROLS_READ_FAILED", message: error.message, buttons: [], fields: [], rowActions: [] };
  }
}

export async function fillSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [] } = {}) {
  if (action !== "BUY" && action !== "SELL") return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false, fields: [] };
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false, fields: [] };
  try {
    if (exitType) {
      const rows = await preparePositionRows(page, { action, symbol, symbolName, instrumentId, targetPositionIds });
      return { ok: rows.length > 0, code: rows.length ? "EXIT_POSITION_READY" : "EXIT_POSITION_NOT_FOUND", filled: rows.length > 0, submitted: false, fields: [] };
    }
    if (symbol || symbolName || instrumentId) {
      const selected = await selectPageBoardInstrument(sessionId, { symbol, symbolName, instrumentId });
      if (!selected) return { ok: false, code: "TARGET_BOARD_NOT_FOUND", filled: false, submitted: false, fields: [] };
    }
    await prepareTradeEntry(page, action);
    const labels = suggestionFormLabels(action);
    const fields = await fillTradeFields(page, [
      { labels: [labels.price, ...labels.extras.filter((item) => /价/.test(item))], value: price },
      { labels: [labels.quantity, ...labels.extras.filter((item) => /量/.test(item))], value: quantity },
    ]);
    if (fields.length === 2) await prepareEntryAgreement(page, action);
    return { ok: fields.length === 2, code: fields.length === 2 ? "FORM_FILLED_NOT_SUBMITTED" : "FORM_FIELDS_NOT_FOUND", filled: fields.length === 2, submitted: false, fields };
  } catch (error) {
    return { ok: false, code: "FORM_FILL_FAILED", message: error.message, filled: false, submitted: false, fields: [] };
  }
}

export function tradeSubmissionOutcome({ responseSeen = false, responseOk = null, pageHint = "", clicked = {} } = {}) {
  const detail = String(pageHint || "").trim();
  if (tradePageHintKind(detail) === "rejected") {
    return { ok: false, code: "TRADE_REJECTED", message: detail, filled: true, submitted: true, responseOk };
  }
  if (tradePageHintKind(detail) === "submitted" || (responseSeen && responseOk === true)) {
    return { ok: true, code: "TRADE_SUBMITTED", message: detail || "已提交交易请求，等待持仓对账", filled: true, submitted: true, responseOk, submitLabel: clicked?.label || null };
  }
  return { ok: false, code: "TRADE_SUBMISSION_UNVERIFIED", message: "已点击交易控件，但页面未显示明确结果；需核实订单和持仓", filled: true, submitted: false, uncertain: true, responseOk };
}

export async function continueManualEntry({ sessionId = "default", action } = {}) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND" };
  const dialogs = await page.locator(".el-message-box:visible, .el-dialog:visible, [role='dialog']:visible").allTextContents();
  if (!dialogs.some((text) => /确认下单|确认买入|确认卖出|是否确认|合同|协议/.test(text.replace(/\s+/g, "")))) return { ok: true, continued: false };
  const result = await completeTradeDialogs(page, { baselineToken: await markTradePageHints(page) });
  return { ok: result.ok, continued: result.confirmed === true };
}

export async function submitSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [] } = {}) {
  if (action !== "BUY" && action !== "SELL") return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false };
  if ((!exitType || orderType === "LIMIT") && (price == null || quantity == null || !Number(quantity))) {
    return { ok: false, code: "ORDER_PREVIEW_INCOMPLETE", message: "缺少建议价格或数量，无法下单", filled: false, submitted: false };
  }
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false };
  const target = { action, symbol, symbolName, instrumentId, targetPositionIds };
  const results = [];
  const withCompleted = (result) => {
    const completedPositionIds = results.filter((item) => item.ok).flatMap((item) => item.targetPositionIds);
    if (!completedPositionIds.length) return { ...result, results };
    return { ok: true, code: "TRADE_PARTIALLY_SUBMITTED", message: "部分持仓已提交转让，先核实已提交持仓；剩余持仓继续由 AI 判断", filled: true, submitted: true, completedPositionIds, submittedQuantity: results.filter((item) => item.ok).reduce((sum, item) => sum + Number(item.submittedQuantity || 0), 0), results };
  };
  try {
    let targets = [target];
    if (exitType) {
      const rows = await preparePositionRows(page, target);
      if (!rows.length) return { ok: false, code: "EXIT_POSITION_NOT_FOUND", message: "持仓明细未显示目标持仓，未操作其他持仓", filled: false, submitted: false };
      targets = rows.map((row) => ({ ...target, targetPositionIds: row.id ? [row.id] : [], rowIndex: row.index }));
    } else {
      const filled = await fillSuggestionForm({ sessionId, action, price, quantity, symbol, symbolName, instrumentId });
      if (!filled.ok) return { ...filled, submitted: false };
    }
    for (const positionTarget of targets) {
      const baselineToken = await markTradePageHints(page);
      const writeResponse = watchTradeResponse(page);
      try {
        const clicked = exitType ? await clickPositionTransfer(page, positionTarget) : await clickTradeEntry(page, action);
        if (!clicked.clicked) {
          return withCompleted({ ok: false, code: clicked.code, message: clicked.code === "SUBMIT_BUTTON_DISABLED" ? "入场按钮存在但网页禁用，继续刷新页面并重试" : "目标交易控件未就绪，继续刷新页面并重试", filled: true, submitted: false });
        }
        const dialog = await completeTradeDialogs(page, { exitType, orderType, price, baselineToken, finished: () => Boolean(writeResponse.peek()) });
        if (!dialog.ok) return withCompleted({ ok: false, code: dialog.code, message: "转让弹窗尚未完成，继续监控并重试", filled: true, submitted: false });
        const { response, pageHint } = await observeTradeFeedback(page, writeResponse, baselineToken);
        const result = { ...tradeSubmissionOutcome({ responseSeen: Boolean(response), responseOk: response ? response.ok() : null, pageHint, clicked }), targetPositionIds: positionTarget.targetPositionIds, submittedQuantity: clicked.quantity };
        results.push(result);
        if (!result.ok) {
          return withCompleted(result);
        }
      } finally {
        writeResponse.dispose();
      }
    }
    return { ...results[results.length - 1], targetPositionIds, submittedQuantity: results.reduce((sum, item) => sum + Number(item.submittedQuantity || 0), 0), results };
  } catch (error) {
    return withCompleted({ ok: false, code: "TRADE_SUBMIT_FAILED", message: error.message, filled: true, submitted: false });
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
