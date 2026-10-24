import { rescueTriggerAllowsQuote } from "./rescue-policy.mjs";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { adapterCanLogin, getConnectorAdapter } from "./connectors.mjs";
import { getBrowserPage, openBrowserPage, readVisiblePage, recoverBrowserSession, resolveSnapshotControl, scanBrowserControls, scanBrowserPage, selectPageBoardInstrument } from "./browser.mjs";
import { requestBrowserActions } from "./provider.mjs";
import { getCredential, initVault } from "./vault.mjs";
import { clickPositionTransfer, clickTradeEntry, completeTradeDialogs, dismissOrderCancellationDialogs, dismissTransferDialogs, fillTradeFields, prepareEntryAgreement, preparePositionRows, prepareTradeEntry } from "./trade-controls.mjs";
import { activateCurrentOrders, clickOrderCancellation, readCurrentOrderStatus } from "./order-controls.mjs";
import { haohanLoginRequired, parseHaohanPageSnapshot } from "./haohan.mjs";
import { executableExitQuote, exitGuardAllowsPrice, heldDirection, isNonLosingExit, positionEntryPrice, positionAmountGuardAllowsPrice, realtimeValueAbove } from "./exit-policy.mjs";
import { observedLossGuardAllowsPrice, recoveryExitAllowed } from "./loss-observation.mjs";

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

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}${parsed.hash}`;
  } catch { return ""; }
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

function browserLifecycleError(error) {
  return /target crashed|target page, context or browser has been closed|browser has been closed|page has been closed|context has been closed|browser disconnected/i.test(String(error?.message || error || ""));
}

async function firstVisibleLocator(page, selector, { timeout = 0, label = "控件" } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  do {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch((error) => { if (browserLifecycleError(error)) throw error; return false; })
        && !await candidate.isDisabled({ timeout: 800 }).catch((error) => { if (browserLifecycleError(error)) throw error; return true; })) return candidate;
    }
    if (!timeout || Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}_NOT_FOUND`);
}

async function optionalVisibleLocator(page, selector) {
  try { return await firstVisibleLocator(page, selector); } catch (error) {
    if (browserLifecycleError(error)) throw error;
    return null;
  }
}

function planActions(plan) {
  return Array.isArray(plan?.actions) ? plan.actions.slice(0, 12) : [];
}

async function requestLiveBrowserPlan(page, provider, context = {}) {
  if (!provider) return { ok: false, code: "BROWSER_AI_PROVIDER_REQUIRED", actions: [], snapshot: null };
  const snapshot = await scanBrowserPage(page, { targetPositionIds: context.targetPositionIds });
  if (!snapshot.ok) return { ...snapshot, actions: [] };
  const plan = await requestBrowserActions(provider, {
    ...context,
    page: {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      controls: snapshot.controls,
      snapshotToken: snapshot.snapshotToken,
    },
    controls: snapshot.controls,
  }, { timeoutMs: 20000 });
  if (!plan?.ok || !planActions(plan).length) return { ok: false, code: plan?.code || "BROWSER_ACTION_PLAN_EMPTY", actions: [], snapshot };
  return { ok: true, ...plan, actions: planActions(plan), snapshot };
}

async function resolvePlannedControl(page, action, options = {}) {
  const id = String(action?.controlId || action?.id || "").trim();
  if (!id) return null;
  const control = await resolveSnapshotControl(page, id, options);
  if (control || !options.snapshot) return control;
  const original = options.snapshot.controls?.find(item => item.id === id);
  if (!original || ![original.label, original.placeholder, original.name].some(Boolean)) return null;
  if (options.targetPositionIds?.length) {
    const key = value => String(value || "").replace(/[\s_./\\-]+/g, "").toLowerCase();
    const cells = String(original.rowText || "").split(/\s+/).map(key);
    if (!options.targetPositionIds.some(value => cells.includes(key(value)))) return null;
  }
  // Vue can replace a row while the model is responding. Rebind only the
  // model's exact semantic choice in a fresh snapshot, never an old row index.
  const fresh = await scanBrowserPage(page, { targetPositionIds: options.targetPositionIds });
  const matches = (fresh.controls || []).filter(item => ["role", "type", "label", "placeholder", "name"].every(key => item[key] === original[key])
    && (options.targetPositionIds?.length || item.rowText === original.rowText));
  const verified = [];
  for (const item of matches) {
    const candidate = await resolveSnapshotControl(page, item.id, options);
    if (candidate) verified.push(candidate);
  }
  return verified.length === 1 ? verified[0] : null;
}

async function clickPlannedControl(page, action, options = {}) {
  const control = await resolvePlannedControl(page, action, options);
  if (!control) return false;
  await control.scrollIntoViewIfNeeded({ timeout: 2500 });
  if (options.role === "checkbox") {
    if (await control.isChecked()) return true;
    if (await control.evaluate(node => node instanceof HTMLLabelElement)) {
      // Click the checkbox edge of the label. Its center may contain a link
      // that opens an agreement document and prevents the label's activation.
      const box = await control.boundingBox();
      if (!box) return false;
      await control.click({ position: { x: 1, y: box.height / 2 }, timeout: 5000 });
    } else {
      await control.check({ timeout: 5000 });
    }
    return control.isChecked();
  }
  await control.click({ timeout: 5000 });
  return true;
}

async function fillPlannedControl(page, action, value, options = {}) {
  const control = await resolvePlannedControl(page, action, options);
  if (!control) return false;
  await control.scrollIntoViewIfNeeded({ timeout: 2500 });
  await control.fill(String(value ?? ""), { timeout: 5000 });
  return true;
}

function planActionForField(actions, field) {
  return actions.find((action) => String(action?.field || "").toLowerCase() === field)
    || actions.find((action) => String(action?.label || "").includes(field === "username" ? "手机" : field === "password" ? "密码" : field));
}

