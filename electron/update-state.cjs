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

function installForceQuitDelayMs(platform) {
  // Windows NSIS already schedules quit after spawning setup.exe; a backup quit
  // covers the case where the installer started but the app stayed open.
  // macOS Squirrel.Mac must keep this process alive to pipe the zip — force-quit
  // here is what surfaces as "Cannot pipe update".
  if (platform === "win32") return 2500;
  return 0;
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

module.exports = {
  emptyUpdateState,
  hasDownloadedPackage,
  shouldSkipUpdateCheck,
  isWindowsPortableApp,
  supportsDesktopAutoUpdate,
  installForceQuitDelayMs,
  reduceUpdateState,
  updateIntent,
};
