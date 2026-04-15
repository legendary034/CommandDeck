'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, screen } = require('electron');
const path    = require('path');
const fs      = require('fs');
const { exec, spawn } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────────
// CONFIG_PATH: bundled tiles config (read from resources; copied to userData on first run)
const CONFIG_PATH_BUNDLED = path.join(__dirname, 'config', 'tiles.json');

// SETTINGS_PATH: always lives in writable userData directory
// (e.g. %APPDATA%\CommandDeck\settings.json) so it works in both dev and prod.
function getSettingsPath() {
  const userData = app.getPath('userData');
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
  return path.join(userData, 'settings.json');
}

function getConfigPath() {
  // Allow tiles.json in userData to override the bundled one
  const userCfg = path.join(app.getPath('userData'), 'tiles.json');
  if (fs.existsSync(userCfg)) return userCfg;
  return CONFIG_PATH_BUNDLED;
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettingsSync(data) {
  try {
    const settingsPath = getSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const current = readSettings();
    fs.writeFileSync(settingsPath, JSON.stringify({ ...current, ...data }, null, 2), 'utf8');
  } catch (err) {
    console.error('[CommandDeck] Failed to write settings:', err.message);
  }
}

// ── Window ───────────────────────────────────────────────────────────────────
let mainWindow;
let statsTimer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1200,
    height:          720,
    minWidth:        500,
    minHeight:       400,
    frame:           false,
    transparent:     false,
    backgroundColor: '#08081a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Move to saved display before showing
    const settings = readSettings();
    const displays = screen.getAllDisplays();
    const idx      = typeof settings.preferredDisplay === 'number' ? settings.preferredDisplay : 0;
    const target   = displays[idx] || displays[0];

    if (target) {
      const { x, y, width, height } = target.bounds;
      mainWindow.setBounds({ x, y, width, height });
    }

    // Apply always-on-top BEFORE showing.
    // 'screen-saver' is the highest window level on Windows — it stays above
    // browsers, taskbar, and system notifications, effectively reserving the
    // monitor exclusively for CommandDeck when enabled.
    if (settings.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }

    mainWindow.show();
    mainWindow.setFullScreen(true);

    // Push window behavior flags to renderer so it can apply CSS immediately
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('apply-window-behavior', {
        hideHeader:  !!settings.hideHeader,
        alwaysOnTop: !!settings.alwaysOnTop,
      });
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Stats ─────────────────────────────────────────────────────────────
// Use systeminformation lazily to avoid crashing if native modules aren't built
let si;
try { si = require('systeminformation'); } catch { si = null; }

async function collectStats() {
  if (!si) return fallbackStats();
  try {
    const [load, temp, speed, mem, gfx] = await Promise.all([
      si.currentLoad().catch(() => ({ currentLoad: 0 })),
      si.cpuTemperature().catch(() => ({ main: 0 })),
      si.cpuCurrentSpeed().catch(() => ({ avg: 0 })),
      si.mem().catch(() => ({ used: 0, total: 1 })),
      si.graphics().catch(() => ({ controllers: [] })),
    ]);

    return {
      cpuLoad:  Math.round(load.currentLoad || 0),
      cpuTemp:  Math.round(temp.main || 0),
      cpuSpeed: Math.round((speed.avg || 0) * 1000),   // GHz → MHz
      memUsed:  Math.round((mem.used / mem.total) * 100),
      memTotal: Math.round(mem.total / (1024 ** 3)),
      gpuTemp:  gfx.controllers?.[0]?.temperatureGpu ?? null,
      // cpuPower and memClock not universally available via si; use null
      cpuPower: null,
      memClock: null,
    };
  } catch {
    return fallbackStats();
  }
}

function fallbackStats() {
  return {
    cpuLoad: 0, cpuTemp: 0, cpuSpeed: 0,
    memUsed: 0, memTotal: 0,
    gpuTemp: null, cpuPower: null, memClock: null,
  };
}

function startStatsPolling() {
  const push = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const stats = await collectStats();
    mainWindow.webContents.send('stats-update', stats);
  };
  push();
  statsTimer = setInterval(push, 2000);
}

