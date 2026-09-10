import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { extractHaohanPageInstrument } from "./haohan.mjs";

const sessions = new Map();

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

async function createSession(sessionId) {
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
  const context = await chromium.launchPersistentContext(profileDirectory(sessionId), options);
  const page = context.pages()[0] || await context.newPage();
  return { context, page, ownsBrowser: true, mode: options.headless ? "headless" : "visible" };
}

async function getSession(sessionId = "default") {
  const key = String(sessionId || "default");
  let session = sessions.get(key);
  if (!session) {
    session = await createSession(key);
    sessions.set(key, session);
  }
  if (session.page.isClosed()) session.page = await session.context.newPage();
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
    return { ok: false, code: "BROWSER_NAVIGATION_FAILED", message: error instanceof Error ? error.message : String(error) };
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
    const chartSamples = await collectChartSamples(session.page);
    return {
      ok: true,
      sessionId: String(sessionId || "default"),
      url: safeUrl(raw.url),
      title: String(raw.title || "").slice(0, 160),
      visibleText: redact(raw.visibleText),
      instrument: extractHaohanPageInstrument({ visibleText: raw.visibleText, title: raw.title }),
      tables,
      chartSamples: chartSamples.map(redact),
      capturedAt: Date.now(),
    };
  } catch (error) {
    return { ok: false, code: "BROWSER_READ_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
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

export function browserSessionIds() {
  return [...sessions.keys()];
}
