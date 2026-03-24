const { app, BrowserWindow, ipcMain, Notification, dialog } = require('electron');
const path    = require('path');
const { spawn } = require('child_process');
const os      = require('os');
const http    = require('http');

// ── Auto-updater (only active in packaged builds) ─────────────────
let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload     = false;  // ask user first
    autoUpdater.autoInstallOnAppQuit = true;
  } catch (e) {
    console.warn('[updater] electron-updater not available:', e.message);
  }
}

let mainWindow;
let serverProcess = null;
let ngrokProcess  = null;
let ngrokUrl      = null;

// ── Helpers ───────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Resolve the server script path ───────────────────────────────
// In dev:       <repo>/server/index.js
// In packaged:  resources/server/index.js  (via extraResources)
function getServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'index.js');
  }
  return path.join(__dirname, '..', 'server', 'index.js');
}

// ── Window ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 780,
    minHeight: 540,
    frame: false,
    transparent: false,
    backgroundColor: '#0a2a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // FIX: use .ico on Windows so the taskbar & Start Menu show the icon correctly
    icon: process.platform === 'win32'
      ? path.join(__dirname, 'icon.ico')
      : path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Check for updates after window loads (packaged only)
  if (autoUpdater) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => checkForUpdates(), 3000);
    });
  }
}

// ── Auto-updater logic ────────────────────────────────────────────

function checkForUpdates() {
  if (!autoUpdater) return;

  autoUpdater.checkForUpdates().catch(err => {
    console.warn('[updater] check failed:', err.message);
  });

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update:available', { version: info.version });

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Talkity ${info.version} is available!`,
      detail: 'Would you like to download and install it now?',
      buttons: ['Download Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        sendToRenderer('update:downloading', {});
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] Up to date.');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update:progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
    // Show in taskbar on Windows
    if (mainWindow && process.platform === 'win32') {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && process.platform === 'win32') {
      mainWindow.setProgressBar(-1);
    }
    sendToRenderer('update:downloaded', { version: info.version });

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Talkity ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update, or it will install automatically when you next close the app.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
    sendToRenderer('update:error', { message: err.message });
  });
}

// Expose manual update check to renderer
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { available: false, reason: 'dev-mode' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: !!result?.updateInfo };
  } catch (e) {
    return { available: false, error: e.message };
  }
});

// ── Window controls ───────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ── Icon state ────────────────────────────────────────────────────

// FIX: use .ico on Windows for taskbar overlay icons
const ICON_NORMAL = process.platform === 'win32'
  ? path.join(__dirname, 'icon.ico')
  : path.join(__dirname, 'icon.png');

const ICON_UNREAD = process.platform === 'win32'
  ? path.join(__dirname, 'icon_unread.ico')
  : path.join(__dirname, 'icon_unread.png');

ipcMain.on('icon:set', (_, state) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const iconPath = state === 'unread' ? ICON_UNREAD : ICON_NORMAL;
  mainWindow.setIcon(iconPath);
  if (process.platform === 'win32') {
    if (state === 'unread') {
      mainWindow.setOverlayIcon(iconPath, 'Unread messages');
      mainWindow.flashFrame(true);
    } else {
      mainWindow.setOverlayIcon(null, '');
      mainWindow.flashFrame(false);
    }
  }
});

// ── Notifications ─────────────────────────────────────────────────

ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

// ── Server management ─────────────────────────────────────────────

ipcMain.handle('server:start', async (_, { useNgrok }) => {
  if (serverProcess) return { ok: false, error: 'Server already running' };

  const serverPath = getServerScriptPath();

  // In packaged builds, node_modules live next to server/index.js
  const serverEnv = {
    ...process.env,
    PORT: '3747',
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave exactly like
    // plain `node`, so we can reuse process.execPath in both dev and packaged
    // builds without ever accidentally spawning a second Electron window.
    ELECTRON_RUN_AS_NODE: '1',
    // Ensure require() can find node_modules when running as extraResource
    NODE_PATH: path.join(path.dirname(serverPath), 'node_modules'),
  };

  return new Promise((resolve) => {
    serverProcess = spawn(process.execPath, [serverPath], {
      env: serverEnv,
      cwd: path.dirname(serverPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;

    serverProcess.stdout.on('data', (data) => {
      const line = data.toString();
      console.log('[server]', line.trim());
      sendToRenderer('server:log', line.trim());

      if (!started && line.includes('running on port')) {
        started = true;
        const localIP = getLocalIP();
        const lanAddr = `${localIP}:3747`;

        if (!useNgrok) {
          resolve({ ok: true, lan: lanAddr, ngrok: null });
          sendToRenderer('server:status', { running: true, lan: lanAddr, ngrok: null });
        } else {
          startNgrok(lanAddr).then(({ url, error }) => {
            ngrokUrl = url;
            const result = { ok: true, lan: lanAddr, ngrok: url, ngrokError: error };
            resolve(result);
            sendToRenderer('server:status', { running: true, lan: lanAddr, ngrok: url, ngrokError: error });
          });
        }
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const line = data.toString();
      console.error('[server:err]', line.trim());
      sendToRenderer('server:log', '⚠ ' + line.trim());
    });

    serverProcess.on('exit', (code) => {
      console.log(`[server] exited with code ${code}`);
      serverProcess = null;
      sendToRenderer('server:status', { running: false, lan: null, ngrok: null });
      sendToRenderer('server:log', `Server stopped (exit ${code})`);
    });

    serverProcess.on('error', (err) => {
      console.error('[server] spawn error:', err);
      if (!started) resolve({ ok: false, error: err.message });
      sendToRenderer('server:log', '❌ ' + err.message);
    });

    setTimeout(() => {
      if (!started) resolve({ ok: false, error: 'Server took too long to start' });
    }, 10000);
  });
});

ipcMain.handle('server:stop', async () => {
  stopNgrok();
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  sendToRenderer('server:status', { running: false, lan: null, ngrok: null });
  return { ok: true };
});

ipcMain.handle('server:getStatus', async () => {
  const localIP = getLocalIP();
  return {
    running: !!serverProcess,
    lan:     serverProcess ? `${localIP}:3747` : null,
    ngrok:   ngrokUrl,
  };
});

// ── ngrok ─────────────────────────────────────────────────────────

function startNgrok(lanAddr) {
  return new Promise((resolve) => {
    const ngrokCmd = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';

    ngrokProcess = spawn(ngrokCmd, ['http', '3747'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ngrokProcess.on('error', () => {
      resolve({ url: null, error: 'ngrok not found — install it from ngrok.com' });
    });

    ngrokProcess.on('exit', () => {
      ngrokUrl = null;
      sendToRenderer('server:status', {
        running: !!serverProcess,
        lan: lanAddr,
        ngrok: null,
      });
    });

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        clearInterval(poll);
        resolve({ url: null, error: 'ngrok tunnel timed out' });
        return;
      }

      http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const tunnel = data.tunnels?.find(t => t.proto === 'https');
            if (tunnel) {
              clearInterval(poll);
              const url = tunnel.public_url.replace('https://', '');
              resolve({ url, error: null });
            }
          } catch (_) {}
        });
      }).on('error', () => {});
    }, 1000);
  });
}

function stopNgrok() {
  if (ngrokProcess) {
    ngrokProcess.kill();
    ngrokProcess = null;
  }
  ngrokUrl = null;
}

// ── Lifecycle ─────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopNgrok();
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});