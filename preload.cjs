const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('commandDeck', {
  // Config I/O
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),

  // Settings I/O
  readSettings: () => ipcRenderer.invoke('read-settings'),
  writeSettings: (data) => ipcRenderer.invoke('write-settings', data),

  // Display management
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setDisplay: (idx) => ipcRenderer.invoke('set-display', idx),

  // Window behavior (always-on-top + hide header)
  setWindowBehavior: (opts) => ipcRenderer.invoke('set-window-behavior', opts),

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

  // Window behavior push from main (apply on startup + live changes)
  onApplyWindowBehavior: (callback) => {
    ipcRenderer.on('apply-window-behavior', (_event, data) => callback(data));
  },
});