function recognizedLoginPlan(snapshot, adapter) {
  if (!snapshot.ok || (adapter.id === "haohan-readonly" && !isLoginUrl(snapshot.url))) return null;
  const controls = snapshot.controls || [];
  const text = control => [control.label, control.placeholder, control.name].filter(Boolean).join(" ");
  const usernames = controls.filter(control => control.role === "textbox" && control.type !== "password"
    && /手机|账号|账户|用户名|phone|mobile|username|account|email/i.test(text(control)));
  const passwords = controls.filter(control => control.role === "textbox" && control.type === "password" && !/交易|支付/.test(text(control)));
  const submits = controls.filter(control => control.role === "button" && /^(登录|登入|log\s*in|sign\s*in)$/i.test(String(control.label || "").replace(/\s+/g, "")));
  const checkboxes = controls.filter(control => control.role === "checkbox");
  const consents = checkboxes.filter(control => /同意|协议|agreement|consent/i.test(text(control)));
  if (usernames.length !== 1 || passwords.length !== 1 || submits.length !== 1 || consents.length > 1
    || checkboxes.length !== consents.length) return null;
  return { ok: true, snapshot, actions: [
    { type: "fill", field: "username", controlId: usernames[0].id },
    { type: "fill", field: "password", controlId: passwords[0].id },
    ...(consents.length ? [{ type: "accept_agreement", field: "consent", controlId: consents[0].id }] : []),
    { type: "click", field: "submit", controlId: submits[0].id },
  ] };
}

async function agentTradeConfirmation(page, box, provider, context = {}) {
  if (!provider) return null;
  const plan = await requestLiveBrowserPlan(page, provider, {
    goal: "CONFIRM_TRADE",
    mode: "confirm",
    ...context,
    instructions: "只点击当前交易确认弹窗中的确定/确认/同意按钮；禁止点击取消、止盈止损、全撤或其他页面按钮。",
  });
  const confirm = plan.actions.find((item) => String(item?.field || "").toLowerCase() === "confirm")
    || plan.actions.find((item) => String(item?.type || "").toLowerCase() === "click" && /确定|确认|同意|继续|提交/.test(String(item?.label || "")));
  if (!plan.ok || !confirm) return null;
  const control = await resolvePlannedControl(page, confirm, { role: "button", snapshot: plan.snapshot });
  if (!control) return null;
  const boxHandle = await box.elementHandle();
  try {
    return boxHandle && await control.evaluate((node, root) => root.contains(node), boxHandle) ? control : null;
  } finally { await boxHandle?.dispose(); }
}

async function pageHasLoginSuccess(page, adapter) {
  if (!page || !adapter?.login) return false;
  const currentUrl = page.url();
  if (isLoginUrl(currentUrl)) return false;
  if (adapter.id === "haohan-readonly") {
    // Expired sessions can leave both the trading route and old quotes visible.
    // Neither those nor cached sessionStorage keys prove a live login.
    try {
      const visibleText = await page.locator("body").innerText({ timeout: 800 });
      if (haohanLoginRequired({ url: currentUrl, visibleText })) return false;
      const loginButton = await optionalVisibleLocator(page, adapter.login.submitSelector);
      const password = await optionalVisibleLocator(page, adapter.login.passwordSelector);
      if (loginButton && password) return false;
    } catch (error) {
      if (browserLifecycleError(error)) throw error;
      return false;
    }
  }
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

async function loginErrorText(page, adapter) {
  const selectors = Array.isArray(adapter?.login?.errorSelectors) && adapter.login.errorSelectors.length
    ? adapter.login.errorSelectors
    : [".el-form-item__error", ".el-message", ".el-notification", '[role="alert"]'];
  const messages = [];
  for (const selector of selectors) {
    try {
      const values = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
      }).map(node => node.textContent || ""));
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await getBrowserPage(sessionId);
    const adapter = getConnectorAdapter(adapterId);
    if (!page || !adapter) return { ok: false, authenticated: false, code: "BROWSER_SESSION_NOT_FOUND" };
    try {
      let matchesTarget = false;
      try { matchesTarget = Boolean(adapter.match({ type: adapter.type, url: page.url() })); } catch {}
      if (!matchesTarget) return { ok: false, authenticated: false, code: "LOGIN_TARGET_MISMATCH", url: page.url() };
      return { ok: true, authenticated: await pageHasLoginSuccess(page, adapter), url: page.url() };
    } catch (error) {
      if (browserLifecycleError(error) && attempt === 0) {
        try { await recoverBrowserSession(sessionId); } catch (recoveryError) {
          return { ok: false, authenticated: false, code: "BROWSER_RECOVERY_FAILED", message: recoveryError.message };
        }
        continue;
      }
      return { ok: false, authenticated: false, code: "BROWSER_READ_FAILED", message: error.message };
    }
  }
  return { ok: false, authenticated: false, code: "BROWSER_READ_FAILED" };
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
    const target = page.locator(selector);
    if (await target.evaluate(node => Boolean(node.closest("#hisPage, [role='tabpanel'][aria-label='历史委托']")))) {
      return { ok: false, code: "HISTORICAL_ORDERS_DISABLED", message: "只允许读取当前委托和真实持仓" };
    }
    const text = await target.innerText({ timeout: 10000 });
    return { ok: true, sessionId, selector, text: String(text).slice(0, 12000), capturedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, code: "EXTRACT_FAILED", message: error.message };
  }
}

export async function browserScanControls({ sessionId = "default", maxControls = 120, maxText = 12000 } = {}) {
  return scanBrowserControls(sessionId, { maxControls, maxText });
}

