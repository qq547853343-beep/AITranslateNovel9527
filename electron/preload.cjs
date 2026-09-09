const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('launcher', Object.freeze({
  getSnapshot: () => invoke('launcher:get-snapshot'),
  startService: () => invoke('launcher:start'),
  stopService: () => invoke('launcher:stop'),
  restartService: () => invoke('launcher:restart'),
  setServicePort: (port) => invoke('launcher:set-service-port', { port }),
  updateSettings: (changes) => invoke('launcher:update-settings', changes),
  scanPorts: (start, end) => invoke('launcher:scan-ports', { start, end }),
  getLogs: (kind = 'all', lines = 200) => invoke('launcher:get-logs', { kind, lines }),
  openService: () => invoke('launcher:open-service'),
  checkForUpdates: () => invoke('launcher:check-update'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('launcher:status', listener);
    return () => ipcRenderer.removeListener('launcher:status', listener);
  }
}));
