const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talkity', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // Native notifications
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  // Server management
  serverStart:     (opts) => ipcRenderer.invoke('server:start', opts),
  serverStop:      ()     => ipcRenderer.invoke('server:stop'),
  serverGetStatus: ()     => ipcRenderer.invoke('server:getStatus'),

  // Server push events (renderer registers callbacks)
  onServerStatus: (cb) => ipcRenderer.on('server:status', (_, data) => cb(data)),
  onServerLog:    (cb) => ipcRenderer.on('server:log',    (_, line) => cb(line)),

  // Taskbar icon state: 'normal' | 'unread'
  setIcon: (state) => ipcRenderer.send('icon:set', state),

  // Auto-updater
  checkForUpdate:      ()   => ipcRenderer.invoke('update:check'),
  onUpdateAvailable:   (cb) => ipcRenderer.on('update:available',   (_, d) => cb(d)),
  onUpdateDownloading: (cb) => ipcRenderer.on('update:downloading',  (_, d) => cb(d)),
  onUpdateProgress:    (cb) => ipcRenderer.on('update:progress',    (_, d) => cb(d)),
  onUpdateDownloaded:  (cb) => ipcRenderer.on('update:downloaded',  (_, d) => cb(d)),
  onUpdateError:       (cb) => ipcRenderer.on('update:error',       (_, d) => cb(d)),
});
