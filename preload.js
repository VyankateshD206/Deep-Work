const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chromeTabs', {
  fetch: () => ipcRenderer.invoke('chrome-tabs:fetch'),
  status: () => ipcRenderer.invoke('chrome-tabs:status'),
  getProfiles: () => ipcRenderer.invoke('chrome-tabs:profiles'),
  getCurrentProfile: () => ipcRenderer.invoke('chrome-tabs:current-profile'),
  switchProfile: (profileId) => ipcRenderer.invoke('chrome-tabs:switch-profile', profileId),
  onUpdate: (handler) => {
    const listener = (_event, tabs) => handler(tabs);
    ipcRenderer.on('chrome-tabs', listener);
    return () => ipcRenderer.removeListener('chrome-tabs', listener);
  },
  onStatus: (handler) => {
    const listener = (_event, msg) => handler(msg);
    ipcRenderer.on('chrome-status', listener);
    return () => ipcRenderer.removeListener('chrome-status', listener);
  },
  devtoolsPort: () => ipcRenderer.invoke('chrome-tabs:port'),
});