// ── Media Keys (via PowerShell + user32) ─────────────────────────────────────
const VK_CODES = {
  'play-pause': 179,   // VK_MEDIA_PLAY_PAUSE
  prev:         177,   // VK_MEDIA_PREV_TRACK
  next:         176,   // VK_MEDIA_NEXT_TRACK
  stop:         178,   // VK_MEDIA_STOP
  mute:         173,   // VK_VOLUME_MUTE
  'vol-up':     175,   // VK_VOLUME_UP
  'vol-down':   174,   // VK_VOLUME_DOWN
};

function sendMediaKey(action) {
  const vk = VK_CODES[action];
  if (!vk) return Promise.resolve({ success: false, error: 'Unknown key' });

  const psScript = [
    'Add-Type -TypeDefinition @\'',
    'using System.Runtime.InteropServices;',
    'public class VKey {',
    '    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);',
    '    public static void Press(byte vk) { keybd_event(vk, 0, 0, 0); System.Threading.Thread.Sleep(10); keybd_event(vk, 0, 2, 0); }',
    '}',
    '\'@',
    `[VKey]::Press(${vk})`,
  ].join('\n');

  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ], { stdio: 'pipe', windowsHide: true });
    proc.on('close', (code) => resolve({ success: code === 0 }));
    proc.on('error', (err) => resolve({ success: false, error: err.message }));
  });
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('read-config', () => {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('read-settings', () => readSettings());

ipcMain.handle('write-settings', (_e, data) => {
  try {
    writeSettingsSync(data);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-displays', () => {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    index:     i,
    id:        d.id,
    label:     d.label || `Display ${i + 1}`,
    width:     d.bounds.width,    // use bounds (physical px) not size (logical px)
    height:    d.bounds.height,
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === primary.id,
  }));
});

ipcMain.handle('set-display', (_e, idx) => {
  try {
    const displays = screen.getAllDisplays();
    const target   = displays[idx];
    if (!target || !mainWindow) return { success: false, error: 'Invalid display index' };

    // Exit fullscreen first so setBounds works correctly
    mainWindow.setFullScreen(false);
    const { x, y, width, height } = target.bounds;
    mainWindow.setBounds({ x, y, width, height });
    mainWindow.setFullScreen(true);
    writeSettingsSync({ preferredDisplay: idx });
    // Return target display dimensions so the renderer can adjust tile sizing
    return { success: true, width: target.bounds.width, height: target.bounds.height };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-config', (_e, config) => {
  try {
    // Write config to userData so it's writable in the installed app
    const userCfg = path.join(app.getPath('userData'), 'tiles.json');
    fs.writeFileSync(userCfg, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('launch-app', (_e, { path: appPath, args = [] }) => {
  try {
    if (!appPath) return { success: false, error: 'No path configured' };
    const proc = spawn(appPath, args, { detached: true, stdio: 'ignore', shell: true });
    proc.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-command', (_e, command) => {
  return new Promise((resolve) => {
    exec(command, { shell: 'powershell.exe', windowsHide: true }, (err, stdout) => {
      resolve({ success: !err, output: stdout, error: err?.message });
    });
  });
});

ipcMain.handle('send-media-key', (_e, action) => sendMediaKey(action));

// ── Window Behavior (always-on-top + hide header) ─────────────────────────────
ipcMain.handle('set-window-behavior', (_e, { alwaysOnTop, hideHeader }) => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };

    // Persist both settings atomically
    writeSettingsSync({ alwaysOnTop: !!alwaysOnTop, hideHeader: !!hideHeader });

    // Apply always-on-top at the highest level ('screen-saver') so CommandDeck
    // stays above every other application window on the monitor, effectively
    // preventing accidental use of that display by any other program.
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    } else {
      mainWindow.setAlwaysOnTop(false);
    }

    // Push the behavior flags to the renderer so it can toggle the CSS live
    mainWindow.webContents.send('apply-window-behavior', {
      hideHeader:  !!hideHeader,
      alwaysOnTop: !!alwaysOnTop,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Titlebar controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => app.quit());

// ── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  startStatsPolling();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (statsTimer) clearInterval(statsTimer);
});
