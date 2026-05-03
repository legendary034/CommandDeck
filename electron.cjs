'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, screen } = require('electron');
app.setName('CommandDeck');
app.setAppUserModelId('com.commanddeck.app');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const net     = require('net');
const { exec, spawn } = require('child_process');

// ── Logging ──────────────────────────────────────────────────────────────────
const LOG_FILE = path.join(app.getPath('userData'), 'app.log');

function logToFile(msg, level = 'INFO') {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${msg}\n`;
    
    // Rotate log if too big (> 500KB)
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 500 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    // Fallback if logging fails
  }
}

// Redirect console to file
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  logToFile(args.join(' '), 'INFO');
  originalLog(...args);
};
console.error = (...args) => {
  logToFile(args.join(' '), 'ERROR');
  originalError(...args);
};

logToFile('--- CommandDeck Startup ---', 'BOOT');

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
    // 'floating' keeps CommandDeck above all normal app windows (maps to
    // HWND_TOPMOST on Windows) while still allowing system-level overlays
    // like the screen saver to render on top of it.
    if (settings.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
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

// ── Camera Streaming (RTSP → MJPEG over HTTP) ────────────────────────────────
// Each camera tile gets its own HTTP server + ffmpeg child process.
// Frames are extracted by JPEG SOI/EOI markers and broadcast to all HTTP clients.
const activeStreams = new Map(); // tileId → { server, ffmpeg, clients, port }
const pendingStreams = new Map(); // tileId → streamId

function findFreePort(start = 19200) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(start, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', () => findFreePort(start + 1).then(resolve).catch(reject));
  });
}

function extractJpegFrames(buf) {
  const frames = [];
  let start = -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8) { start = i; }
    else if (buf[i] === 0xFF && buf[i + 1] === 0xD9 && start !== -1) {
      frames.push(buf.slice(start, i + 2));
      start = -1;
    }
  }
  return { frames, remainder: start !== -1 ? buf.slice(start) : Buffer.alloc(0) };
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /F /T /PID ${proc.pid}`, { windowsHide: true }, () => {});
    } else {
      proc.kill('SIGKILL');
    }
  } catch (_) {}
}

function stopCameraStream(tileId) {
  pendingStreams.delete(tileId); // Cancel any async start in progress
  const s = activeStreams.get(tileId);
  if (!s) return;
  killProcessTree(s.ffmpeg);
  if (s.clients) s.clients.forEach(res => { try { res.end(); } catch (_) {} });
  if (s.server) try { s.server.close(); } catch (_) {}
  activeStreams.delete(tileId);
  logToFile(`[Camera] Stream stopped: ${tileId}`, 'INFO');
}

