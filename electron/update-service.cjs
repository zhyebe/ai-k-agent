const { app, net, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  compareVersions,
  normalizeVersion,
  selectInstallerAsset,
  windowsInstallScript,
} = require("./update-state.cjs");

const RELEASE_API_URL = "https://api.github.com/repos/zhyebe/ai-k-agent/releases/latest";
const RELEASE_PAGE_URL = "https://github.com/zhyebe/ai-k-agent/releases/latest";
const UPDATE_REQUEST_TIMEOUT_MS = 15_000;
const INSTALLER_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchLatestReleaseInfo(currentVersion);
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

async function downloadInstaller(asset) {
  if (!asset?.url || !asset?.name) throw new Error("没有匹配当前系统的安装包");
  const targetDir = path.join(app.getPath("downloads"), "Axiom Agent Updates");
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, sanitizeFileName(asset.name));
  const response = await fetchInstaller(asset.url);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub 返回 ${response.status}${detail ? `：${detail.slice(0, 180)}` : ""}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (asset.size && bytes.length < asset.size) {
    throw new Error(`安装包下载不完整：${bytes.length}/${asset.size} bytes`);
  }
  fs.writeFileSync(filePath, bytes);
  return filePath;
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

async function fetchLatestReleaseInfo(currentVersion) {
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

async function fetchInstaller(url) {
  const requestInit = {
    redirect: "follow",
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": `AxiomAgent/${app.getVersion()}`,
    },
  };
  try {
    return await fetchWithTimeout((signal) => net.fetch(url, { ...requestInit, signal }), INSTALLER_DOWNLOAD_TIMEOUT_MS);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fetchWithTimeout((signal) => fetch(url, { ...requestInit, signal }), INSTALLER_DOWNLOAD_TIMEOUT_MS);
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
  return error instanceof Error && /abort|aborted|timeout/i.test(error.message);
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
