const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vaultDesktop', {
  isDesktop: true,
  getAccessKey: () => ipcRenderer.invoke('vault:get-access-key'),
  status: () => ipcRenderer.invoke('vault:status'),
});
