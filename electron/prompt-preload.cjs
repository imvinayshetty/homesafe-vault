const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('prompt', { submit: v => ipcRenderer.send('prompt:submit', v), cancel: () => ipcRenderer.send('prompt:cancel') });
