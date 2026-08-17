'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('claudeUsage', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  refresh: () => ipcRenderer.invoke('usage:refresh'),
  current: () => ipcRenderer.invoke('usage:current'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleaseNotes: () => ipcRenderer.send('update:release-notes'),

  onData: listen('usage:data'),
  onError: listen('usage:error'),
  onLoading: listen('usage:loading'),
  onSettings: listen('settings:changed'),
  onUpdate: listen('update:changed'),

  openSettings: () => ipcRenderer.send('window:open-settings'),
  closeSettings: () => ipcRenderer.send('window:close-settings'),
  hideBar: () => ipcRenderer.send('window:hide-bar'),
  contextMenu: () => ipcRenderer.send('window:context-menu'),
  reportPanelHeight: (height) => ipcRenderer.send('window:panel-height', height),
  openCredentialsFolder: () => ipcRenderer.send('shell:open-credentials-folder'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
});
