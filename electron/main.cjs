if (process.env.AXIOM_BROWSER_HOST === "1") {
  require("./browser-host.cjs");
} else {
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
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
process.env.AXIOM_STANDALONE = "1";
if (process.env.AXIOM_USER_DATA_DIR) app.setPath("userData", path.resolve(process.env.AXIOM_USER_DATA_DIR));

let apiProcess;
let mainWindow;
let updateCheckTimer;
let updateCheckPromise;
let installTimer;
let quittingForUpdate = false;
let latestUpdateAsset = null;
let downloadedInstallerPath = "";
let downloadAbort = null;
let apiBaseUrl = "";
const localToken = crypto.randomBytes(32).toString("base64url");
let runtimeReady = false;
let stoppingApi = false;
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

async function prepareAppForUpdateQuit() {
  quittingForUpdate = true;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  await disconnectAiRuntime();
  await stopApi();
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
    await prepareAppForUpdateQuit();
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

ipcMain.on("api:get-runtime", (event) => {
  event.returnValue = { apiBaseUrl, localToken, standalone: true, version: app.getVersion() };
});
bindAiRuntime(ipcMain, app);

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
  const directory = path.join(app.getPath("userData"), "standalone");
  process.env.AXIOM_DATA_DIR = directory;
  process.env.AXIOM_SECRET_FILE = path.join(directory, ".axiom-secret");
  process.env.AXIOM_VAULT_FILE = path.join(directory, "credentials.vault.json");
  process.env.APP_SECRET = "";
  return new Promise((resolve, reject) => {
    apiProcess = spawn(process.execPath, [serverEntryPath()], {
      env: {
        ...process.env,
        AXIOM_STANDALONE: "1",
        AXIOM_DESKTOP: "1",
        AXIOM_LOCAL_TOKEN: localToken,
        AXIOM_DATA_DIR: directory,
        PORT: "0",
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let diagnostics = "";
    apiProcess.stdout.on("data", data => process.stdout.write(data));
    apiProcess.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-3000); process.stderr.write(data); });
    const timer = setTimeout(() => reject(new Error(`本机运行引擎启动超时。${diagnostics}`)), 15000);
    apiProcess.once("error", error => { clearTimeout(timer); reject(error); });
    apiProcess.on("message", message => {
      if (message?.type !== "ready" || !Number.isInteger(message.port)) return;
      clearTimeout(timer);
      apiBaseUrl = `http://127.0.0.1:${message.port}`;
      runtimeReady = true;
      resolve();
    });
    apiProcess.once("exit", code => {
      clearTimeout(timer);
      if (!runtimeReady) { reject(new Error(`本机运行引擎启动失败（${code}）。${diagnostics}`)); return; }
      runtimeReady = false;
      if (!stoppingApi) {
        dialog.showErrorBox("本机运行引擎已停止", `请重新启动应用。${diagnostics}`);
        app.quit();
      }
    });
  });
}

async function stopApi() {
  stoppingApi = true;
  const child = apiProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: "shutdown" });
    else child.kill();
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

  if (!app.isPackaged && process.argv.includes("--dev")) mainWindow.loadURL("http://127.0.0.1:5173");
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
    if (runtimeReady) showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;
  try {
    await startApi();
  } catch (error) {
    dialog.showErrorBox("Axiom 启动失败", String(error.message || error));
    app.quit();
    return;
  }
  showMainWindow();
  try {
    configureUpdates();
  } catch (error) {
    console.error("auto-update setup failed", error);
  }
});

app.on("activate", () => {
  if (!gotTheLock || !app.isReady() || !runtimeReady || quittingForUpdate) return;
  showMainWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

let browserCleanupDone = false;
app.on("before-quit", (event) => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (installTimer) clearTimeout(installTimer);
  if (!browserCleanupDone) {
    event.preventDefault();
    disconnectAiRuntime().finally(() => stopApi()).finally(() => { browserCleanupDone = true; app.quit(); });
  }
});
}
