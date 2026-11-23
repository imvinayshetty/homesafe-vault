const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vaultDesktop', {
  isDesktop: true,
  getAccessKey: () => ipcRenderer.invoke('vault:get-access-key'),
  ensureRunning: () => ipcRenderer.invoke('vault:ensure-running'),
  status: () => ipcRenderer.invoke('vault:status'),
  getLocation: () => ipcRenderer.invoke('vault:get-location'),
  changeLocation: () => ipcRenderer.invoke('vault:change-location'),
});
