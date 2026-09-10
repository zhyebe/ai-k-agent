const { contextBridge, ipcRenderer } = require("electron");

const apiBaseUrl = String(ipcRenderer.sendSync("api:get-base-url") || "http://127.0.0.1:8787");

contextBridge.exposeInMainWorld("axiomDesktop", {
  platform: process.platform,
  isDesktop: true,
  apiBaseUrl,
  api: {
    getBaseUrl: () => ipcRenderer.invoke("api:get-base-url"),
    setBaseUrl: (value) => ipcRenderer.invoke("api:set-base-url", value),
  },
  ai: {
    connect: (session) => ipcRenderer.invoke("ai:connect", session),
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
