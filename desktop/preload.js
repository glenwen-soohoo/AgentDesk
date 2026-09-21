const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDeskDesktop", {
  isDesktop: true,
  loadOfficeData: () => ipcRenderer.invoke("office-data:read"),
  resizeToContent: (width, height) => ipcRenderer.send("window:resize-to-content", { width, height }),
  moveWindowBy: (deltaX, deltaY) => ipcRenderer.send("window:move-by", { deltaX, deltaY }),
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close")
});
