const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskly", {
  getStartRole: () => ipcRenderer.invoke("deskly:role"),
  showWindow: () => ipcRenderer.invoke("deskly:show-window"),
  setBackground: (enabled) => ipcRenderer.invoke("deskly:set-background", enabled),
  inject: (event, options) => ipcRenderer.invoke("deskly:inject", event, options),
  cursor: () => ipcRenderer.invoke("deskly:cursor"),
  followCursor: (x, y) => ipcRenderer.invoke("deskly:follow-cursor", x, y),
  followHostCursor: (clientX, clientY) => ipcRenderer.invoke("deskly:follow-host-cursor", clientX, clientY),
  setCursorScreenPos: (x, y) => ipcRenderer.invoke("deskly:set-cursor-screen-pos", x, y),
  getWindowBounds: () => ipcRenderer.invoke("deskly:get-window-bounds"),
  startCursorLoop: () => ipcRenderer.invoke("deskly:start-cursor-loop"),
  stopCursorLoop: () => ipcRenderer.invoke("deskly:stop-cursor-loop"),
  accessList: () => ipcRenderer.invoke("deskly:access-list"),
  saveAccess: (entry) => ipcRenderer.invoke("deskly:save-access", entry),
  removeAccess: (publicId) => ipcRenderer.invoke("deskly:remove-access", publicId),
  onHotkey: (fn) => {
    ipcRenderer.on("deskly:hotkey", (_e, name) => fn(name));
  },
  onLocalCursor: (fn) => {
    ipcRenderer.on("deskly:local-cursor", (_e, pos) => fn(pos));
  },
  log: (level, category, message, data) => ipcRenderer.invoke("deskly:log", level, category, message, data),
  getLogs: () => ipcRenderer.invoke("deskly:get-logs"),
  openLogFile: () => ipcRenderer.invoke("deskly:open-log-file"),
  clearLogs: () => ipcRenderer.invoke("deskly:clear-logs"),
});
