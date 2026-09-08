const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("axiomDesktop", {
  platform: process.platform,
  isDesktop: true,
  apiBaseUrl: `http://127.0.0.1:${process.env.AXIOM_API_PORT || 8787}`,
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
});
