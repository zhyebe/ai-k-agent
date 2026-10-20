import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { extractHaohanPageInstrument, instrumentFromMarketDetail, samePageInstrument, uniquePageInstruments } from "./haohan.mjs";
import { activateTradeControl } from "./trade-controls.mjs";
import { collectCurrentOrderTables, collectPositionTables } from "./order-controls.mjs";

const sessions = new Map();
const sessionLaunches = new Map();
const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
let browserClosing = false;
let sessionFactory = null;

function browserLifecycleError(error) {
  return /target crashed|target page, context or browser has been closed|browser has been closed|page has been closed|context has been closed|browser disconnected/i.test(String(error?.message || error || ""));
}

function trackSessionPage(session) {
  if (!session || !session.page || session.page.__axiomHealthTracked) return session;
  session.pageCrashed = false;
  session.pageClosed = false;
  try {
    session.page.__axiomHealthTracked = true;
    session.page.on("crash", () => { session.pageCrashed = true; });
    session.page.on("close", () => { session.pageClosed = true; });
  } catch {}
  return session;
}

async function restoreBrowserSession(sessionId, oldSession = sessions.get(String(sessionId || "default"))) {
  const key = String(sessionId || "default");
  let restoreUrl = String(oldSession?.lastUrl || "");
  if (!restoreUrl) {
    try { restoreUrl = safeUrl(oldSession?.page?.url?.() || ""); } catch {}
  }
  await closeBrowserSession(key);
  const fresh = await getSession(key, false);
  if (restoreUrl && isAllowedUrl(restoreUrl)) {
    try {
      await fresh.page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      fresh.lastUrl = restoreUrl;
    } catch (error) {
      if (browserLifecycleError(error)) throw error;
    }
  }
  return fresh;
}

export function setBrowserSessionFactory(factory) {
  sessionFactory = factory;
  browserClosing = false;
}

function configuredValues(name, fallback) {
  const value = process.env[name];
  return new Set((value ? value.split(",") : fallback).map((item) => item.trim()).filter(Boolean));
}

function isAllowedUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const domains = configuredValues("BROWSER_ALLOWED_DOMAINS", ["localhost", "127.0.0.1", "smyw.haohandahan.cn"]);
  return [...domains].some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}${parsed.hash}`;
  } catch {
    return "";
  }
}

function hostnameOf(value) {
  try { return new URL(String(value || "")).hostname; } catch { return ""; }
}

function redact(text) {
  return String(text || "")
    .replace(/(sessionStr|session|password|passwd|token|access_token)\s*[=:：]\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/\b1\d{2}\d{4}\d{4}\b/g, (value) => `${value.slice(0, 3)}****${value.slice(-4)}`)
    .slice(0, 30000);
}

function chromePath() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function profileDirectory(sessionId) {
  const root = process.env.AXIOM_DATA_DIR || path.join(process.cwd(), ".axiom-data");
  const key = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24);
  return path.join(root, "browser-profiles", key);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
      if (state === "Z") return false;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function linkTarget(filePath) {
  try {
    const target = fs.readlinkSync(filePath);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(filePath), target);
  } catch {
    return "";
  }
}

export function cleanupStaleChromiumProfileLocks(
  profileDir,
  { hostname = os.hostname(), isProcessRunning = processIsRunning, pathExists = fs.existsSync } = {},
) {
  const lockPath = path.join(profileDir, "SingletonLock");
  const lockValue = (() => {
    try { return fs.readlinkSync(lockPath); } catch { return ""; }
  })();
  const owner = lockValue.match(/^(.*)-(\d+)$/);
  if (owner && owner[1] === hostname && isProcessRunning(Number(owner[2]))) return false;
  const socketTarget = linkTarget(path.join(profileDir, "SingletonSocket"));
  if (socketTarget && pathExists(socketTarget)) return false;
  let removed = false;
  for (const name of PROFILE_LOCK_FILES) {
    try {
      fs.unlinkSync(path.join(profileDir, name));
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

async function createSession(sessionId) {
  if (process.env.AXIOM_REQUIRE_DESKTOP_BROWSER === "1") throw new Error("SERVER_BROWSER_DISABLED");
  if (browserClosing) throw new Error("浏览器服务正在关闭");
  if (sessionFactory) return sessionFactory(sessionId);
  const { chromium } = await import("playwright");
  const cdpUrl = String(process.env.BROWSER_CDP_URL || "").trim();
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    return { browser, context, page, ownsBrowser: false, mode: "cdp" };
  }
  const options = {
    headless: process.env.AXIOM_BROWSER_HEADLESS !== "false",
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false,
  };
  const executablePath = chromePath();
  if (executablePath) options.executablePath = executablePath;
  const args = [];
  if (process.env.AXIOM_BROWSER_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  if (args.length) options.args = args;
  const profileDir = profileDirectory(sessionId);
  if (cleanupStaleChromiumProfileLocks(profileDir)) {
    console.warn(`Removed stale Chromium profile lock for session ${String(sessionId).slice(0, 80)}`);
  }
  const context = await chromium.launchPersistentContext(profileDir, options);
  const page = context.pages()[0] || await context.newPage();
  return { context, page, ownsBrowser: true, mode: options.headless ? "headless" : "visible" };
}

async function getSession(sessionId = "default", allowRecreate = true) {
  if (browserClosing) throw new Error("浏览器服务正在关闭");
  const key = String(sessionId || "default");
  let session = sessions.get(key);
  if (!session) {
    let launch = sessionLaunches.get(key);
    if (!launch) {
      launch = createSession(key)
        .then((created) => {
          trackSessionPage(created);
          sessions.set(key, created);
          return created;
        })
        .finally(() => {
          if (sessionLaunches.get(key) === launch) sessionLaunches.delete(key);
        });
      sessionLaunches.set(key, launch);
    }
    session = await launch;
  }
  const pageBroken = session.pageCrashed === true || session.pageClosed === true || (() => {
    try { return session.page.isClosed(); } catch { return true; }
  })();
  if (pageBroken) {
    if (!allowRecreate) throw new Error("BROWSER_PAGE_BROKEN");
    return restoreBrowserSession(key, session);
  }
  trackSessionPage(session);
  return { ...session, sessionId: key };
}

export async function collectTables(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const roots = [...document.querySelectorAll(".el-table, table, [role='table'], [role='grid']")]
      .filter((root) => visible(root) && !root.parentElement?.closest(".el-table, table, [role='table'], [role='grid']")).slice(0, 20);
    return roots.map((root) => {
      let owner = root.__vue__;
      while (owner && !owner.pageData) owner = owner.$parent;
      return {
        rows: [...root.querySelectorAll("tr, [role='row']")]
        .filter((row) => visible(row) && !row.closest(".el-table__fixed, .el-table__fixed-right, .el-table__footer-wrapper"))
        .slice(0, 120).map((row) => [...row.querySelectorAll("th, td, [role='columnheader'], [role='gridcell']")].slice(0, 30).map((cell) => String(cell.innerText || cell.textContent || "").trim())),
        emptyText: [...root.querySelectorAll(".el-table__empty-block, .el-table__empty-text")].filter(visible).map((node) => node.innerText).join(" "),
        loading: [...root.querySelectorAll(".el-loading-mask")].some(visible)
        || Boolean(owner?.pageData && (owner.pageData.total == null || owner.isNetWrong === true)),
      };
    }).filter((table) => table.rows.some((row) => row.length));
  });
}

async function collectHqChart(page) {
  return page.evaluate(() => {
    const serializeRow = (row) => {
      if (!row || typeof row !== "object") return null;
      const close = Number(row.Close ?? row.close);
      if (!Number.isFinite(close) || close <= 0) return null;
      return {
        Date: row.Date ?? row.date ?? null,
        Time: row.Time ?? row.time ?? 0,
        Open: row.Open ?? row.open ?? null,
        High: row.High ?? row.high ?? null,
        Low: row.Low ?? row.low ?? null,
        Close: close,
        Vol: row.Vol ?? row.Volume ?? row.volume ?? 0,
        Amount: row.Amount ?? row.amount ?? null,
        YClose: row.YClose ?? row.yclose ?? null,
        timestamp: Number(row.timestamp ?? row.DateTime ?? row.datetime) || null,
      };
    };
    const looksLikeRows = (data) => Array.isArray(data) && data.length >= 2 && data.some((row) => row && typeof row === "object" && (row.Close != null || row.close != null) && (row.Date != null || row.date != null));
    let best = [];
    let symbol = "";
    let period = "";
    const take = (data, meta = {}) => {
      if (!looksLikeRows(data) || data.length <= best.length) return;
      const rows = data.map(serializeRow).filter(Boolean);
      if (rows.length <= best.length) return;
      best = rows;
      if (meta.symbol) symbol = String(meta.symbol);
      if (meta.period != null) period = String(meta.period);
    };
    const inspectChart = (chart) => {
      if (!chart) return;
      const container = chart.JSChartContainer || chart;
      const meta = {
        symbol: container?.Symbol || chart.Symbol || container?.Name || "",
        period: container?.Period ?? chart.Period ?? "",
      };
      take(container?.SourceData?.Data, meta);
      if (typeof container?.SourceData?.GetData === "function") {
        try { take(container.SourceData.GetData(), meta); } catch {}
      }
      take(container?.HistoryData?.Data, meta);
      take(container?.ChartData?.Data, meta);
      take(container?.Data?.Data, meta);
      const paints = Array.isArray(container?.ChartPaint) ? container.ChartPaint : [];
      for (const paint of paints.slice(0, 8)) take(paint?.Data?.Data, meta);
    };
    const roots = [...document.querySelectorAll("#hqchart_kline, [id*='hqchart' i], [class*='hqchart' i], canvas")];
    const JSChart = window.JSChart;
    for (const element of roots) {
      let chart = element.JSChart || element.jsChart || null;
      if (!chart && JSChart && typeof JSChart.GetChart === "function") {
        try { chart = JSChart.GetChart(element); } catch {}
      }
      inspectChart(chart);
    }
    if (!best.length && JSChart && typeof JSChart.GetChart === "function") {
      try { inspectChart(JSChart.GetChart()); } catch {}
    }
    return { klines: best, symbol, period, klineCount: best.length };
  }).catch(() => ({ klines: [], symbol: "", period: "", klineCount: 0 }));
}

function productOptionText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractInstrumentOption(text, fromMenu = false) {
  const value = productOptionText(text);
  if (!value || value === "F10" || value.length > 80) return null;
  if (/登录|密码|可用资金|最新价|涨跌幅|持仓明细|销售|采购|显示全部|请选择/.test(value)) return null;
  if (/^(全部|买入|卖出|订立|转让)$/.test(value)) return null;
  const pipeMatch = value.match(/^([A-Z][A-Z0-9_.-]{1,24})\s*\|\s*(.+)$/);
  if (pipeMatch) return { symbol: pipeMatch[1], symbolName: pipeMatch[2], instrumentId: "" };
  const gluedMatch = value.match(/^([A-Z][A-Z0-9_-]{1,15})([\u4e00-\u9fff].+)$/);
  if (gluedMatch) return { symbol: gluedMatch[1], symbolName: gluedMatch[2], instrumentId: "" };
  const codeMatch = value.match(/^([A-Z][A-Z0-9_-]{1,15})\s+(.+)$/);
  if (codeMatch) return { symbol: codeMatch[1], symbolName: codeMatch[2], instrumentId: "" };
  if (/（二期）|一期|金尖|康砖/.test(value)) return { symbol: "", symbolName: value, instrumentId: "" };
  if (fromMenu && value.length >= 2 && value.length <= 40 && !/[:：%]/.test(value) && !/\d{4,}/.test(value)) {
    return { symbol: "", symbolName: value, instrumentId: "" };
  }
  return null;
}

async function readVisibleInstrumentOptions(page) {
  const raw = await page.evaluate(() => {
    const texts = [];
    const instruments = [];
    const pushDetails = (details) => {
      if (!Array.isArray(details)) return;
      for (const option of details) {
        if (!option || typeof option !== "object") continue;
        instruments.push({
          symbol: String(option.symbol || ""),
          commodityCode: String(option.commodityCode || ""),
          commodityName: String(option.commodityName || ""),
          symbolId: String(option.symbolId || ""),
          symbolCode: String(option.symbolCode || ""),
          code: String(option.code || ""),
          name: String(option.name || ""),
          unit: String(option.unit || ""),
          label: String(option.label || ""),
        });
      }
    };
    const pushSelectOptions = (instance) => {
      const options = instance?.options || instance?.cachedOptions || [];
      if (!Array.isArray(options)) return;
      for (const option of options) {
        if (!option || typeof option !== "object") continue;
        instruments.push({
          symbol: String(option.value ?? option.currentValue ?? option.symbol ?? ""),
          commodityName: String(option.label ?? option.currentLabel ?? option.symbolName ?? ""),
          symbolId: String(option.symbolId ?? ""),
        });
      }
    };
    let root = document.querySelector("#app")?.__vue__;
    while (root?.$parent) root = root.$parent;
    try { pushDetails(root?.$store?.state?.hqData?.marketDetails); } catch {}
    try { pushDetails(root?.commodityOptions); } catch {}
    for (const node of document.querySelectorAll(".el-select, .selectEl")) {
      try { pushSelectOptions(node.__vue__); } catch {}
    }
    for (const node of document.querySelectorAll(".el-select-dropdown__item, .el-select-dropdown [role='option'], .el-select-dropdown .el-option")) {
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 80) texts.push(text);
    }
    return { texts, instruments, storeCount: Array.isArray(root?.$store?.state?.hqData?.marketDetails) ? root.$store.state.hqData.marketDetails.length : 0 };
  }).catch(() => ({ texts: [], instruments: [], storeCount: 0 }));
  return uniquePageInstruments([
    ...(Array.isArray(raw.instruments) ? raw.instruments.map((item) => instrumentFromMarketDetail(item)).filter(Boolean) : []),
    ...(Array.isArray(raw.texts) ? raw.texts.map((text) => extractInstrumentOption(text, true)).filter(Boolean) : []),
  ]);
}

async function openProductMenu(page) {
  const opened = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const f10 = [...document.querySelectorAll("span, div, button, a")].find((el) => String(el.textContent || "").trim() === "F10" && el.children.length === 0 && visible(el));
    const nearby = f10?.closest(".el-row") || f10?.closest(".el-col")?.parentElement || document;
    const selects = [...nearby.querySelectorAll(".selectEl, .el-select")].filter(visible);
    const allSelects = selects.length ? selects : [...document.querySelectorAll(".selectEl, .el-select")].filter(visible);
    for (const node of allSelects) {
      const instance = node.__vue__;
      try {
        if (instance && typeof instance.toggleMenu === "function") {
          if (!instance.visible) instance.toggleMenu();
          if (instance.visible || instance.options?.length) return true;
        }
      } catch {}
      const trigger = node.querySelector("input, .el-input, .el-input__inner") || node;
      try { trigger.click(); } catch {}
    }
    return document.querySelectorAll(".el-select-dropdown__item, .el-select-dropdown .el-option").length > 0;
  }).catch(() => false);
  if (opened) {
    await page.waitForTimeout(500);
    return true;
  }
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("span, div, p, button, a, h1, h2, h3")];
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const f10 = nodes.find((el) => String(el.textContent || "").trim() === "F10" && el.children.length === 0 && visible(el));
    const f10Column = f10?.closest(".el-col") || f10?.parentElement;
    const adjacentSelect = f10Column?.previousElementSibling?.querySelector(".el-select, [role='combobox'], .el-input")
      || f10Column?.parentElement?.querySelector(".el-select, [role='combobox']");
    if (adjacentSelect) {
      const trigger = adjacentSelect.querySelector(".el-input, input, [role='combobox']") || adjacentSelect;
      trigger.click();
      return true;
    }
    const candidates = [];
    if (f10) {
      const root = f10.closest("header, section, nav, div") || f10.parentElement;
      if (root) candidates.push(...root.querySelectorAll("span, div, p, button, a"));
      if (f10.previousElementSibling) candidates.unshift(f10.previousElementSibling);
    }
    const scopedNodes = [...candidates, ...nodes];
    const productTrigger = scopedNodes.find((el) => {
      const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return text.length >= 2 && text.length <= 40 && /（二期）|金尖|康砖/.test(text) && !/F10/.test(text) && (el.children?.length || 0) <= 3;
    });
    const symbolTrigger = scopedNodes.find((el) => {
      const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return text !== "F10" && /^[A-Z][A-Z0-9_.-]{1,24}$/.test(text) && (el.children?.length || 0) <= 1;
    });
    const trigger = productTrigger || symbolTrigger;
    if (!trigger) return false;
    trigger.click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(500);
  return clicked;
}

async function collectChartSamples(page) {
  const selector = await page.evaluate(() => {
    const candidates = ["#hqchart_kline", ".hqchart_kline", "[id*='hqchart']", "canvas", "svg"];
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 120 && rect.height > 80;
    };
    const element = candidates.map((value) => document.querySelector(value)).find((value) => value && visible(value));
    if (!element) return "";
    if (element.id) return `#${element.id}`;
    if (element.classList?.length) return `.${String(element.classList[0]).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    return "";
  });
  if (!selector) return [];
  const chart = page.locator(selector).first();
  const box = await chart.boundingBox().catch(() => null);
  if (!box) return [];
  const tooltipSelectors = ["#customtooltip", ".customtooltip", "[class*='tooltip']"];
  const samples = [];
  const points = 18;
  for (let index = 0; index < points; index += 1) {
    const x = box.x + Math.max(2, box.width * (index + 1) / (points + 1));
    const y = box.y + box.height * 0.45;
    await page.mouse.move(x, y);
    await page.waitForTimeout(45);
    const text = await page.evaluate((selectors) => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const element = selectors.flatMap((value) => [...document.querySelectorAll(value)]).find(visible);
      return element ? String(element.innerText || element.textContent || "").trim() : "";
    }, tooltipSelectors).catch(() => "");
    if (text && !samples.includes(text)) samples.push(text.slice(0, 1600));
  }
  return samples;
}

export async function openBrowserPage({ sessionId = "default", url, waitMs = 1200, expectedHostname = "" } = {}, recoveryAttempt = 0) {
  if (!isAllowedUrl(url)) return { ok: false, code: "DOMAIN_NOT_ALLOWED", message: "目标域名不在浏览器白名单中" };
  try {
    const session = await getSession(sessionId);
    session.lastUrl = safeUrl(String(url));
    await session.page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 20000 });
    if (waitMs > 0) await session.page.waitForTimeout(Math.min(5000, Number(waitMs) || 0));
    const finalHostname = hostnameOf(session.page.url());
    if (expectedHostname && finalHostname !== String(expectedHostname).toLowerCase()) {
      return { ok: false, code: "BROWSER_REDIRECT_NOT_ALLOWED", message: "目标页面重定向到未授权域名", url: safeUrl(session.page.url()) };
    }
    const snapshot = await readVisiblePage(sessionId);
    return { ok: true, sessionId: session.sessionId, mode: session.mode, ...snapshot };
  } catch (error) {
    if (browserLifecycleError(error) && recoveryAttempt < 1) {
      try {
        await restoreBrowserSession(sessionId);
        return openBrowserPage({ sessionId, url, waitMs, expectedHostname }, recoveryAttempt + 1);
      } catch (recoveryError) {
        const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        return { ok: false, code: "BROWSER_NAVIGATION_FAILED", message: recoveryMessage.split("\n")[0].slice(0, 500) };
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "BROWSER_NAVIGATION_FAILED", message: message.split("\n")[0].slice(0, 500) };
  }
}

export async function readVisiblePage(sessionId = "default", { inspectPositions = false, quick = false, inspectCandles = false, accountScope = "full" } = {}, recoveryAttempt = 0) {
  const key = String(sessionId || "default");
  const session = sessions.has(key) ? await getSession(key) : null;
  if (!session) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先打开目标网页" };
  try {
    const orderTables = inspectPositions && accountScope !== "positions" ? await collectCurrentOrderTables(session.page, collectTables) : [];
    const positionTables = inspectPositions ? await collectPositionTables(session.page, collectTables) : [];
    const raw = await session.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      visibleText: document.body?.innerText || "",
    }));
    const tables = inspectPositions ? [...positionTables, ...orderTables] : await collectTables(session.page);
    const chart = quick && !inspectCandles ? { klines: [] } : await collectHqChart(session.page);
    const chartSamples = quick || (chart.klines?.length || 0) >= 20 ? [] : await collectChartSamples(session.page);
    const instrument = extractHaohanPageInstrument({ visibleText: raw.visibleText, title: raw.title });
    const chartInstrument = chart.symbol && /^\d+$/.test(String(chart.symbol))
      ? { symbol: "", symbolName: "", instrumentId: String(chart.symbol) }
      : null;
    const currentInstrument = {
      symbol: instrument.symbol || chartInstrument?.symbol || "",
      symbolName: instrument.symbolName || "",
      instrumentId: chartInstrument?.instrumentId || "",
    };
    const instruments = quick ? [currentInstrument] : uniquePageInstruments([currentInstrument, ...(await readVisibleInstrumentOptions(session.page))].filter(Boolean));
    return {
      ok: true,
      sessionId: String(sessionId || "default"),
      url: safeUrl(raw.url),
      title: String(raw.title || "").slice(0, 160),
      visibleText: redact(raw.visibleText),
      instrument: currentInstrument,
      instruments,
      klines: Array.isArray(chart.klines) ? chart.klines : [],
      chartSymbol: String(chart.symbol || ""),
      chartPeriod: String(chart.period || ""),
      tables,
      chartSamples: chartSamples.map(redact),
      capturedAt: Date.now(),
    };
  } catch (error) {
    if (browserLifecycleError(error) && recoveryAttempt < 1) {
      try {
        await restoreBrowserSession(key, session);
        return readVisiblePage(key, { inspectPositions, quick, inspectCandles, accountScope }, recoveryAttempt + 1);
      } catch (recoveryError) {
        return { ok: false, code: "BROWSER_READ_FAILED", message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) };
      }
    }
    return { ok: false, code: "BROWSER_READ_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function listPageBoardInstruments(sessionId = "default") {
  const session = sessions.get(String(sessionId || "default"));
  if (!session) return [];
  let found = await readVisibleInstrumentOptions(session.page);
  for (let attempt = 0; attempt < 3 && found.length < 2; attempt += 1) {
    await openProductMenu(session.page);
    await session.page.waitForTimeout(350);
    found = uniquePageInstruments([...found, ...(await readVisibleInstrumentOptions(session.page))]);
  }
  await session.page.keyboard.press("Escape").catch(() => {});
  const current = extractHaohanPageInstrument({
    visibleText: await session.page.evaluate(() => document.body?.innerText || "").catch(() => ""),
    title: await session.page.title().catch(() => ""),
  });
  return uniquePageInstruments([current, ...found].filter((item) => item?.symbol || item?.symbolName));
}

export async function selectPageBoardInstrument(sessionId, instrument) {
  const session = sessions.get(String(sessionId || "default"));
  if (!session || !instrument) return false;
  const readCurrent = async () => extractHaohanPageInstrument({
    visibleText: await session.page.evaluate(() => document.body?.innerText || "").catch(() => ""),
    title: await session.page.title().catch(() => ""),
  });
  if (samePageInstrument(await readCurrent(), instrument)) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openProductMenu(session.page);
    const clicked = await session.page.evaluate(({ name, symbol }) => {
      const nodes = [...document.querySelectorAll("[role='option'], .el-select-dropdown__item, .el-dropdown-menu__item, .el-popper li, .el-popper div, .el-popper span, .ant-select-item, [class*='dropdown'] li, [class*='dropdown'] div, [class*='dropdown'] span, [class*='select'] li, [class*='select'] div, [class*='select'] span")];
      const matches = [];
      for (const node of nodes) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) continue;
        if (node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")) continue;
        const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) continue;
        let score = 0;
        if (name && text === name) score = 100;
        else if (symbol && text === symbol) score = 95;
        else if (symbol && text.startsWith(`${symbol} `)) score = 85;
        else if (name && text.includes(name)) score = 75;
        else if (symbol && text.includes(symbol)) score = 65;
        if (score) matches.push({ node, text, score });
      }
      matches.sort((left, right) => right.score - left.score || left.text.length - right.text.length);
      if (!matches.length) return false;
      matches[0].node.click();
      return true;
    }, { name: instrument.symbolName || "", symbol: instrument.symbol || "" }).catch(() => false);
    if (!clicked) {
      await session.page.keyboard.press("Escape").catch(() => {});
      continue;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await session.page.waitForTimeout(250);
      if (samePageInstrument(await readCurrent(), instrument)) {
        await session.page.waitForTimeout(700);
        return true;
      }
    }
    await session.page.keyboard.press("Escape").catch(() => {});
  }
  return false;
}

export async function collectAllPageBoards(sessionId, instruments = [], { restore = true } = {}) {
  const session = sessions.get(String(sessionId || "default"));
  if (!session) return [];
  const targets = uniquePageInstruments(instruments);
  if (!targets.length) return [];
  const original = extractHaohanPageInstrument({
    visibleText: await session.page.evaluate(() => document.body?.innerText || "").catch(() => ""),
    title: await session.page.title().catch(() => ""),
  });
  const snapshots = [];
  for (const instrument of targets) {
    const selected = await selectPageBoardInstrument(sessionId, instrument);
    const snapshot = await readVisiblePage(sessionId);
    snapshots.push({ instrument, selected, snapshot });
  }
  if (restore && (original.symbol || original.symbolName)) await selectPageBoardInstrument(sessionId, original);
  return snapshots;
}

export async function getBrowserPage(sessionId = "default") {
  const key = String(sessionId || "default");
  if (!sessions.has(key)) return null;
  try {
    return (await getSession(key)).page || null;
  } catch {
    return null;
  }
}

// Accessibility-style snapshot for agentic browser control. IDs are scoped to
// one snapshot and attached to live DOM nodes so callers can validate a model
// plan immediately before executing it. Never include password values.
export async function scanBrowserControls(sessionId = "default", options = {}) {
  const page = await getBrowserPage(sessionId);
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", controls: [] };
  const snapshot = await scanBrowserPage(page, options);
  return snapshot.ok ? { ...snapshot, sessionId } : snapshot;
}

export async function scanBrowserPage(page, { maxControls = 120, maxText = 12000 } = {}) {
  if (!page) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", controls: [] };
  const token = `axiom-snapshot-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const snapshot = await page.evaluate(({ token: snapshotToken, max: limit, textLimit }) => {
      const visible = (node) => {
        if (!node || !(node instanceof Element)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const compact = (value, limit = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const labelFor = (node) => {
        const id = node.getAttribute("id");
        const explicit = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const parent = node.closest("label");
        const labelled = node.getAttribute("aria-labelledby");
        const labelledText = labelled ? labelled.split(/\s+/).map((key) => document.getElementById(key)?.innerText || "").join(" ") : "";
        return compact(explicit?.innerText || parent?.innerText || labelledText || node.getAttribute("aria-label") || node.getAttribute("title") || "");
      };
      const roleFor = (node) => {
        const explicit = node.getAttribute("role");
        if (explicit) return explicit;
        if (node.matches("button, input[type='button'], input[type='submit']")) return "button";
        if (node.matches("a")) return "link";
        if (node.matches("input, textarea, select")) return node.type === "checkbox" ? "checkbox" : "textbox";
        return "button";
      };
      const selector = "button, input, textarea, select, [role='button'], [role='checkbox'], [role='tab'], a, summary, [contenteditable='true']";
      const controls = [];
      document.querySelectorAll(selector).forEach((node) => {
        if (controls.length >= limit || !visible(node)) return;
        if (node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true") return;
        const role = roleFor(node);
        const type = compact(node.getAttribute("type") || (node instanceof HTMLInputElement ? node.type : ""), 30);
        const sensitiveValue = ["password", "text", "tel", "email"].includes(type.toLowerCase());
        const label = compact((!sensitiveValue && node.value) || labelFor(node) || node.innerText || node.textContent, 120);
        const placeholder = compact(node.getAttribute("placeholder"), 120);
        const name = compact(node.getAttribute("name"), 80);
        const text = compact(node.innerText || node.textContent, 160);
        if (!label && !placeholder && !name && role !== "textbox") return;
        const id = `${snapshotToken}-${controls.length + 1}`;
        node.setAttribute("data-axiom-control", id);
        controls.push({
          id,
          role,
          type,
          label,
          text,
          placeholder,
          name,
          checked: role === "checkbox" ? Boolean(node.checked || node.getAttribute("aria-checked") === "true") : undefined,
          value: sensitiveValue ? undefined : compact(node.value, 120),
        });
      });
      return {
        url: location.href,
        title: compact(document.title, 200),
        text: compact(document.body?.innerText, textLimit),
        controls,
      };
    }, { token, max: Math.min(240, Math.max(1, Number(maxControls) || 120)), textLimit: Math.min(20000, Math.max(1000, Number(maxText) || 12000)) });
    return { ok: true, snapshotToken: token, ...snapshot };
  } catch (error) {
    return { ok: false, code: "BROWSER_SNAPSHOT_FAILED", message: error.message, controls: [] };
  }
}

export async function resolveSnapshotControl(page, controlId, { role = "", targetPositionIds = [] } = {}) {
  const id = String(controlId || "").trim();
  if (!id || !page) return null;
  const locator = page.locator(`[data-axiom-control="${id.replace(/"/g, "\\\"")}"]`).first();
  try {
    if (await locator.count() !== 1 || !await locator.isVisible({ timeout: 800 }) || await locator.isDisabled().catch(() => false)) return null;
    if (role && String(await locator.getAttribute("role") || "") !== role && !await locator.evaluate((node, expected) => {
      if (expected === "button") return node.matches("button, input[type='button'], input[type='submit'], a, [role='button'], [role='tab']");
      if (expected === "textbox") return node.matches("input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']");
      if (expected === "checkbox") return node.matches("input[type='checkbox'], [role='checkbox']");
      return false;
    }, role)) return null;
    if (targetPositionIds.length) {
      const wanted = targetPositionIds.map((value) => String(value || "").replace(/[\s_./\\-]+/g, "").toLocaleLowerCase()).filter(Boolean);
      const rowText = await locator.evaluate((node) => node.closest("tr, [role='row'], .el-table__row, .position-row")?.innerText || node.parentElement?.innerText || "").catch(() => "");
      const normalized = String(rowText).replace(/[\s_./\\-]+/g, "").toLocaleLowerCase();
      if (wanted.length && !wanted.some((value) => normalized.includes(value))) return null;
    }
    return locator;
  } catch (error) {
    if (browserLifecycleError(error)) throw error;
    return null;
  }
}

export async function recoverBrowserSession(sessionId = "default") {
  const key = String(sessionId || "default");
  if (!sessions.has(key)) return null;
  return (await restoreBrowserSession(key)).page || null;
}

export async function closeBrowserSession(sessionId = "default") {
  const key = String(sessionId || "default");
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  if (session.close) {
    await session.close();
    return true;
  }
  try { await session.context.close(); } catch {}
  if (session.ownsBrowser && session.browser) {
    try { await session.browser.close(); } catch {}
  }
  return true;
}

export async function closeAllBrowserSessions() {
  browserClosing = true;
  await Promise.allSettled([...sessionLaunches.values()]);
  const keys = [...sessions.keys()];
  const results = await Promise.allSettled(keys.map((key) => closeBrowserSession(key)));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "BROWSER_SESSION_CLOSE_FAILED");
  return keys.length;
}

export function browserSessionIds() {
  return [...sessions.keys()];
}
