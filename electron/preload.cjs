const { contextBridge, ipcRenderer } = require("electron");

const runtime = ipcRenderer.sendSync("api:get-runtime");

contextBridge.exposeInMainWorld("axiomDesktop", {
  platform: process.platform,
  isDesktop: true,
  standalone: true,
  version: runtime.version,
  apiBaseUrl: runtime.apiBaseUrl,
  localToken: runtime.localToken,
  ai: {
    connect: () => ipcRenderer.invoke("ai:connect", { apiBaseUrl: runtime.apiBaseUrl, userToken: runtime.localToken }),
    disconnect: () => ipcRenderer.invoke("ai:disconnect"),
  },
  updates: {
    getState: () => ipcRenderer.invoke("update:get-state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    startResize: (edge) => ipcRenderer.send("window:resize-start", edge),
    resizeMove: () => ipcRenderer.send("window:resize-move"),
    endResize: () => ipcRenderer.send("window:resize-end"),
  },
});