async function startCameraStream(tileId, rtspUrl) {
  stopCameraStream(tileId); // clean up any prior instance

  const streamId = Math.random().toString(36);
  pendingStreams.set(tileId, streamId);

  const port    = await findFreePort();

  // Abort if another start/stop was called while finding port
  if (pendingStreams.get(tileId) !== streamId) {
    return { success: false, error: 'Aborted' };
  }

  const clients = new Set();
  let   buf     = Buffer.alloc(0);

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'quiet',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-vf', 'scale=1280:-1',
    '-f', 'mjpeg',
    '-q:v', '4',
    '-r', '15',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  // Store immediately so stopCameraStream can kill it if needed
  activeStreams.set(tileId, { server: null, ffmpeg, clients, port });

  ffmpeg.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, remainder } = extractJpegFrames(buf);
    buf = remainder;
    if (!frames.length) return;
    const frame = frames[frames.length - 1]; // send only the latest frame
    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    const tail = Buffer.from('\r\n');
    clients.forEach(res => {
      try { res.write(Buffer.concat([header, frame, tail])); }
      catch (_) { clients.delete(res); }
    });
  });

  ffmpeg.on('error', err => logToFile(`[Camera] ffmpeg error (${tileId}): ${err.message}`, 'ERROR'));
  ffmpeg.on('close', code => {
    logToFile(`[Camera] ffmpeg exited (${tileId}) code=${code}`, 'INFO');
    clients.forEach(res => { try { res.end(); } catch (_) {} });
  });

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type':  'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Update the stored stream to include the server
  const currentStream = activeStreams.get(tileId);
  if (currentStream) currentStream.server = server;

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  // Final check if aborted during listen
  if (pendingStreams.get(tileId) !== streamId) {
    killProcessTree(ffmpeg);
    try { server.close(); } catch (_) {}
    activeStreams.delete(tileId);
    return { success: false, error: 'Aborted during listen' };
  }

  logToFile(`[Camera] Stream started: ${tileId} → port ${port}`, 'INFO');
  return { success: true, url: `http://127.0.0.1:${port}` };
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
    
    // Derived Working Directory (important for Chrome Apps / chrome_proxy.exe)
    const cwd = path.dirname(appPath);
    console.log(`[Launch] Attempting: ${appPath}`);
    console.log(`[Launch] Set CWD: ${cwd}`);
    if (args && args.length > 0) console.log(`[Launch] Args: ${args.join(' ')}`);

    // Use cmd.exe /c start to launch the app.
    // This is the most reliable "fire-and-forget" method on Windows for GUI apps.
    // - start "" : specifies an empty title (required if the path is quoted)
    // - /D       : sets the working directory
    const joinedArgs = args.join(' ');
    const cmdStr = `start "" /D "${cwd}" "${appPath}" ${joinedArgs}`;
    
    console.log(`[Launch] CMD: ${cmdStr}`);

    // Switch to exec for the CMD start command. 
    // exec uses a shell and handles complex quoting better than spawn in this context.
    exec(cmdStr, { windowsHide: false }, (err) => {
      if (err) {
        console.error(`[Launch] Exec Error: ${err.message}`);
        logToFile(`[Launch] Exec Error: ${err.message}`, 'ERROR');
      }
    });
    
    return { success: true };
  } catch (err) {
    console.error(`[Launch] Error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-command', (_e, command) => {
  console.log(`[Shell] Running: ${command}`);
  return new Promise((resolve) => {
    exec(command, { shell: 'powershell.exe', windowsHide: true }, (err, stdout, stderr) => {
      if (err) console.error(`[Shell] Error: ${err.message}`);
      if (stderr) console.warn(`[Shell] Stderr: ${stderr}`);
      resolve({ success: !err, output: stdout, error: err?.message });
    });
  });
});

ipcMain.handle('send-media-key', (_e, action) => sendMediaKey(action));

ipcMain.handle('read-logs', () => {
  try {
    if (!fs.existsSync(LOG_FILE)) return 'No logs yet.';
    // Read the whole file. Since we rotate at 500KB, this is safe to read.
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch (err) {
    return `Error reading logs: ${err.message}`;
  }
});

ipcMain.handle('get-user-info', () => {
  try {
    const os = require('os');
    return { username: os.userInfo().username.toUpperCase() };
  } catch {
    return { username: 'USER' };
  }
});

ipcMain.handle('clear-logs', () => {
  try {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
    logToFile('Logs cleared by user.', 'INFO');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-external', (_e, url) => {
  try {
    console.log(`[Shell] Opening external URL: ${url}`);
    shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error(`[Shell] Failed to open external URL: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-log-folder', () => {
  shell.showItemInFolder(LOG_FILE);
});

// ── Window Behavior (always-on-top + hide header) ─────────────────────────────
ipcMain.handle('set-window-behavior', (_e, { alwaysOnTop, hideHeader }) => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };

    // Persist both settings atomically
    writeSettingsSync({ alwaysOnTop: !!alwaysOnTop, hideHeader: !!hideHeader });

    // Apply always-on-top at the 'floating' level so CommandDeck stays above
    // normal app windows (HWND_TOPMOST) while still allowing system overlays
    // like the Windows screen saver to render in front of it.
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
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
  // Shut down all active camera streams cleanly
  activeStreams.forEach((_, tileId) => stopCameraStream(tileId));
});

// Camera stream IPC
ipcMain.handle('camera:start', async (_e, tileId, rtspUrl) => {
  try { return await startCameraStream(tileId, rtspUrl); }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('camera:stop', (_e, tileId) => {
  stopCameraStream(tileId);
  return { success: true };
});