export async function browserLogin({ sessionId = "default", credentialRef, adapterId, targetUrl = "", ownerUserId = "", ownerUserIds = [], automationAuthorized = true, submit = true, browserProvider = null, provider = null }) {
  if (!credentialRef) return { ok: false, code: "CREDENTIAL_REF_REQUIRED", message: "登录必须引用托管凭据，不能传入明文密码" };
  await initVault();
  const credential = getCredential(credentialRef, { ownerUserId, ownerUserIds });
  if (!credential) return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND", message: "托管凭据不存在或无法解密" };
  return browserLoginWithCredential({ sessionId, credentialRef, adapterId, targetUrl, submit, browserProvider, provider }, credential);
}

// Desktop receives an owner-checked credential for this call only; never persist it locally.
export async function browserLoginWithCredential({ sessionId = "default", credentialRef, adapterId, targetUrl = "", submit = true, browserProvider = null, provider = null }, credential) {
  if (!credential) return { ok: false, code: "CREDENTIAL_REF_NOT_FOUND" };
  const resolvedAdapterId = adapterId || credential?.target?.adapterId;
  const adapter = getConnectorAdapter(resolvedAdapterId);
  if (!adapterCanLogin(resolvedAdapterId) || adapter.reviewStatus !== "APPROVED") return { ok: false, code: "LOGIN_FLOW_REQUIRES_TARGET_ADAPTER", message: "目标站点登录字段需要已审核的连接器适配器", adapterId: resolvedAdapterId || "" };
  const startedAt = Date.now();
  let stage = "prepare";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await getBrowserPage(sessionId);
    if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先导航到目标页面" };
    try {
      const currentUrl = page.url();
      let adapterMatchesCurrentPage = false;
      try { adapterMatchesCurrentPage = Boolean(adapter.match({ type: "website", url: currentUrl })); } catch {}
      if (!adapterMatchesCurrentPage) return { ok: false, code: "LOGIN_TARGET_MISMATCH", message: "当前浏览器页面与连接器适配器目标不一致", adapterId: adapter.id, url: currentUrl };
      if (credential?.target?.url) {
        try {
          if (new URL(currentUrl).hostname !== new URL(credential.target.url).hostname) return { ok: false, code: "CREDENTIAL_TARGET_MISMATCH", message: "凭据目标与当前浏览器页面不一致" };
        } catch { return { ok: false, code: "CREDENTIAL_TARGET_INVALID", message: "凭据目标地址无效" }; }
      }
      const aiProvider = browserProvider || provider;
      stage = "navigate";
      // The approved login route is known. Do not ask a model to inspect an
      // expired trading screen before opening the actual sign-in form.
      const loginFormVisible = Boolean(await optionalVisibleLocator(page, adapter.login.passwordSelector));
      if (adapter.login.entryUrl && !isLoginUrl(currentUrl) && !loginFormVisible) {
        const loginUrl = new URL(adapter.login.entryUrl);
        if (loginUrl.origin !== new URL(currentUrl).origin || !isAllowedDomain(loginUrl.href)) return { ok: false, code: "LOGIN_TARGET_MISMATCH" };
        await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: 20000 });
      }
      stage = "locate";
      await firstVisibleLocator(page, adapter.login.passwordSelector, { timeout: 5000, label: "LOGIN_PASSWORD" });
      const snapshot = await scanBrowserPage(page);
      let plan = recognizedLoginPlan(snapshot, adapter);
      if (!plan && aiProvider) {
        stage = "model_locate";
        plan = await requestLiveBrowserPlan(page, aiProvider, {
          goal: "LOGIN", mode: "login",
          instructions: "选择当前页面登录账号字段、密码字段、协议复选框（若存在）和登录提交按钮。只返回当前快照 controlId；不要输入密码值。",
        });
      }
      if (!plan?.ok) return { ok: false, code: plan?.code || "LOGIN_CONTROLS_NOT_FOUND", message: "当前登录控件无法唯一确认", credentialRef, adapterId: adapter.id, stage };
      const actions = plan.actions;
      const usernameAction = planActionForField(actions, "username");
      const passwordAction = planActionForField(actions, "password");
      const submitAction = actions.find(action => String(action?.field || "").toLowerCase() === "submit" || String(action?.type || "").toLowerCase() === "submit")
        || actions.find(action => String(action?.type || "").toLowerCase() === "click" && /登录|sign\s*in|log\s*in/i.test(String(action?.label || "")));
      stage = "fill";
      const fieldOptions = { role: "textbox", snapshot: plan.snapshot };
      if (!usernameAction || !passwordAction || !submitAction
        || !await fillPlannedControl(page, usernameAction, String(credential.username || ""), fieldOptions)
        || !await fillPlannedControl(page, passwordAction, String(credential.password || ""), fieldOptions)) {
        return { ok: false, code: "LOGIN_CONTROLS_NOT_FOUND", message: "登录字段已变化或不可见", credentialRef, adapterId: adapter.id, stage };
      }
      stage = "consent";
      const consentAction = actions.find(action => String(action?.field || "").toLowerCase() === "consent" || String(action?.type || "").toLowerCase() === "accept_agreement")
        || actions.find(action => String(action?.type || "").toLowerCase() === "click" && /同意|协议|agreement|consent/i.test(String(action?.label || "")));
      if (consentAction && !await clickPlannedControl(page, consentAction, { role: "checkbox", snapshot: plan.snapshot })) {
        return { ok: false, code: "LOGIN_CONSENT_NOT_FOUND", message: "登录协议控件已变化或不可见", credentialRef, adapterId: adapter.id, stage };
      }
      if (submit === false) return { ok: true, credentialRef, adapterId: adapter.id, authenticated: false, requiresApproval: false, code: "LOGIN_FILLED_NOT_SUBMITTED", url: page.url() };
      const priorError = await loginErrorText(page, adapter);
      stage = "submit";
      if (!await clickPlannedControl(page, submitAction, { role: "button", snapshot: plan.snapshot })) return { ok: false, code: "LOGIN_SUBMIT_NOT_FOUND", message: "登录按钮已变化或不可见", credentialRef, adapterId: adapter.id, stage };
      stage = "verify";
      const deadline = Date.now() + Math.max(5000, Number(adapter.login.successTimeoutMs) || 20000);
      let authenticated = false;
      while (Date.now() < deadline) {
        authenticated = await pageHasLoginSuccess(page, adapter);
        if (authenticated) break;
        const detail = await loginErrorText(page, adapter);
        if (detail && detail !== priorError && /失败|错误|不正确|不存在|锁定|频繁|验证码|异常|拒绝/.test(detail)) {
          return { ok: false, code: "LOGIN_REJECTED", message: `网站拒绝登录：${detail}`, credentialRef, adapterId: adapter.id, stage, executionDurationMs: Date.now() - startedAt };
        }
        await page.waitForTimeout(250);
      }
      if (!authenticated) {
        const detail = await loginErrorText(page, adapter);
        return { ok: false, code: "LOGIN_NOT_CONFIRMED", message: detail ? `登录提交后仍未确认：${detail}` : "登录提交后未确认进入目标页面", credentialRef, adapterId: adapter.id, url: page.url() };
      }
      stage = "navigate_after_login";
      const navigation = await navigateAfterLogin(page, adapter, credential, targetUrl);
      if (!await pageHasLoginSuccess(page, adapter)) return { ok: false, authenticated: false, code: "LOGIN_NOT_CONFIRMED", message: "返回目标页后登录尚未恢复，将自动重试", url: page.url() };
      return { ok: true, credentialRef, adapterId: adapter.id, authenticated: true, url: page.url(), ...navigation };
    } catch (error) {
      if (browserLifecycleError(error) && attempt === 0) {
        try { await recoverBrowserSession(sessionId); } catch (recoveryError) {
          return { ok: false, code: "BROWSER_RECOVERY_FAILED", message: recoveryError.message, credentialRef, adapterId: adapter.id };
        }
        continue;
      }
      const modelTimeout = stage === "model_locate" && /timeout|timed out|aborted/i.test(String(error.message));
      let errorMessage = String(error.message || "LOGIN_FAILED");
      for (const value of [credential.password, credential.username].filter(Boolean)) errorMessage = errorMessage.split(String(value)).join("[redacted]");
      return { ok: false, code: modelTimeout ? "LOGIN_MODEL_TIMEOUT" : "LOGIN_FAILED",
        message: modelTimeout ? "登录控件识别超时：AI 未响应，尚未提交登录" : `登录${({ navigate: "页面加载", locate: "控件定位", fill: "字段填写", consent: "协议勾选", submit: "按钮点击", verify: "结果确认", navigate_after_login: "后页面跳转" })[stage] || "操作"}失败：${errorMessage}`,
        credentialRef, adapterId: adapter.id, stage, executionDurationMs: Date.now() - startedAt };
    }
  }
  return { ok: false, code: "LOGIN_FAILED", message: "登录重试失败", credentialRef, adapterId: adapter.id };
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

