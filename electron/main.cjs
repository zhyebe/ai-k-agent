const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { bindIpc: bindAiRuntime, disconnect: disconnectAiRuntime } = require("./ai-runtime.cjs");
const {
  emptyUpdateState,
  hasDownloadedPackage,
  shouldSkipUpdateCheck,
  supportsDesktopAutoUpdate,
  reduceUpdateState,
} = require("./update-state.cjs");
const { checkForUpdates: checkGithubUpdates, downloadInstaller, openInstaller } = require("./update-service.cjs");
const { DEFAULT_PACKAGED_API_URL, isLoopbackApiUrl } = require("./default-api.cjs");

let apiProcess;
let mainWindow;
let updateCheckTimer;
let updateCheckPromise;
let installTimer;
let quittingForUpdate = false;
let latestUpdateAsset = null;
let downloadedInstallerPath = "";
let downloadAbort = null;
let apiPort = Number(process.env.AXIOM_API_PORT || 8787);
if (!Number.isInteger(apiPort) || apiPort < 0 || apiPort > 65535) apiPort = 8787;
let apiBaseUrl = "";
const embeddedApiEnabled = process.env.AXIOM_EMBEDDED_API === "1";
let resizeSession;
const updateState = emptyUpdateState();

function supportsAutoUpdate() {
  return supportsDesktopAutoUpdate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
  });
}

function publishUpdateState(next) {
  Object.assign(updateState, reduceUpdateState(updateState, next || {}));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:state", { ...updateState });
  }
}

function currentUpdateState() {
  return { ...updateState };
}

function checkForUpdates() {
  if (!supportsAutoUpdate()) {
    publishUpdateState({ status: app.isPackaged ? "unsupported" : "disabled", currentVersion: app.getVersion() });
    return Promise.resolve(currentUpdateState());
  }
  if (shouldSkipUpdateCheck(updateState)) {
    return Promise.resolve(currentUpdateState());
  }
  if (updateCheckPromise) return updateCheckPromise;

  publishUpdateState({ status: "checking", currentVersion: app.getVersion(), error: null });
  updateCheckPromise = checkGithubUpdates(apiBaseUrl)
    .then((result) => {
      latestUpdateAsset = result.asset || null;
      if (result.available && result.asset) {
        publishUpdateState({ status: "available", availableVersion: result.latestVersion, progress: 0, error: null });
        downloadUpdatePackage().catch((error) => {
          publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        });
      } else if (result.available) {
        publishUpdateState({ status: "error", error: result.message });
      } else if (result.message && result.message.startsWith("检查更新失败")) {
        publishUpdateState({ status: "error", error: result.message });
      } else {
        publishUpdateState({ status: "not-available", availableVersion: null, progress: 0, error: null });
      }
      return currentUpdateState();
    })
    .catch((error) => {
      publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return currentUpdateState();
    })
    .finally(() => { updateCheckPromise = undefined; });
  return updateCheckPromise;
}

