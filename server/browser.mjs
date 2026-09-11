import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { extractHaohanPageInstrument, samePageInstrument, uniquePageInstruments } from "./haohan.mjs";

const sessions = new Map();
const sessionLaunches = new Map();
const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
let browserClosing = false;

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
  if (browserClosing) throw new Error("浏览器服务正在关闭");
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
  try {
    if (session.page.isClosed()) session.page = await session.context.newPage();
  } catch (error) {
    if (!allowRecreate) throw error;
    await closeBrowserSession(key);
    return getSession(key, false);
  }
  return { ...session, sessionId: key };
}

async function collectTables(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const roots = [...document.querySelectorAll("table, [role='table'], [role='grid']")].filter(visible).slice(0, 20);
    return roots.map((root) => ({
      rows: [...root.querySelectorAll("tr, [role='row']")].slice(0, 120).map((row) => [...row.querySelectorAll("th, td, [role='columnheader'], [role='gridcell']")].slice(0, 30).map((cell) => String(cell.innerText || cell.textContent || "").trim())),
    })).filter((table) => table.rows.some((row) => row.length));
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
  if (/登录|密码|可用资金|最新价|涨跌幅|持仓明细|销售|采购/.test(value)) return null;
  const pipeMatch = value.match(/^([A-Z][A-Z0-9_.-]{1,24})\s*\|\s*(.+)$/);
  if (pipeMatch) return { symbol: pipeMatch[1], symbolName: pipeMatch[2], instrumentId: "" };
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
    const seenInstances = new Set();
    const queue = [...document.querySelectorAll("*")].map((node) => node.__vue__).filter(Boolean);
    while (queue.length && seenInstances.size < 3000) {
      const instance = queue.shift();
      if (!instance || seenInstances.has(instance)) continue;
      seenInstances.add(instance);
      if (instance.$parent) queue.push(instance.$parent);
      if (Array.isArray(instance.$children)) queue.push(...instance.$children);
      let options = [];
      try { options = Array.isArray(instance.commodityOptions) ? instance.commodityOptions : []; } catch {}
      for (const option of options) {
        if (!option || typeof option !== "object") continue;
        const rawSymbol = String(option.symbol || "").trim();
        const symbol = /^[A-Z][A-Z0-9_-]{1,15}$/.test(rawSymbol)
          ? rawSymbol
          : [option.commodityCode, option.symbolCode, option.code].map((value) => String(value || "").trim()).find((value) => /^[A-Z][A-Z0-9_-]{1,15}$/.test(value)) || "";
        const symbolName = String(option.commodityName || option.name || option.unit || option.symbolName || option.label || (!symbol ? rawSymbol : "")).replace(/\s+/g, " ").trim();
        const instrumentId = String(option.symbolId ?? option.contractId ?? "").trim();
        if (symbol || symbolName || instrumentId) instruments.push({ symbol, symbolName, instrumentId });
      }
    }
    const selectors = [
      "[role='option']",
      ".el-select-dropdown__item",
      ".el-dropdown-menu__item",
      ".el-popper li",
      ".el-popper div",
      ".el-popper span",
      ".ant-select-item",
      "[class*='dropdown'] li",
      "[class*='dropdown'] div",
      "[class*='dropdown'] span",
      "[class*='select'] li",
      "[class*='select'] div",
      "[class*='select'] span",
      "body *",
    ];
    for (const node of selectors.flatMap((selector) => [...document.querySelectorAll(selector)])) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) continue;
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const isExplicitProduct = /（二期）|一期|金尖|康砖/.test(text)
        && !/最新价|涨跌幅|买价|卖价|买量|卖量|持仓|销售|采购|可用资金/.test(text);
      if (selector === "body *" && (!isExplicitProduct || text.length > 80 || (node.children?.length || 0) > 3)) continue;
      if (text) texts.push(text);
    }
    return { texts, instruments };
  }).catch(() => ({ texts: [], instruments: [] }));
  return uniquePageInstruments([
    ...(Array.isArray(raw.instruments) ? raw.instruments : []),
    ...(Array.isArray(raw.texts) ? raw.texts.map((text) => extractInstrumentOption(text, true)).filter(Boolean) : []),
  ]);
}

