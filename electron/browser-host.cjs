const { app, BrowserWindow } = require("electron");

if (process.env.AXIOM_BROWSER_SMOKE === "1") globalThis.axiomBrowserSmoke = require("./browser-smoke.cjs");
app.setPath("userData", process.env.AXIOM_BROWSER_PROFILE);
app.name = "Axiom Browser";
app.whenReady().then(() => {
  const window = new BrowserWindow({
    title: "Axiom - 交易浏览器",
    width: 1440,
    height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
const parentPid = Number(process.env.AXIOM_BROWSER_PARENT_PID);
if (parentPid > 0) {
  const timer = setInterval(() => {
    try { process.kill(parentPid, 0); } catch { app.quit(); }
  }, 5000);
  timer.unref();
}
