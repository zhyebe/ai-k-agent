const { app, net, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  compareVersions,
  downloadProgressPercent,
  installerDownloadUrls,
  isLoopbackApiUrl,
  normalizeVersion,
  selectInstallerAsset,
  windowsInstallScript,
} = require("./update-state.cjs");

const RELEASE_API_URL = "https://api.github.com/repos/zhyebe/ai-k-agent/releases/latest";
const RELEASE_PAGE_URL = "https://github.com/zhyebe/ai-k-agent/releases/latest";
const UPDATE_REQUEST_TIMEOUT_MS = 15_000;
const INSTALLER_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

async function checkForUpdates(apiBaseUrl = "") {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchLatestReleaseInfo(currentVersion, apiBaseUrl);
    const available = compareVersions(release.latestVersion, currentVersion) > 0;
    return {
      currentVersion,
      latestVersion: release.latestVersion,
      available,
      releaseUrl: release.releaseUrl,
      asset: release.asset,
      message: available
        ? release.asset
          ? `发现新版本 v${release.latestVersion}`
          : `发现新版本 v${release.latestVersion}，但没有匹配当前系统的安装包。`
        : "当前已是最新版本",
    };
  } catch (error) {
    return {
      currentVersion,
      available: false,
      message: `检查更新失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function downloadInstaller(asset, { apiBaseUrl = "", onProgress, signal } = {}) {
  const urls = installerDownloadUrls({ apiBaseUrl, asset });
  if (!urls.length) throw new Error("没有匹配当前系统的安装包");
  const targetDir = path.join(app.getPath("downloads"), "Axiom Agent Updates");
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, sanitizeFileName(asset.name));
  const errors = [];
  for (const url of urls) {
    try {
      await downloadToFile(url, filePath, {
        expectedSize: Number(asset.size || 0),
        onProgress,
        signal,
      });
      return filePath;
    } catch (error) {
      if (signal?.aborted) throw new Error("下载已取消");
      errors.push(`${hostnameOf(url)}：${error instanceof Error ? error.message : String(error)}`);
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore incomplete file */ }
    }
  }
  throw new Error(`安装包下载失败。${errors.slice(0, 3).join("；")}`);
}

async function openInstaller(filePath) {
  if (process.platform === "win32") {
    await spawnWindowsInstallerAfterKill(filePath);
    return;
  }
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
}

function spawnWindowsInstallerAfterKill(filePath) {
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axiom-update-")), "install.cmd");
  fs.writeFileSync(scriptPath, windowsInstallScript({ pid: process.pid, installerPath: filePath }), "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.unref();
    resolve();
  });
}

async function fetchLatestReleaseInfo(currentVersion, apiBaseUrl = "") {
  const fromApi = await fetchApiReleaseInfo(apiBaseUrl, currentVersion);
  if (fromApi) return fromApi;
  try {
    const response = await fetchForUpdate(RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `AxiomAgent/${currentVersion}`,
      },
    });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name || "");
    if (!latestVersion) throw new Error("没有找到可用的 release 版本。");
    return {
      latestVersion,
      releaseUrl: release.html_url || RELEASE_PAGE_URL,
      asset: selectInstallerAsset(
        (release.assets || []).map((asset) => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
        })),
        { platform: process.platform, arch: process.arch },
      ),
    };
  } catch {
    const fallback = await fetchReleasePageInfo(currentVersion);
    if (fallback) return fallback;
    throw new Error("无法连接到 GitHub release 页面。");
  }
}

async function fetchApiReleaseInfo(apiBaseUrl, currentVersion) {
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  if (!base || isLoopbackApiUrl(base)) return null;
  try {
    const response = await fetchForUpdate(`${base}/api/updates/latest`, {
      headers: {
        Accept: "application/json",
        "User-Agent": `AxiomAgent/${currentVersion}`,
      },
    });
    if (!response.ok) return null;
    const release = await response.json();
    const latestVersion = normalizeVersion(release.latestVersion || "");
    if (!latestVersion) return null;
    return {
      latestVersion,
      releaseUrl: release.releaseUrl || RELEASE_PAGE_URL,
      asset: selectInstallerAsset(release.assets || [], { platform: process.platform, arch: process.arch }),
    };
  } catch {
    return null;
  }
}

async function fetchReleasePageInfo(currentVersion) {
  const response = await fetchForUpdate(RELEASE_PAGE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": `AxiomAgent/${currentVersion}`,
    },
  });
  if (!response.ok) return null;
  const releaseUrl = response.url || RELEASE_PAGE_URL;
  const html = await response.text();
  const latestVersion = extractVersionFromReleaseUrl(releaseUrl) || extractVersionFromReleaseHtml(html);
  if (!latestVersion) return null;
  return {
    latestVersion,
    releaseUrl,
    asset: selectInstallerAsset(extractAssetsFromReleaseHtml(html), { platform: process.platform, arch: process.arch }),
  };
}

async function downloadToFile(url, filePath, { expectedSize = 0, onProgress, signal } = {}) {
  const response = await fetchInstaller(url, signal);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 120)}` : ""}`);
  }
  const total = Number(response.headers.get("content-length") || 0) || expectedSize || 0;
  if (typeof onProgress === "function") onProgress(downloadProgressPercent(0, total));
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (expectedSize && bytes.length < expectedSize) throw new Error(`安装包下载不完整：${bytes.length}/${expectedSize} bytes`);
    fs.writeFileSync(filePath, bytes);
    if (typeof onProgress === "function") onProgress(100);
    return filePath;
  }
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let received = 0;
    const fail = (error) => {
      file.destroy();
      reject(error);
    };
    file.on("error", fail);
    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          file.end(() => resolve());
          return;
        }
        received += value.byteLength;
        if (typeof onProgress === "function") onProgress(downloadProgressPercent(received, total));
        if (!file.write(Buffer.from(value))) file.once("drain", pump);
        else pump();
      }).catch(fail);
    };
    pump();
  });
  const size = fs.statSync(filePath).size;
  if (expectedSize && size < expectedSize) throw new Error(`安装包下载不完整：${size}/${expectedSize} bytes`);
  if (typeof onProgress === "function") onProgress(100);
  return filePath;
}

async function fetchInstaller(url, externalSignal) {
  const requestInit = {
    redirect: "follow",
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": `AxiomAgent/${app.getVersion()}`,
    },
  };
  const withTimeout = (factory) => fetchWithTimeout(
    (timeoutSignal) => factory(mergeAbortSignals(externalSignal, timeoutSignal)),
    INSTALLER_DOWNLOAD_TIMEOUT_MS,
  );
  try {
    return await withTimeout((signal) => net.fetch(url, { ...requestInit, signal }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return withTimeout((signal) => fetch(url, { ...requestInit, signal }));
  }
}

function mergeAbortSignals(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([left, right]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) {
    abort();
    return controller.signal;
  }
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function hostnameOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "download";
  }
}

async function fetchForUpdate(url, init) {
  const requestInit = { ...init, redirect: "follow" };
  try {
    return await fetchWithTimeout((signal) => net.fetch(url, { ...requestInit, signal }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fetchWithTimeout((signal) => fetch(url, { ...requestInit, signal }));
  }
}

async function fetchWithTimeout(fn, timeoutMs = UPDATE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (isAbortError(error)) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error) {
  return error?.name === "AbortError" || (error instanceof Error && /\baborte?d?\b/i.test(error.message) && !/请求超时/.test(error.message));
}

function extractVersionFromReleaseUrl(url) {
  const match = String(url || "").match(/\/releases\/tag\/v?([^/?#]+)/i);
  return match ? normalizeVersion(match[1] || "") : "";
}

function extractVersionFromReleaseHtml(html) {
  const match = String(html || "").match(/\/zhyebe\/ai-k-agent\/releases\/tag\/v?([0-9][^"'<>/]*)/i);
  return match ? normalizeVersion(match[1] || "") : "";
}

function extractAssetsFromReleaseHtml(html) {
  const assets = new Map();
  const pattern = /href=["']([^"']*\/zhyebe\/ai-k-agent\/releases\/download\/v[^"']+\.(?:dmg|exe))["']/gi;
  let match = pattern.exec(html);
  while (match) {
    const url = absoluteGithubUrl(decodeHtml(match[1] || ""));
    const name = decodeURIComponent(url.split("/").pop() || "");
    if (name) assets.set(url, { name, url });
    match = pattern.exec(html);
  }
  return Array.from(assets.values());
}

function absoluteGithubUrl(value) {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://github.com${value.startsWith("/") ? "" : "/"}${value}`;
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&");
}

function sanitizeFileName(value) {
  return String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "Axiom.Agent.Update";
}

module.exports = {
  checkForUpdates,
  downloadInstaller,
  openInstaller,
};