async function openProductMenu(page) {
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

export async function openBrowserPage({ sessionId = "default", url, waitMs = 1200, expectedHostname = "" } = {}) {
  if (!isAllowedUrl(url)) return { ok: false, code: "DOMAIN_NOT_ALLOWED", message: "目标域名不在浏览器白名单中" };
  try {
    const session = await getSession(sessionId);
    await session.page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 20000 });
    if (waitMs > 0) await session.page.waitForTimeout(Math.min(5000, Number(waitMs) || 0));
    const finalHostname = hostnameOf(session.page.url());
    if (expectedHostname && finalHostname !== String(expectedHostname).toLowerCase()) {
      return { ok: false, code: "BROWSER_REDIRECT_NOT_ALLOWED", message: "目标页面重定向到未授权域名", url: safeUrl(session.page.url()) };
    }
    const snapshot = await readVisiblePage(sessionId);
    return { ok: true, sessionId: session.sessionId, mode: session.mode, ...snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "BROWSER_NAVIGATION_FAILED", message: message.split("\n")[0].slice(0, 500) };
  }
}

export async function readVisiblePage(sessionId = "default") {
  const session = sessions.get(String(sessionId || "default"));
  if (!session) return { ok: false, code: "BROWSER_SESSION_NOT_FOUND", message: "请先打开目标网页" };
  try {
    const raw = await session.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      visibleText: document.body?.innerText || "",
    }));
    const tables = await collectTables(session.page);
    const chart = await collectHqChart(session.page);
    const chartSamples = (chart.klines?.length || 0) >= 20 ? [] : await collectChartSamples(session.page);
    const instrument = extractHaohanPageInstrument({ visibleText: raw.visibleText, title: raw.title });
    const chartInstrument = chart.symbol
      ? (/^\d+$/.test(String(chart.symbol))
        ? { symbol: "", symbolName: "", instrumentId: String(chart.symbol) }
        : { symbol: String(chart.symbol), symbolName: "", instrumentId: "" })
      : null;
    const currentInstrument = {
      symbol: instrument.symbol || chartInstrument?.symbol || "",
      symbolName: instrument.symbolName || "",
      instrumentId: chartInstrument?.instrumentId || "",
    };
    const instruments = uniquePageInstruments([currentInstrument, ...(await readVisibleInstrumentOptions(session.page))].filter(Boolean));
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
    return { ok: false, code: "BROWSER_READ_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function listPageBoardInstruments(sessionId = "default") {
  const session = sessions.get(String(sessionId || "default"));
  if (!session) return [];
  const visible = await readVisibleInstrumentOptions(session.page);
  if (visible.length >= 2) return visible;
  await openProductMenu(session.page);
  const opened = await readVisibleInstrumentOptions(session.page);
  await session.page.keyboard.press("Escape").catch(() => {});
  const current = extractHaohanPageInstrument({
    visibleText: await session.page.evaluate(() => document.body?.innerText || "").catch(() => ""),
    title: await session.page.title().catch(() => ""),
  });
  return uniquePageInstruments([current, ...opened, ...visible].filter((item) => item?.symbol || item?.symbolName));
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

export async function collectAllPageBoards(sessionId, instruments = []) {
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
  if (original.symbol || original.symbolName) await selectPageBoardInstrument(sessionId, original);
  return snapshots;
}

export async function getBrowserPage(sessionId = "default") {
  const session = sessions.get(String(sessionId || "default"));
  return session?.page || null;
}

export async function closeBrowserSession(sessionId = "default") {
  const key = String(sessionId || "default");
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
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
  await Promise.allSettled(keys.map((key) => closeBrowserSession(key)));
  return keys.length;
}

export function browserSessionIds() {
  return [...sessions.keys()];
}