export function isOrderCancellationResponse(url, method) {
  if (String(method || "GET").toUpperCase() !== "POST") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "smyw.haohandahan.cn" && /\/intraday-trade\/trade\/cancel\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function watchTradeResponse(page, matches = isTradeWriteResponse) {
  let matched = null;
  const listener = (response) => {
    if (matched || !matches(response.url(), response.request?.().method?.(), response)) return;
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
  const liveSnapshot = await scanBrowserControls(sessionId, { targetPositionIds }).catch(() => ({ ok: false, controls: [] }));
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
    return { ok: true, ...snapshot, snapshotToken: liveSnapshot.snapshotToken || null, snapshotControls: liveSnapshot.controls || [] };
  } catch (error) {
    return { ok: false, code: "TRADE_CONTROLS_READ_FAILED", message: error.message, buttons: [], fields: [], rowActions: [] };
  }
}

export async function fillSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [], browserProvider = null, provider = null } = {}) {
  if (action !== "BUY" && action !== "SELL") return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false, fields: [] };
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false, fields: [] };
  try {
    const aiProvider = browserProvider || provider;
    if (exitType) {
      const rows = await preparePositionRows(page, { action, symbol, symbolName, instrumentId, targetPositionIds }).catch(() => []);
      if (rows.length) return { ok: true, code: "EXIT_POSITION_READY", filled: true, submitted: false, fields: [] };
      if (!aiProvider || !targetPositionIds.length) return { ok: false, code: "EXIT_POSITION_NOT_FOUND", filled: false, submitted: false, fields: [] };
      const plan = await requestLiveBrowserPlan(page, aiProvider, {
        goal: "EXIT_TRANSFER",
        mode: "prepare",
        action,
        exitType,
        targetPositionIds,
        instructions: "确认当前页面存在精确目标持仓行和转让控件，不点击任何交易按钮。",
      });
      const transfer = plan.actions.find((item) => String(item?.field || "").toLowerCase() === "submit" || /转让/.test(String(item?.label || "")));
      return { ok: Boolean(plan.ok && transfer), code: plan.ok && transfer ? "EXIT_POSITION_READY" : "EXIT_POSITION_NOT_FOUND", filled: Boolean(plan.ok && transfer), submitted: false, fields: [] };
    }
    if (symbol || symbolName || instrumentId) {
      const selected = await selectPageBoardInstrument(sessionId, { symbol, symbolName, instrumentId });
      if (!selected) return { ok: false, code: "TARGET_BOARD_NOT_FOUND", filled: false, submitted: false, fields: [] };
    }
    if (aiProvider) {
      // The decision already chose side/price/quantity. Use live, labelled
      // controls when the reviewed form is present; another model round trip
      // on every fill/click can outlive the exit guard or desktop RPC.
      if (await prepareTradeEntry(page, action)) {
        const labels = suggestionFormLabels(action);
        const fields = await fillTradeFields(page, [
          { labels: [labels.price, ...labels.extras.filter(item => /价/.test(item))], value: price },
          { labels: [labels.quantity, ...labels.extras.filter(item => /量/.test(item))], value: quantity },
        ]);
        if (fields.length === 2) {
          await prepareEntryAgreement(page, action);
          return { ok: true, code: "FORM_FILLED_NOT_SUBMITTED", filled: true, submitted: false, fields };
        }
      }
      const plan = await requestLiveBrowserPlan(page, aiProvider, {
        goal: action === "BUY" ? "ENTRY_BUY_UP" : "ENTRY_BUY_DOWN",
        mode: "prepare",
        action,
        price,
        quantity,
        instructions: "只填写价格和数量，勾选必要协议；mode=prepare 时禁止点击买入/卖出订立提交按钮。",
      });
      if (!plan.ok) return { ok: false, code: plan.code, message: "AI 未能从当前页面选择下单字段", filled: false, submitted: false, fields: [] };
      for (const navigation of plan.actions.filter((item) => String(item?.type || "").toLowerCase() === "click" && !["price", "quantity", "consent", "submit"].includes(String(item?.field || "").toLowerCase()))) {
        if (/买入|买涨|做多|建仓|订立|卖出|买跌|做空/.test(String(navigation?.label || ""))) {
          await clickPlannedControl(page, navigation, { role: "button", snapshot: plan.snapshot }).catch(() => {});
        }
      }
      let priceAction = planActionForField(plan.actions, "price");
      let quantityAction = planActionForField(plan.actions, "quantity");
      let fieldsFilled = Boolean(priceAction && quantityAction
        && await fillPlannedControl(page, priceAction, price, { snapshot: plan.snapshot })
        && await fillPlannedControl(page, quantityAction, quantity, { snapshot: plan.snapshot }));
      if (!fieldsFilled) {
        const refreshed = await requestLiveBrowserPlan(page, aiProvider, {
          goal: action === "BUY" ? "ENTRY_BUY_UP" : "ENTRY_BUY_DOWN",
          mode: "prepare",
          action,
          price,
          quantity,
          instructions: "页面刚完成方向或标签切换。重新选择当前可见价格和数量字段及必要协议；禁止提交。",
        });
        priceAction = refreshed.ok ? planActionForField(refreshed.actions, "price") : null;
        quantityAction = refreshed.ok ? planActionForField(refreshed.actions, "quantity") : null;
        fieldsFilled = Boolean(priceAction && quantityAction
          && await fillPlannedControl(page, priceAction, price, { snapshot: refreshed.snapshot })
          && await fillPlannedControl(page, quantityAction, quantity, { snapshot: refreshed.snapshot }));
        if (refreshed.ok) { plan.actions = refreshed.actions; plan.snapshot = refreshed.snapshot; }
      }
      if (!fieldsFilled) {
        return { ok: false, code: "FORM_FIELDS_NOT_FOUND", message: "AI 选择的下单字段已变化或不可见", filled: false, submitted: false, fields: [] };
      }
      const agreement = plan.actions.find((item) => String(item?.field || "").toLowerCase() === "consent" || String(item?.type || "").toLowerCase() === "accept_agreement");
      if (agreement && !await clickPlannedControl(page, agreement, { role: "checkbox", snapshot: plan.snapshot })) {
        return { ok: false, code: "FORM_CONSENT_NOT_FOUND", message: "AI 选择的协议控件已变化或不可见", filled: false, submitted: false, fields: [] };
      }
      return { ok: true, code: "FORM_FILLED_NOT_SUBMITTED", filled: true, submitted: false, fields: [String(priceAction.label || "price"), String(quantityAction.label || "quantity")] };
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
  if (tradePageHintKind(detail) === "submitted") {
    return { ok: true, code: "TRADE_SUBMITTED", message: detail || "已提交交易请求，等待持仓对账", filled: true, submitted: true, responseOk, submitLabel: clicked?.label || null };
  }
  return { ok: false, code: "TRADE_SUBMISSION_UNVERIFIED", message: "已点击交易控件，但页面未显示明确结果；需核实订单和持仓", filled: true, submitted: false, uncertain: true, responseOk };
}

function entryConfirmationGuard(entryDeadlineAt) {
  if (entryDeadlineAt == null) return undefined;
  return async () => ({ ok: Number.isFinite(entryDeadlineAt) && Date.now() < entryDeadlineAt, code: "SESSION_CLOSING_NO_ENTRY" });
}

export async function continueManualEntry({ sessionId = "default", action, entryDeadlineAt = null } = {}) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND" };
  const dialogs = await page.locator(".el-message-box:visible, .el-dialog:visible, [role='dialog']:visible, [aria-modal='true']:visible, dialog:visible, .ant-modal:visible, .modal:visible, .popup:visible").allTextContents();
  if (!dialogs.some((text) => /确认下单|确认买入|确认卖出|确认委托|确认交易|是否确认|确定.*(?:下单|委托|交易|订立)|提交委托|风险提示|合同|协议|您确定/.test(text.replace(/\s+/g, "")))) return { ok: true, continued: false };
  const result = await completeTradeDialogs(page, { baselineToken: await markTradePageHints(page), canConfirm: entryConfirmationGuard(entryDeadlineAt) });
  return { ok: result.ok, code: result.code, continued: result.confirmed === true };
}