async function downloadUpdatePackage() {
  if (!supportsAutoUpdate()) return currentUpdateState();
  if (!latestUpdateAsset) {
    const checked = await checkGithubUpdates(apiBaseUrl);
    latestUpdateAsset = checked.asset || null;
    if (checked.available && checked.latestVersion) {
      publishUpdateState({ status: "available", availableVersion: checked.latestVersion, error: null });
    }
  }
  if (!latestUpdateAsset) {
    publishUpdateState({ status: "error", error: "没有匹配当前系统的安装包" });
    return currentUpdateState();
  }
  if (downloadedInstallerPath && fs.existsSync(downloadedInstallerPath) && updateState.downloadedVersion === updateState.availableVersion) {
    publishUpdateState({ status: "downloaded", downloadedVersion: updateState.availableVersion, progress: 100, error: null });
    return currentUpdateState();
  }
  if (downloadAbort) downloadAbort.abort();
  downloadAbort = new AbortController();
  const thisDownload = downloadAbort;
  try {
    publishUpdateState({ status: "downloading", progress: 0, error: null });
    downloadedInstallerPath = await downloadInstaller(latestUpdateAsset, {
      apiBaseUrl,
      signal: thisDownload.signal,
      onProgress: (progress) => {
        if (downloadAbort !== thisDownload) return;
        publishUpdateState({ status: "downloading", progress, error: null });
      },
    });
    publishUpdateState({
      status: "downloaded",
      downloadedVersion: updateState.availableVersion || latestUpdateAsset.name,
      progress: 100,
      error: null,
    });
  } catch (error) {
    if (downloadAbort === thisDownload) {
      publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (downloadAbort === thisDownload) downloadAbort = null;
  }
  return currentUpdateState();
}

function configureUpdates() {
  if (!supportsAutoUpdate()) {
    publishUpdateState({ status: app.isPackaged ? "unsupported" : "disabled", currentVersion: app.getVersion() });
    return;
  }

  publishUpdateState({ status: "idle", currentVersion: app.getVersion(), error: null });
  setTimeout(() => { checkForUpdates(); }, 5000);
  updateCheckTimer = setInterval(() => { checkForUpdates(); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle("update:get-state", () => currentUpdateState());
ipcMain.handle("update:check", () => checkForUpdates());
ipcMain.handle("update:download", () => downloadUpdatePackage());

function prepareAppForUpdateQuit() {
  quittingForUpdate = true;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  disconnectAiRuntime();
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
}

async function installDownloadedUpdate() {
  if (!supportsAutoUpdate()) return currentUpdateState();
  if (!hasDownloadedPackage(updateState) && !latestUpdateAsset) return currentUpdateState();
  publishUpdateState({ status: "installing", error: null });
  try {
    if (!downloadedInstallerPath || !fs.existsSync(downloadedInstallerPath)) {
      await downloadUpdatePackage();
    }
    if (!downloadedInstallerPath || !fs.existsSync(downloadedInstallerPath)) {
      throw new Error("安装包不存在");
    }
    prepareAppForUpdateQuit();
    await openInstaller(downloadedInstallerPath);
    if (installTimer) clearTimeout(installTimer);
    installTimer = setTimeout(() => {
      app.exit(0);
    }, 400);
  } catch (error) {
    quittingForUpdate = false;
    publishUpdateState({ status: "downloaded", error: error instanceof Error ? error.message : String(error) });
  }
  return currentUpdateState();
}

ipcMain.handle("update:install", () => installDownloadedUpdate());

ipcMain.handle("window:minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.handle("window:maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle("window:close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle("window:is-maximized", () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));

function normalizeApiBaseUrl(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("API_URL_REQUIRED");
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error("API_URL_INVALID"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("API_URL_INVALID");
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function connectionConfigPath() {
  return path.join(app.getPath("userData"), "connection.json");
}

function readSavedApiBaseUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(connectionConfigPath(), "utf8"));
    return normalizeApiBaseUrl(config.apiBaseUrl);
  } catch {
    return "";
  }
}

function initialApiBaseUrl() {
  const saved = readSavedApiBaseUrl();
  const useCloudDefault = app.isPackaged && !embeddedApiEnabled;
  const fallback = useCloudDefault ? DEFAULT_PACKAGED_API_URL : `http://127.0.0.1:${apiPort}`;
  const usableSaved = saved && !(useCloudDefault && isLoopbackApiUrl(saved)) ? saved : "";
  const configured = usableSaved || process.env.AXIOM_API_URL || fallback;
  return normalizeApiBaseUrl(configured);
}

function saveApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value);
  const target = connectionConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ apiBaseUrl: normalized }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  apiBaseUrl = normalized;
  return apiBaseUrl;
}

ipcMain.on("api:get-base-url", (event) => { event.returnValue = apiBaseUrl || initialApiBaseUrl(); });
ipcMain.handle("api:get-base-url", () => apiBaseUrl || initialApiBaseUrl());
ipcMain.handle("api:set-base-url", (_event, value) => saveApiBaseUrl(value));
bindAiRuntime(ipcMain, app);

function probePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen({ host: "127.0.0.1", port }, () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(selected));
    });
  });
}

