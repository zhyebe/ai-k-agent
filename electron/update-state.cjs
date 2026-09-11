const path = require("node:path");

function emptyUpdateState(currentVersion = "dev") {
  return {
    status: "disabled",
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    progress: 0,
    error: null,
  };
}

function hasDownloadedPackage(state) {
  return Boolean(state?.downloadedVersion) || state?.status === "downloaded" || state?.status === "installing";
}

function shouldSkipUpdateCheck(state) {
  return state?.status === "downloading" || state?.status === "downloaded" || state?.status === "installing";
}

function isWindowsPortableApp(env = process.env, platform = process.platform) {
  return platform === "win32" && Boolean(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR);
}

function supportsDesktopAutoUpdate({ isPackaged, platform, env = process.env } = {}) {
  if (!isPackaged) return false;
  if (isWindowsPortableApp(env, platform)) return false;
  return platform === "darwin" || platform === "win32";
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function compareVersions(first, second) {
  const left = normalizeVersion(first).split(".").map((part) => Number(part.replace(/[^0-9].*$/, "")) || 0);
  const right = normalizeVersion(second).split(".").map((part) => Number(part.replace(/[^0-9].*$/, "")) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function selectInstallerAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  const candidates = (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset?.name && asset?.url)
    .map((asset) => ({ name: asset.name, url: asset.url, size: asset.size }));

  if (platform === "win32") {
    const installers = candidates.filter((asset) => /\.exe$/i.test(asset.name) && !/portable/i.test(asset.name));
    return installers.find((asset) => /setup\.exe$/i.test(asset.name)) || installers[0] || null;
  }

  if (platform === "darwin") {
    const dmgs = candidates.filter((asset) => /\.dmg$/i.test(asset.name));
    if (arch === "arm64") return dmgs.find((asset) => /arm64|universal/i.test(asset.name)) || dmgs[0] || null;
    return dmgs.find((asset) => /x64|universal/i.test(asset.name) && !/arm64/i.test(asset.name)) || dmgs.find((asset) => /universal/i.test(asset.name)) || dmgs[0] || null;
  }

  return null;
}

function requirePositiveInteger(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("INVALID_PID");
  return pid;
}

function isAbsoluteFsPath(filePath) {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
}

function assertSafeFsPath(filePath) {
  const value = String(filePath || "");
  if (!value || !isAbsoluteFsPath(value) || /[\r\n"%]/.test(value)) throw new Error("INVALID_UPDATE_PATH");
  return value;
}

function windowsInstallScript({ pid, installerPath }) {
  const safePid = requirePositiveInteger(pid);
  const installer = assertSafeFsPath(installerPath);
  if (!/\.exe$/i.test(installer) || /portable/i.test(installer)) throw new Error("INVALID_UPDATE_PATH");
  return [
    "@echo off",
    "timeout /t 1 /nobreak >nul",
    `taskkill /F /PID ${safePid} /T >nul 2>&1`,
    "timeout /t 2 /nobreak >nul",
    `start "" "${installer}"`,
    "",
  ].join("\r\n");
}

function reduceUpdateState(current, patch = {}) {
  const previous = current || emptyUpdateState();
  const next = { ...previous, ...patch };
  const downloadedVersion = next.downloadedVersion || previous.downloadedVersion || null;

  if (downloadedVersion && next.status === "error") {
    next.status = "downloaded";
    next.downloadedVersion = downloadedVersion;
  }

  if (next.status === "downloaded" || next.status === "installing") {
    next.downloadedVersion = downloadedVersion || next.availableVersion || previous.downloadedVersion;
  }

  return next;
}

function updateIntent(state) {
  if (!state || ["disabled", "unsupported"].includes(state.status)) return "none";
  if (["checking", "downloading", "installing"].includes(state.status)) return "wait";
  if (state.status === "downloaded") return "install";
  if (state.status === "available") return "download";
  return "check";
}

function downloadProgressPercent(received, total) {
  const got = Number(received) || 0;
  const size = Number(total) || 0;
  if (size <= 0) return got > 0 ? 1 : 0;
  return Math.max(0, Math.min(99, Math.floor((got / size) * 100)));
}

function isLoopbackApiUrl(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function installerDownloadUrls({ apiBaseUrl = "", asset } = {}) {
  const urls = [];
  const name = String(asset?.name || "");
  const official = String(asset?.url || "");
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  if (base && name && !isLoopbackApiUrl(base)) {
    urls.push(`${base}/api/updates/download/${encodeURIComponent(name)}`);
  }
  if (official) {
    urls.push(official);
    if (/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//i.test(official)) {
      urls.push(`https://ghfast.top/${official}`);
      urls.push(`https://gh-proxy.com/${official}`);
    }
  }
  return [...new Set(urls.filter(Boolean))];
}

module.exports = {
  emptyUpdateState,
  hasDownloadedPackage,
  shouldSkipUpdateCheck,
  isWindowsPortableApp,
  supportsDesktopAutoUpdate,
  normalizeVersion,
  compareVersions,
  selectInstallerAsset,
  windowsInstallScript,
  reduceUpdateState,
  updateIntent,
  downloadProgressPercent,
  isLoopbackApiUrl,
  installerDownloadUrls,
};
