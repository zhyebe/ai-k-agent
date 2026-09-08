const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

let apiProcess;
let mainWindow;
let updateCheckTimer;
let updateCheckPromise;
const apiPort = Number(process.env.AXIOM_API_PORT || 8787);
const updateState = {
  status: "disabled",
  currentVersion: "dev",
  availableVersion: null,
  downloadedVersion: null,
  progress: 0,
  error: null,
};

function supportsAutoUpdate() {
  return app.isPackaged && ["darwin", "win32"].includes(process.platform);
}

function publishUpdateState(next) {
  Object.assign(updateState, next);
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
  if (updateState.status === "downloading" || updateState.status === "downloaded") return Promise.resolve(currentUpdateState());
  if (updateCheckPromise) return updateCheckPromise;

  publishUpdateState({ status: "checking", currentVersion: app.getVersion(), error: null });
  updateCheckPromise = autoUpdater.checkForUpdates()
    .then(() => currentUpdateState())
    .catch((error) => {
      publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return currentUpdateState();
    })
    .finally(() => { updateCheckPromise = undefined; });
  return updateCheckPromise;
}

function configureAutoUpdater() {
  if (!supportsAutoUpdate()) {
    publishUpdateState({ status: app.isPackaged ? "unsupported" : "disabled", currentVersion: app.getVersion() });
    return;
  }

  publishUpdateState({ status: "idle", currentVersion: app.getVersion(), error: null });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => publishUpdateState({ status: "available", availableVersion: info.version, progress: 0, error: null }));
  autoUpdater.on("update-not-available", () => publishUpdateState({ status: "not-available", availableVersion: null, progress: 0, error: null }));
  autoUpdater.on("download-progress", (progress) => publishUpdateState({ status: "downloading", progress: Math.round(progress.percent), error: null }));
  autoUpdater.on("update-downloaded", (info) => publishUpdateState({ status: "downloaded", downloadedVersion: info.version, progress: 100, error: null }));
  autoUpdater.on("error", (error) => publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) }));

  setTimeout(() => { checkForUpdates(); }, 5000);
  updateCheckTimer = setInterval(() => { checkForUpdates(); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle("update:get-state", () => currentUpdateState());
ipcMain.handle("update:check", () => checkForUpdates());
ipcMain.handle("update:download", async () => {
  if (!supportsAutoUpdate() || updateState.status !== "available") return currentUpdateState();
  try {
    publishUpdateState({ status: "downloading", progress: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
  return currentUpdateState();
});
ipcMain.handle("update:install", () => {
  if (supportsAutoUpdate() && updateState.status === "downloaded") {
    publishUpdateState({ status: "installing" });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }
  return currentUpdateState();
});

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
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0d10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
}

app.whenReady().then(async () => {
  startApi();
  try { await waitForApi(); } catch (error) { console.error(error); }
  createWindow();
  configureAutoUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
});