async function chooseApiPort() {
  if (apiPort === 0) return probePort(0);
  for (let offset = 0; offset < 32; offset += 1) {
    const selected = await probePort(apiPort + offset);
    if (selected) return selected;
  }
  return probePort(0);
}

function resizeWindowFromCursor() {
  if (!mainWindow || mainWindow.isDestroyed() || !resizeSession || mainWindow.isMaximized()) return;
  const cursor = screen.getCursorScreenPoint();
  const deltaX = cursor.x - resizeSession.startCursor.x;
  const deltaY = cursor.y - resizeSession.startCursor.y;
  const { bounds, edge } = resizeSession;
  let width = bounds.width;
  let height = bounds.height;
  let x = bounds.x;
  let y = bounds.y;
  if (edge.includes("e")) width = Math.max(1024, bounds.width + deltaX);
  if (edge.includes("s")) height = Math.max(700, bounds.height + deltaY);
  if (edge.includes("w")) {
    width = Math.max(1024, bounds.width - deltaX);
    x = bounds.x + bounds.width - width;
  }
  if (edge.includes("n")) {
    height = Math.max(700, bounds.height - deltaY);
    y = bounds.y + bounds.height - height;
  }
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, false);
}

ipcMain.on("window:resize-start", (_event, edge) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || !/^(n|s|e|w|ne|nw|se|sw)$/.test(String(edge || ""))) return;
  resizeSession = { edge: String(edge), bounds: mainWindow.getBounds(), startCursor: screen.getCursorScreenPoint() };
});
ipcMain.on("window:resize-move", () => resizeWindowFromCursor());
ipcMain.on("window:resize-end", () => { resizeSession = undefined; });

function serverEntryPath() {
  const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "server", "index.mjs");
  if (app.isPackaged && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "server", "index.mjs");
}

function startApi() {
  const userData = app.getPath("userData");
  const serverEntry = serverEntryPath();
  apiProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      AXIOM_DESKTOP: "1",
      AXIOM_API_PORT: String(apiPort),
      AXIOM_DATA_DIR: userData,
      AXIOM_SECRET_FILE: path.join(userData, ".axiom-secret"),
      AXIOM_VAULT_FILE: path.join(userData, "credentials.vault.json"),
      PORT: String(apiPort),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  apiProcess.on("error", (error) => console.error("Axiom API process error", error));
}

function waitForApi(timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${apiPort}/api/health`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.on("error", retry);
      request.setTimeout(1200, () => { request.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("API_START_TIMEOUT"));
      setTimeout(check, 250);
    };
    check();
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0d10",
    icon: path.join(__dirname, "icon.png"),
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged || process.env.AXIOM_DEV_URL) mainWindow.loadURL(process.env.AXIOM_DEV_URL || "http://127.0.0.1:5173");
  else mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  mainWindow.webContents.once("did-finish-load", () => publishUpdateState({}));
  mainWindow.on("closed", () => { mainWindow = undefined; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  return mainWindow;
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  return createWindow();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  apiBaseUrl = initialApiBaseUrl();
  if (embeddedApiEnabled) {
    apiPort = await chooseApiPort();
    if (!apiPort) throw new Error("API_PORT_UNAVAILABLE");
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    startApi();
    try { await waitForApi(); } catch (error) { console.error(error); }
  }
  showMainWindow();
  try {
    configureUpdates();
  } catch (error) {
    console.error("auto-update setup failed", error);
  }
});

app.on("activate", () => {
  if (!gotTheLock || !app.isReady() || quittingForUpdate) return;
  showMainWindow();
});

app.on("window-all-closed", () => {
  if (quittingForUpdate || process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (installTimer) clearTimeout(installTimer);
  disconnectAiRuntime();
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
});