export async function cancelOpenOrders({ sessionId = "default", orderIds = [] } = {}) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", results: [] };
  const results = [];
  for (const orderId of [...new Set(orderIds.map(String).map((id) => id.trim()).filter(Boolean))]) {
    const baselineToken = await markTradePageHints(page);
    const response = watchTradeResponse(page, (url, method, candidate) => {
      if (!isOrderCancellationResponse(url, method)) return false;
      try { return String(candidate.request().postDataJSON()?.orderId || "") === orderId; }
      catch { return false; }
    });
    const nativeDialog = (dialog) => {
      if (/撤单|撤销.*委托/.test(dialog.message()) && !/所有|全撤/.test(dialog.message())) dialog.accept().catch(() => {});
    };
    page.on("dialog", nativeDialog);
    let stage = "select_order";
    try {
      const clicked = await clickOrderCancellation(page, orderId);
      if (!clicked.clicked) {
        results.push({ orderId, ok: false, cancelled: false, stage, code: clicked.code });
        continue;
      }
      stage = "confirm_cancel";
      const dialogs = await completeTradeDialogs(page, { cancelOrder: true, baselineToken, finished: () => Boolean(response.peek()) });
      stage = "verify_result";
      // Public client confirms data.code === "0" for this exact POST/orderId.
      // Success notices can be disabled; observe the browser response instead.
      const readResponse = async () => {
        const matched = response.peek();
        if (!matched) return null;
        const body = await matched.json().catch(() => null);
        if (!matched.ok() || !["string", "number"].includes(typeof body?.code)) return null;
        return { orderId, ok: String(body.code) === "0", cancelled: String(body.code) === "0",
          code: String(body.code) === "0" ? "ORDER_CANCELLED" : "ORDER_CANCEL_REJECTED",
          stage, source: "browser_response", message: String(body.message || "") };
      };
      let verifiedResponse = await readResponse();
      if (verifiedResponse) { results.push(verifiedResponse); continue; }
      let hint = await readTradePageHint(page, baselineToken);
      let status = "";
      if (tradePageHintKind(hint) !== "rejected" && !(/撤单|撤销/.test(hint) && tradePageHintKind(hint) === "submitted")) {
        status = /委托已成交|订单已成交/.test(hint) ? "已成交" : await readCurrentOrderStatus(page, orderId);
        // Closing the confirmation is not the cancellation result. A slow request
        // can still be pending when the current order list is first checked.
        if (!/^(已撤单|部分成交后撤单|已成交)$/.test(status) && (dialogs.confirmed || response.peek())) {
          hint = (await observeTradeFeedback(page, response, baselineToken)).pageHint;
          verifiedResponse = await readResponse();
          if (verifiedResponse) { results.push(verifiedResponse); continue; }
          if (tradePageHintKind(hint) !== "rejected" && !(/撤单|撤销/.test(hint) && tradePageHintKind(hint) === "submitted")) {
            status = /委托已成交|订单已成交/.test(hint) ? "已成交" : await readCurrentOrderStatus(page, orderId);
          }
        }
      }
      if (tradePageHintKind(hint) === "rejected") {
        results.push({ orderId, ok: false, cancelled: false, code: "ORDER_CANCEL_REJECTED", message: hint });
      } else if (/撤单|撤销/.test(hint) && tradePageHintKind(hint) === "submitted") {
        results.push({ orderId, ok: true, cancelled: true, code: "ORDER_CANCELLED", message: hint });
      } else {
        // Disappearance alone cannot distinguish cancellation from a fill.
        // Leave it unverified for the next current-order/position reconciliation.
        const cancelled = /^(已撤单|部分成交后撤单)$/.test(status);
        results.push({ orderId, ok: cancelled, cancelled, code: cancelled ? "ORDER_CANCELLED" : status === "已成交" ? "ORDER_ALREADY_FILLED" : "ORDER_CANCEL_UNVERIFIED", status,
          ...(!cancelled && status !== "已成交" ? { message: "当前委托未能确认撤单结果，继续核对当前委托和真实持仓" } : {}) });
      }
    } catch (error) {
      results.push({ orderId, ok: false, cancelled: false, stage, code: "ORDER_CANCEL_FAILED", message: error.message });
    } finally {
      response.dispose();
      page.off("dialog", nativeDialog);
      // A failed confirmation must not leave a modal blocking the next automatic round.
      await dismissOrderCancellationDialogs(page).catch(() => {});
    }
  }
  await activateCurrentOrders(page);
  return { ok: results.length > 0 && results.every((item) => item.cancelled), results };
}

