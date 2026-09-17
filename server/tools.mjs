import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { adapterCanLogin, getConnectorAdapter } from "./connectors.mjs";
import { getBrowserPage, openBrowserPage, readVisiblePage, selectPageBoardInstrument } from "./browser.mjs";
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

export function isTradeWriteResponse(url, method) {
  if (String(method || "GET").toUpperCase() === "GET") return false;
  return /intraday-trade|position|holding|warehouse|trade|order|entrust|bargain|deal|transfer|inventory|submit|委托|转让|订立/i.test(String(url || ""));
}

async function selectPositionForSell(page, { symbol = "", symbolName = "", instrumentId = "", targetPositionIds = [], activate = true } = {}) {
  const values = [symbol, symbolName, instrumentId].map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
  const ids = (Array.isArray(targetPositionIds) ? targetPositionIds : []).map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
  if (!values.length && !ids.length) return { ok: false, code: "SELL_POSITION_TARGET_MISSING" };
  try {
    return await page.evaluate(({ targetValues, targetIds, shouldActivate }) => {
      const normalize = (value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const rows = Array.from(document.querySelectorAll("tr, [role='row'], .el-table__row, li, .position-row")).filter(visible);
      const matches = rows.filter((item) => {
        const text = normalize(item.textContent);
        return text && (targetIds.some((value) => text.includes(value)) || targetValues.some((value) => text.includes(value)));
      }).filter((item, _, list) => !list.some((other) => other !== item && other.contains(item)));
      if (!matches.length) return { ok: false, code: "SELL_POSITION_NOT_FOUND", selectedCount: 0 };
      if (shouldActivate) {
        for (const row of matches) row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, code: "SELL_POSITION_SELECTED", selectedCount: matches.length, positionTexts: matches.map((row) => normalize(row.textContent).slice(0, 240)) };
    }, { targetValues: values, targetIds: ids, shouldActivate: activate });
  } catch (error) {
    return { ok: false, code: "SELL_POSITION_SELECT_FAILED", message: error.message };
  }
}

async function clickPositionExitControl(page, { symbol = "", symbolName = "", instrumentId = "", targetPositionIds = [], exitType = "" } = {}) {
  const values = [symbol, symbolName, instrumentId].map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
  const ids = (Array.isArray(targetPositionIds) ? targetPositionIds : []).map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
  const controlText = exitType === "STOP_LOSS" ? "止损" : exitType === "TAKE_PROFIT" ? "止盈" : "";
  if (!controlText || (!values.length && !ids.length)) return { ok: false, code: "EXIT_TARGET_MISSING" };
  try {
    return await page.evaluate(({ targetValues, targetIds, label }) => {
      const normalize = (value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const rows = Array.from(document.querySelectorAll("tr, [role='row'], .el-table__row, li, .position-row")).filter(visible);
      const matches = rows.filter((row) => {
        const text = normalize(row.textContent);
        return text && (targetIds.some((value) => text.includes(value)) || targetValues.some((value) => text.includes(value)));
      }).filter((row, _, list) => !list.some((other) => other !== row && other.contains(row)));
      let clicked = 0;
      for (const row of matches) {
        const controls = Array.from(row.querySelectorAll("button, [role='button'], a, [data-action], span, div"));
        const control = controls.find((node) => visible(node) && normalize(node.textContent).includes(label)
          && (node.matches("button, [role='button'], a, [data-action]") || node.children.length === 0));
        if (control && typeof control.click === "function") { control.click(); clicked += 1; }
      }
      return { ok: clicked > 0, code: clicked > 0 ? "EXIT_CONTROL_CLICKED" : "EXIT_CONTROL_NOT_FOUND", selectedCount: matches.length, clickedCount: clicked };
    }, { targetValues: values, targetIds: ids, label: controlText });
  } catch (error) {
    return { ok: false, code: "EXIT_CONTROL_CLICK_FAILED", message: error.message };
  }
}

async function activateTradePane(page, pane) {
  return page.evaluate((label) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    const target = normalize(label);
    const nodes = Array.from(document.querySelectorAll("button, [role='tab'], .el-tabs__item, .el-radio-button, .el-radio-button__inner, span, a"));
    const match = nodes.find((node) => {
      const text = normalize(node.textContent);
      if (/买入订立|卖出订立|买入转让|卖出转让/.test(text)) return false;
      return text === target || (node.matches("[role='tab'], .el-tabs__item, .el-radio-button, .el-radio-button__inner") && text.includes(target));
    });
    if (!match || typeof match.click !== "function") return { ok: false, pane: label };
    match.click();
    return { ok: true, pane: label };
  }, pane);
}

async function clickTradeSubmitButton(page, { action, exitType } = {}) {
  await activateTradePane(page, tradePaneLabel({ exitType }));
  const submitLabels = tradeSubmitLabels({ action, exitType });
  return page.evaluate(async ({ buttonLabels }) => {
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
    for (const buttonLabel of buttonLabels) {
      const wanted = normalize(buttonLabel);
      const button = buttons.find((node) => {
        const text = normalize(node.textContent);
        return text.includes(wanted) && !node.disabled;
      });
      if (!button) continue;
      button.click();
      return { clicked: true, label: normalize(button.textContent) };
    }
    return { clicked: false, reason: "SUBMIT_BUTTON_NOT_FOUND", tried: buttonLabels };
  }, { buttonLabels: submitLabels });
}

export async function fillSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [], formAlreadyFilled = false } = {}) {
  if (action !== "BUY" && action !== "SELL") {
    return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false, fields: [] };
  }
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false, fields: [] };
  const targetInstrument = { symbol: String(symbol || ""), symbolName: String(symbolName || ""), instrumentId: String(instrumentId || "") };
  if (targetInstrument.symbol || targetInstrument.symbolName || targetInstrument.instrumentId) {
    const selected = await selectPageBoardInstrument(sessionId, targetInstrument);
    if (!selected) return { ok: false, code: "TARGET_BOARD_NOT_FOUND", message: "目标页无法切换到建议指定的盘口", filled: false, submitted: false, fields: [] };
  }
  const positionSelection = exitType && !formAlreadyFilled ? await selectPositionForSell(page, { ...targetInstrument, targetPositionIds, activate: true }) : null;
  await activateTradePane(page, tradePaneLabel({ exitType }));
  const labels = suggestionFormLabels(action, { exitType });
  try {
    const result = await page.evaluate(({ labels: fieldLabels, priceValue, quantityValue }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, "");
      const forbidden = /买入订立|卖出订立|买入转让|卖出转让|确认买入|确认卖出|立即下单|提交委托/;
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
      function fillNamed(names, value) {
        for (const name of names) {
          if (assignValue(findInput(name), value)) return name;
        }
        return null;
      }
      const filled = [];
      const priceName = fillNamed([fieldLabels.price, ...(fieldLabels.extras || []).filter((item) => /价/.test(item))], priceValue);
      const quantityName = fillNamed([fieldLabels.quantity, ...(fieldLabels.extras || []).filter((item) => /量/.test(item))], quantityValue);
      if (priceName) filled.push(priceName);
      if (quantityName) filled.push(quantityName);
      const forbiddenButtons = Array.from(document.querySelectorAll("button, [role='button'], a")).
        filter((node) => forbidden.test(normalize(node.textContent))).
        map((node) => normalize(node.textContent));
      return { filled, forbiddenButtons, submitted: false };
    }, { labels, priceValue: price, quantityValue: quantity });
    return {
      ok: result.filled.length > 0 || Boolean(exitType && orderType !== "LIMIT" && positionSelection?.ok),
      code: result.filled.length ? "FORM_FILLED_NOT_SUBMITTED" : exitType && orderType !== "LIMIT" && positionSelection?.ok ? "EXIT_POSITION_READY" : "FORM_FIELDS_NOT_FOUND",
      filled: result.filled.length > 0 || Boolean(exitType && orderType !== "LIMIT" && positionSelection?.ok),
      submitted: false,
      fields: result.filled,
      positionSelection,
      forbiddenButtons: result.forbiddenButtons || [],
    };
  } catch (error) {
    return { ok: false, code: "FORM_FILL_FAILED", message: error.message, filled: false, submitted: false, fields: [] };
  }
}

