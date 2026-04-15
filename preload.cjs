const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commandDeck', {
  // Config I/O
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),

  // OS operations
  launchApp: (path, args) => ipcRenderer.invoke('launch-app', { path, args }),
  runCommand: (command) => ipcRenderer.invoke('run-command', command),
  sendMediaKey: (key) => ipcRenderer.invoke('send-media-key', key),

  // Titlebar controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Stats streaming (renderer subscribes via push)
  onStats: (callback) => {
    ipcRenderer.on('stats-update', (_event, data) => callback(data));
  },
  removeStatsListener: () => {
    ipcRenderer.removeAllListeners('stats-update');
  },
});