export async function submitSuggestionForm({ sessionId = "default", action, price, quantity, symbol = "", symbolName = "", instrumentId = "", exitType = null, orderType = "MARKET", targetPositionIds = [], exitGuard = null, rescueTrigger = null, entryDeadlineAt = null, browserProvider = null, provider = null } = {}) {
  if (action !== "BUY" && action !== "SELL") return { ok: false, code: "NO_DIRECTIONAL_ACTION", filled: false, submitted: false };
  if ((!exitType || orderType === "LIMIT") && (price == null || quantity == null || !Number(quantity))) {
    return { ok: false, code: "ORDER_PREVIEW_INCOMPLETE", message: "缺少建议价格或数量，无法下单", filled: false, submitted: false };
  }
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", filled: false, submitted: false };
  const target = { action, symbol, symbolName, instrumentId, targetPositionIds };
  const aiProvider = browserProvider || provider;
  const results = [];
  const startedAt = Date.now();
  let stage = "prepare";
  let actionClicked = false;
  const deadlineGuard = exitType ? undefined : entryConfirmationGuard(entryDeadlineAt);
  const entryGuard = exitType ? undefined : rescueTrigger ? async () => {
    const deadline = await deadlineGuard?.();
    if (deadline && !deadline.ok) return deadline;
    const snapshot = await readVisiblePage(sessionId, { quick: true });
    const market = snapshot.ok ? parseHaohanPageSnapshot(snapshot, { symbol }) : null;
    const quote = market && executableExitQuote(market, { symbol, symbolName, instrumentId, side: rescueTrigger.heldSide });
    return { ok: Boolean(quote && rescueTriggerAllowsQuote(rescueTrigger, quote.price)
      && action === (rescueTrigger.heldSide === "LONG" ? "SELL" : "BUY")
      && (!actionClicked || (action === "SELL" ? Number(price) <= quote.price : Number(price) >= quote.price))),
      price: quote?.price ?? null, code: "RESCUE_CONDITION_CHANGED" };
  } : deadlineGuard;
  let currentExitGuard = exitGuard;
  let lastExitCheck = null;
  const verifyExitGuard = async (dialogPrice = null) => {
    lastExitCheck = null;
    const snapshot = await readVisiblePage(sessionId, { quick: true });
    if (!snapshot.ok) return { ok: false, code: "EXIT_QUOTE_UNVERIFIED", message: snapshot.code + (snapshot.message ? `: ${snapshot.message}` : "") };
    const market = parseHaohanPageSnapshot(snapshot, { symbol });
    const guard = { ...currentExitGuard, exitType };
    const quote = executableExitQuote(market, { symbol, symbolName, instrumentId, side: guard?.heldSide }, Date.now());
    const position = market.account?.positions?.find(p => p.positionOrderId === guard?.positionId);
    const positionValid = guard?.entryPrice === undefined || (market.account?.positionsVerified === true && position
      && positionEntryPrice(position) === guard.entryPrice && heldDirection(position) === guard.heldSide
      && Number(position.quantity) === guard.quantity && Number(position.frozenQuantity || 0) === 0);
    const allowed = positionValid && quote && exitGuardAllowsPrice(guard, quote.price) && (dialogPrice === null || exitGuardAllowsPrice(guard, dialogPrice))
      && (guard?.realtimeValueAbove === undefined || realtimeValueAbove(market.account, guard.realtimeValueAbove))
      && (guard?.exitType !== "TAKE_PROFIT" || (guard.lossRecovery
        ? recoveryExitAllowed(guard.lossObservation, position, quote.price) && (dialogPrice === null || recoveryExitAllowed(guard.lossObservation, position, dialogPrice))
        : isNonLosingExit(position, quote.price) && (dialogPrice === null || isNonLosingExit(position, dialogPrice))))
      && observedLossGuardAllowsPrice(guard, position, quote.price, market)
      && (dialogPrice === null || observedLossGuardAllowsPrice(guard, position, dialogPrice, market))
      && positionAmountGuardAllowsPrice(guard, position, quote.price)
      && (dialogPrice === null || positionAmountGuardAllowsPrice(guard, position, dialogPrice))
      && !guard?.profitFallback;
    if (allowed) lastExitCheck = { at: Date.now(), price: quote.price };
    return { ok: Boolean(allowed), code: quote ? "EXIT_CONDITION_CHANGED" : "EXIT_QUOTE_UNVERIFIED", price: allowed ? quote.price : null };
  };
  const withCompleted = (result) => {
    result = { ...result, stage, executionDurationMs: Date.now() - startedAt };
    const completedPositionIds = results.filter((item) => item.ok).flatMap((item) => item.targetPositionIds);
    if (!completedPositionIds.length) return { ...result, results };
    return { ok: true, code: "TRADE_PARTIALLY_SUBMITTED", message: "部分持仓已提交转让，先核实已提交持仓；剩余持仓继续由 AI 判断", filled: true, submitted: true, completedPositionIds, submittedQuantity: results.filter((item) => item.ok).reduce((sum, item) => sum + Number(item.submittedQuantity || 0), 0), results };
  };
  try {
    let targets = [target];
    if (exitType) {
      if (exitGuard && !await selectPageBoardInstrument(sessionId, { symbol, symbolName, instrumentId })) return { ok: false, code: "EXIT_INSTRUMENT_UNVERIFIED", submitted: false };
      const rows = await preparePositionRows(page, target).catch(() => []);
      if (!rows.length && (!aiProvider || !targetPositionIds.length)) return { ok: false, code: "EXIT_POSITION_NOT_FOUND", message: "持仓明细未显示目标持仓，未操作其他持仓", filled: false, submitted: false };
      if (exitGuard && (rows.length !== (exitGuard.positions?.length || 1) || rows.some(row => {
        const guard = exitGuard.positions?.find(item => item.positionId === row.id) || exitGuard;
        return row.id !== guard.positionId || row.quantity !== guard.quantity;
      }))) return { ok: false, code: "EXIT_CONDITION_CHANGED", submitted: false };
      targets = rows.length
        ? rows.map((row) => ({ ...target, targetPositionIds: row.id ? [row.id] : [], rowIndex: row.index, quantity: row.quantity }))
        : targetPositionIds.map((positionId) => ({ ...target, targetPositionIds: [String(positionId)], quantity }));
    } else {
      const filled = await fillSuggestionForm({ sessionId, action, price, quantity, symbol, symbolName, instrumentId, browserProvider, provider });
      if (!filled.ok) return { ...filled, submitted: false };
    }
    for (const positionTarget of targets) {
      actionClicked = false;
      stage = "recheck";
      if (exitGuard) {
        currentExitGuard = exitGuard.positions?.find(item => item.positionId === positionTarget.targetPositionIds[0]) || exitGuard;
        // Initial enumeration may finish on another page. Reacquire this
        // exact holding before reading its cost/quantity or opening its modal.
        await preparePositionRows(page, positionTarget);
        const guard = await verifyExitGuard();
        if (!guard.ok) return withCompleted({ ...guard, message: `离场复核未通过 [${guard.code}]${guard.message ? `：${guard.message}` : ""}`, submitted: false });
      }
      const baselineToken = await markTradePageHints(page);
      const writeResponse = watchTradeResponse(page);
      try {
        if (entryGuard) {
          const allowed = await entryGuard();
          if (!allowed.ok) return { ...allowed, submitted: false };
          if (rescueTrigger && allowed.price !== Number(price)) {
            const labels = suggestionFormLabels(action);
            const fields = await fillTradeFields(page, [{ labels: [labels.price, ...labels.extras.filter(item => /价/.test(item))], value: allowed.price }]);
            if (fields.length !== 1) return { ok: false, code: "RESCUE_PRICE_FIELD_UNVERIFIED", submitted: false };
            price = allowed.price;
          }
        }
        stage = "click";
        // Native confirm blocks DOM reads. Accept only against the immediately
        // preceding verified quote; a delayed modal is dismissed and retried
        // from a fresh observation instead of bypassing the loss/expiry guard.
        let clicked = exitType ? await clickPositionTransfer(page, positionTarget, { persistNativeDialog: true,
          canAcceptNative: exitGuard ? () => Boolean(lastExitCheck && Date.now() - lastExitCheck.at <= 1000
            && exitGuardAllowsPrice(currentExitGuard, lastExitCheck.price)) : undefined,
        }) : await clickTradeEntry(page, action, { persistNativeDialog: true });
        // A changed page needs a new AI plan. A failed or disabled click does
        // not: it must not be replayed through a second execution path.
        if (aiProvider && ["EXIT_CONTROL_NOT_FOUND", "EXIT_POSITION_NOT_FOUND", "SUBMIT_BUTTON_NOT_FOUND"].includes(clicked.code)) {
          const plan = await requestLiveBrowserPlan(page, aiProvider, {
            goal: exitType ? "EXIT_TRANSFER" : (action === "BUY" ? "ENTRY_BUY_UP" : "ENTRY_BUY_DOWN"),
            mode: "submit",
            action,
            exitType,
            targetPositionIds: positionTarget.targetPositionIds,
            price,
            quantity,
            instructions: exitType ? "只点击精确目标持仓行的转让控件，禁止点击止盈止损或全局转让。" : "点击当前页面匹配方向的订立提交按钮。",
          });
          const submitAction = plan.actions.find((item) => String(item?.field || "").toLowerCase() === "submit")
            || plan.actions.find((item) => String(item?.type || "").toLowerCase() === "click" && !/止盈|止损|全撤|全部/.test(String(item?.label || "")));
          const valid = plan.ok && submitAction && await clickPlannedControl(page, submitAction, { role: "button", targetPositionIds: positionTarget.targetPositionIds, snapshot: plan.snapshot });
          clicked = valid ? { clicked: true, label: String(submitAction.label || ""), quantity: positionTarget.quantity } : { clicked: false, code: plan.code || (exitType ? "EXIT_CONTROL_NOT_FOUND" : "SUBMIT_CONTROL_NOT_FOUND") };
        }
        if (!clicked.clicked) {
          return withCompleted({ ok: false, code: clicked.code, message: clicked.code === "SUBMIT_BUTTON_DISABLED" ? "入场按钮存在但网页禁用，继续刷新页面并重试" : "目标交易控件未就绪，继续刷新页面并重试", filled: true, submitted: false });
        }
        actionClicked = true;
        stage = "confirm";
        let dialog;
        try {
          dialog = await completeTradeDialogs(page, {
            exitType, orderType, price, baselineToken, initialConfirmed: clicked.nativeConfirmed === true,
            finished: () => Boolean(writeResponse.peek()) || (clicked.nativeConfirmationState?.confirmed === true
              && Date.now() - Number(clicked.nativeConfirmationState.confirmedAt || 0) >= 2000),
            canConfirm: exitGuard ? verifyExitGuard : entryGuard,
            resolveTransferPrice: exitGuard ? () => verifyExitGuard() : undefined,
            resolveConfirmation: aiProvider ? box => agentTradeConfirmation(page, box, aiProvider, { action, exitType, targetPositionIds: positionTarget.targetPositionIds, price, quantity }) : undefined,
          });
        } finally {
          clicked.nativeDialogCleanup?.();
        }
        if (!dialog.ok) return withCompleted({ ok: false, code: dialog.code, message: `交易确认未完成 [${dialog.code}]${dialog.message ? `：${dialog.message}` : ""}`, filled: true, submitted: false, uncertain: dialog.confirmed === true });
        stage = "feedback";
        const { response, pageHint } = await observeTradeFeedback(page, writeResponse, baselineToken);
        const result = { ...tradeSubmissionOutcome({ responseSeen: Boolean(response), responseOk: response ? response.ok() : null, pageHint, clicked }), targetPositionIds: positionTarget.targetPositionIds, submittedQuantity: clicked.quantity };
        results.push(result);
        if (!result.ok) {
          return withCompleted(result);
        }
      } finally {
        writeResponse.dispose();
        if (exitType) await dismissTransferDialogs(page, baselineToken);
      }
    }
    return { ...results[results.length - 1], stage, executionDurationMs: Date.now() - startedAt, targetPositionIds, submittedQuantity: results.reduce((sum, item) => sum + Number(item.submittedQuantity || 0), 0), results };
  } catch (error) {
    return withCompleted({ ok: false, code: "TRADE_SUBMIT_FAILED", message: error.message, filled: true, submitted: false, ...(actionClicked ? { uncertain: true } : {}) });
  }
}

export async function callTool(name, input) {
  if (name === "browser_navigate") return browserNavigate(input || {});
  if (name === "browser_extract_text") return browserExtract(input || {});
  if (name === "browser_scan_controls") return browserScanControls(input || {});
  if (name === "browser_login") return browserLogin(input || {});
  if (name === "browser_fill_suggestion") return fillSuggestionForm(input || {});
  if (name === "desktop_open_app") return openDesktopApp(input || {});
  if (name === "desktop_discover_app") return desktopDiscover(input || {});
  if (name === "shell_run") return runShell(input || {});
  return { ok: false, code: "TOOL_NOT_FOUND", message: `未知工具：${name}` };
}