export async function submitSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [], formAlreadyFilled = false } = {}) {
  if (action !== "BUY" && action !== "SELL") {
    return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false };
  }
  if ((!exitType || orderType === "LIMIT") && (price == null || quantity == null || !Number(quantity))) {
    return { ok: false, code: "ORDER_PREVIEW_INCOMPLETE", message: "缺少建议价格或数量，无法下单", filled: false, submitted: false };
  }
  const filled = formAlreadyFilled
    ? { ok: true, filled: true, submitted: false, fields: [suggestionFormLabels(action, { exitType }).price, suggestionFormLabels(action, { exitType }).quantity], positionSelection: { ok: true, code: "FORM_ALREADY_FILLED" } }
    : await fillSuggestionForm({ sessionId, action, price, quantity, symbol, symbolName, instrumentId, exitType, orderType, targetPositionIds });
  if (!filled.ok) return { ...filled, submitted: false };
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: filled.filled, submitted: false };
  try {
    const writeWait = page.waitForResponse((response) => {
      try {
        return isTradeWriteResponse(response.url(), response.request?.().method?.());
      } catch {
        return false;
      }
    }, { timeout: 8000 }).catch(() => null);
    let clicked = await clickTradeSubmitButton(page, { action, exitType });
    if (exitType && !clicked.clicked) {
      clicked = await clickPositionExitControl(page, { symbol, symbolName, instrumentId, targetPositionIds, exitType });
    }
    const clickedOk = Boolean(clicked?.ok || clicked?.clicked);
    if (exitType && !clickedOk) {
      const fallback = await selectPositionForSell(page, { symbol, symbolName, instrumentId, targetPositionIds, activate: true });
      if (!fallback.ok) return { ok: false, code: fallback.code, message: "目标页未找到可操作持仓", filled: true, submitted: false };
      return { ok: false, code: "EXIT_CONTROL_NOT_FOUND", message: "已定位持仓，但目标页未找到转让离场或止盈/止损按钮", filled: true, submitted: false, selectedCount: fallback.selectedCount };
    }
    if (!exitType && !clicked.clicked) {
      return { ok: false, code: clicked.reason || "SUBMIT_BUTTON_NOT_FOUND", message: action === "SELL" ? "目标页未找到卖出订立按钮" : "目标页未找到买入订立按钮", filled: true, submitted: false };
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
      submitLabel: clicked?.label || null,
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
