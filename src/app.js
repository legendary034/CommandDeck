/**
 * CommandDeck — Renderer (app.js)
 * Handles tile rendering, live stats, weather, edit modal, and context menu.
 */

import { getIcon, ICONS } from './icons.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  config:           null,
  settings:         {},
  stats:            { cpuLoad: 0, cpuTemp: 0, cpuSpeed: 0, memUsed: 0, gpuTemp: null, cpuPower: null, memClock: null },
  cpuHistory:       [],          // last N samples for sparkline
  weather:          null,
  activeCat:        'All',
  searchQuery:      '',
  editingTile:      null,
  contextMenu:      null,
  displays:         [],
  activeDisplayIdx: 0,
  isRearranging:    false,       // Is drag-and-drop mode active?
  sortableInst:     null,        // SortableJS instance
};

// ─── Utils ────────────────────────────────────────────────────────────────────
const esc = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '');

// ─── WMO weather code → label + icon ─────────────────────────────────────────
function weatherCodeInfo(code) {
  if (code === 0)              return { label: 'CLEAR',      icon: 'sun'        };
  if (code <= 2)               return { label: 'PARTLY CLOUDY', icon: 'sun'     };
  if (code === 3)              return { label: 'OVERCAST',   icon: 'cloud'      };
  if (code <= 48)              return { label: 'FOGGY',      icon: 'cloud'      };
  if (code <= 57)              return { label: 'DRIZZLE',    icon: 'cloud-rain' };
  if (code <= 67)              return { label: 'RAIN',       icon: 'cloud-rain' };
  if (code <= 77)              return { label: 'SNOW',       icon: 'cloud-snow' };
  if (code <= 82)              return { label: 'SHOWERS',    icon: 'cloud-rain' };
  if (code <= 86)              return { label: 'SNOW SHOWERS', icon: 'cloud-snow' };
  if (code <= 99)              return { label: 'STORM',      icon: 'zap'        };
  return                              { label: 'N/A',        icon: 'cloud'      };
}

// ─── Weather fetch ────────────────────────────────────────────────────────────
async function fetchWeather(tile) {
  let lat = tile.config?.lat;
  let lon = tile.config?.lon;
  let city = tile.config?.city;

  if (!lat && city) {
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      );
      const geoData = await geoRes.json();
      if (geoData.results?.length) {
        lat  = geoData.results[0].latitude;
        lon  = geoData.results[0].longitude;
        city = geoData.results[0].name + ', ' + geoData.results[0].country_code.toUpperCase();
        tile.config.lat  = lat;
        tile.config.lon  = lon;
        tile.config.city = city;
        saveConfig();
      }
    } catch { return null; }
  }

  if (!lat) return null;

  try {
    const unit = tile.config?.unit || 'fahrenheit';
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,apparent_temperature&temperature_unit=${unit}&timezone=auto`
    );
    const data = await res.json();
    return {
      city,
      temp:  Math.round(data.current.temperature_2m),
      code:  data.current.weather_code,
      unit:  unit === 'fahrenheit' ? '°F' : '°C',
      ...weatherCodeInfo(data.current.weather_code),
    };
  } catch { return null; }
}

// ─── Config persistence ───────────────────────────────────────────────────────
async function loadConfig() {
  const cfg = await window.commandDeck.readConfig();
  state.config = cfg;
}

async function saveConfig() {
  await window.commandDeck.writeConfig(state.config);
}

// ─── Dynamic Tile Sizing ───────────────────────────────────────────────────────────
// Pass explicit w/h when switching displays: window.screen doesn't update
// synchronously after the window is moved to a new display, so use the known
// target display dimensions from the IPC response instead.
function applyTileSizing(w, h) {
  if (w === undefined) w = window.screen.width;
  if (h === undefined) h = window.screen.height;
  const root = document.documentElement;

  // Determine tile dimensions based on native screen resolution.
  // Values chosen to keep ~5-6 columns comfortable at each breakpoint.
  let minW, rowH;
  if (w >= 3840) {           // 4K UHD
    minW = 230; rowH = 225;
  } else if (w >= 2560) {    // 1440p / QHD
    minW = 195; rowH = 195;
  } else if (w >= 1920) {    // 1080p FHD
    minW = 155; rowH = 155;
  } else if (w >= 1366) {    // 768p / HD+
    minW = 135; rowH = 135;
  } else {                    // below HD
    minW = 115; rowH = 115;
  }

  root.style.setProperty('--tile-min-w', `${minW}px`);
  root.style.setProperty('--tile-row-h', `${rowH}px`);
}



// ─── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  const el = document.getElementById('clock-time');
  const de = document.getElementById('clock-date');
  const ht = document.getElementById('h-time');
  const hd = document.getElementById('h-date');

  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const timeStr = `${hh}:${mm}`;
  const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const shortDate = `${months[now.getMonth()]} ${now.getDate()}`;

  if (el && el.textContent !== timeStr) el.textContent = timeStr;
  if (de && de.textContent !== dateStr) de.textContent = dateStr;
  
  // Header clock
  if (ht && ht.textContent !== timeStr) ht.textContent = timeStr;
  if (hd && hd.textContent !== shortDate) hd.textContent = shortDate;
}

// ─── Stats update ─────────────────────────────────────────────────────────────
function applyStats(stats) {
  Object.assign(state.stats, stats);
  state.cpuHistory.push(stats.cpuLoad);
  if (state.cpuHistory.length > 50) state.cpuHistory.shift();

  // Header stats
  const hCpuVal = document.getElementById('h-cpu-val');
  const hCpuBar = document.getElementById('h-cpu-bar');
  const hMemVal = document.getElementById('h-mem-val');
  const hMemBar = document.getElementById('h-mem-bar');

  if (hCpuVal) hCpuVal.textContent = `${Math.round(stats.cpuLoad)}%`;
  if (hCpuBar) hCpuBar.style.width = `${Math.min(100, stats.cpuLoad)}%`;
  
  if (hMemVal) hMemVal.textContent = `${Math.round(stats.memUsed)}%`;
  if (hMemBar) hMemBar.style.width = `${Math.min(100, stats.memUsed)}%`;

  document.querySelectorAll('.tile-stat').forEach((el) => {
    const statKey = el.dataset.stat;
    const value   = getStat(statKey, stats);
    const valEl   = el.querySelector('.stat-value');
    const sparkEl = el.querySelector('.sparkline');
    if (valEl) {
      valEl.textContent = value ?? '—';
      applyStatColor(valEl, statKey, value);
    }
    if (sparkEl && statKey === 'cpuLoad') renderSparkline(sparkEl);
  });
}

function getStat(key, stats) {
  switch (key) {
    case 'cpuLoad':  return stats.cpuLoad;
    case 'cpuTemp':  return stats.cpuTemp;
    case 'cpuSpeed': return stats.cpuSpeed;
    case 'memUsed':  return stats.memUsed;
    case 'gpuTemp':  return stats.gpuTemp;
    case 'cpuPower': return stats.cpuPower;
    case 'memClock': return stats.memClock ?? 4000; // fallback
    default:         return null;
  }
}

function applyStatColor(el, key, value) {
  el.classList.remove('warn', 'crit');
  if (value === null || value === undefined) return;
  if (['cpuTemp','gpuTemp'].includes(key)) {
    if (value >= 90) el.classList.add('crit');
    else if (value >= 75) el.classList.add('warn');
  }
  if (key === 'cpuLoad') {
    if (value >= 95) el.classList.add('crit');
    else if (value >= 80) el.classList.add('warn');
  }
}

function renderSparkline(container) {
  container.innerHTML = '';
  const maxH = 12;
  const data  = state.cpuHistory;
  data.forEach((v) => {
    const bar = document.createElement('div');
    bar.className = 'spark-bar';
    const pct = Math.max(2, Math.round((v / 100) * maxH));
    bar.style.height = `${pct}px`;
    bar.style.background = v > 80 ? 'rgba(255,104,32,.7)' : v > 60 ? 'rgba(255,221,0,.6)' : 'rgba(0,212,255,.5)';
    container.appendChild(bar);
  });
}

// ─── Tile Renderers ───────────────────────────────────────────────────────────
function buildTileBase(tile) {
  const div = document.createElement('div');
  div.className = `tile tile-${tile.type} ${tile.size || 'small'}`;
  div.dataset.id = tile.id;
  div.dataset.stat = tile.stat || '';
  div.style.background = tile.color || '#0a1a3a';

  div.addEventListener('click',       (e) => handleTileClick(e, tile));
  div.addEventListener('contextmenu', (e) => showContextMenu(e, tile));

  return div;
}

function getTileIconHtml(tile, defaultIconName) {
  if (tile.iconUrl) {
    return `<img src="${tile.iconUrl}" class="tile-custom-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
            <div class="tile-icon-fallback" style="display:none">${getIcon(defaultIconName)}</div>`;
  }
  return `<div class="tile-icon">${getIcon(defaultIconName)}</div>`;
}

function renderClockTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-clock');
  
  const iconHtml = tile.iconUrl ? `<div class="tile-clock-custom-icon">${getTileIconHtml(tile, '')}</div>` : '';

  div.innerHTML = `
    ${iconHtml}
    <div class="clock-time font-orbit" id="clock-time">00:00</div>
    <div class="clock-date" id="clock-date">Loading…</div>
  `;
  return div;
}

function renderWeatherTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-weather');

  if (!tile.config?.city && !tile.config?.lat) {
    div.innerHTML = `
      <div class="weather-setup">
        <p>Enter your city for live weather</p>
        <input id="weather-city-input" class="weather-city-input" placeholder="e.g. Chicago" spellcheck="false" />
        <button class="btn-weather-set" id="btn-set-weather">GO</button>
      </div>`;
    div.addEventListener('click', (e) => e.stopPropagation()); // intercept for form
    div.querySelector('#btn-set-weather')?.addEventListener('click', async () => {
      const city = div.querySelector('#weather-city-input')?.value.trim();
      if (!city) return;
      tile.config = { ...tile.config, city, lat: null, lon: null };
      await saveConfig();
      const weatherData = await fetchWeather(tile);
      state.weather = weatherData;
      const fresh = renderWeatherContent(tile, weatherData);
      div.replaceWith(fresh);
    });
    div.querySelector('#weather-city-input')?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') div.querySelector('#btn-set-weather')?.click();
    });
  } else {
    return renderWeatherContent(tile, state.weather);
  }

  return div;
}

function renderWeatherContent(tile, weather) {
  const div = buildTileBase(tile);
  div.classList.add('tile-weather');

  if (!weather) {
    div.innerHTML = `
      <div class="tile-label">${tile.label || 'WEATHER'}</div>
      <div class="stat-value-wrap"><div class="stat-value" style="font-size:.9rem;color:rgba(255,255,255,.3)">Fetching…</div></div>`;
    return div;
  }

  const info = weatherCodeInfo(weather.code);
  div.innerHTML = `
    <div class="tile-label">${tile.label || 'WEATHER'}</div>
    <div class="weather-location">${weather.city || ''}</div>
    <div class="weather-top">
      <span class="weather-icon-wrap">${getIcon(info.icon)}</span>
      <span class="weather-temp">${weather.temp}<span class="weather-unit">${weather.unit}</span></span>
    </div>
    <div class="weather-desc">${info.label}</div>`;
  return div;
}

function renderStatTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-stat');
  div.dataset.stat = tile.stat;

  const value = getStat(tile.stat, state.stats) ?? '—';
  const hasSpark = tile.stat === 'cpuLoad';

  div.innerHTML = `
    <div class="tile-label">${tile.label || tile.stat}</div>
    <div class="stat-value-wrap">
      <div class="stat-value font-mono">${value}</div>
      <div class="stat-unit">${tile.unit || ''}</div>
    </div>
    ${hasSpark ? '<div class="sparkline"></div>' : ''}`;

  if (hasSpark) renderSparkline(div.querySelector('.sparkline'));
  applyStatColor(div.querySelector('.stat-value'), tile.stat, value);
  return div;
}

function renderMediaTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-media');
  div.innerHTML = `
    ${tile.label ? `<div class="tile-label">${tile.label}</div>` : ''}
    <div class="tile-icon-container">${getTileIconHtml(tile, tile.icon || 'play')}</div>`;
  return div;
}

function renderActionTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-action');
  const label = tile.label ? `<div class="tile-label">${tile.label}</div>` : '';
  div.innerHTML = `
    ${label}
    <div class="tile-icon-container">${getTileIconHtml(tile, tile.icon || 'zap')}</div>`;
  return div;
}

function renderTile(tile) {
  switch (tile.type) {
    case 'clock':   return renderClockTile(tile);
    case 'weather': return renderWeatherTile(tile);
    case 'stat':    return renderStatTile(tile);
    case 'media':   return renderMediaTile(tile);
    case 'logs':    return renderLogsTile(tile);
    case 'action':
    default:        return renderActionTile(tile);
  }
}

function renderLogsTile(tile) {
  const el = document.createElement('div');
  el.className = `tile tile-logs ${tile.size || 'small'}`;
  el.dataset.id = tile.id;
  el.style.backgroundColor = tile.color || '#0d122b';

  el.innerHTML = `
    <div class="tile-label">${tile.label || 'LOGS'}</div>
    <div class="tile-icon">${getIcon(tile.icon || 'terminal')}</div>
  `;
  el.addEventListener('click', (e) => handleTileClick(e, tile));
  return el;
}

// ─── Canvas Render ────────────────────────────────────────────────────────────
function renderCanvas() {
  const canvas = document.getElementById('tile-canvas');
  canvas.innerHTML = '';

  const query = state.searchQuery.toLowerCase();
  const cat   = state.activeCat;

  let tiles = [...state.config.tiles];
  if (state.settings.autoSort) {
    tiles.sort((a, b) => {
      const pA = a.priority || 0;
      const pB = b.priority || 0;
      if (pB !== pA) return pB - pA;
      return (a.label || '').localeCompare(b.label || '');
    });
  }

  tiles.forEach((tile) => {
    // Category filter
    if (cat !== 'All' && tile.category && tile.category !== cat) return;
    // Search filter
    if (query && !`${tile.label}${tile.type}${tile.id}`.toLowerCase().includes(query)) return;

    const el = renderTile(tile);
    if (state.isRearranging) el.classList.add('rearrange-active');
    canvas.appendChild(el);
  });

  // Add-tile placeholder
  const addBtn = document.createElement('div');
  addBtn.className = 'tile-add-placeholder';
  addBtn.title = 'Add Tile';
  addBtn.id = 'tile-add-btn';
  addBtn.innerHTML = '+';
  addBtn.addEventListener('click', () => openAddModal());
  canvas.appendChild(addBtn);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const CATEGORY_ICONS = {
  All:     '⁙',
  System:  '⌥',
  Media:   '♫',
  Apps:    '⬡',
  Widgets: '◈',
};

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  const cats = state.config?.categories || ['All'];
  cats.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'sidebar-cat' + (cat === state.activeCat ? ' active' : '');
    btn.title = cat;
    btn.setAttribute('aria-label', cat);
    btn.innerHTML = `
      <span class="sidebar-cat-icon">${CATEGORY_ICONS[cat] || '●'}</span>
      <span class="sidebar-cat-label">${cat}</span>`;
    btn.addEventListener('click', () => {
      if (state.isRearranging) toggleRearrangeMode(false); // Disable rearrange when switching cats
      state.activeCat = cat;
      renderSidebar();
      renderCanvas();
    });
    nav.appendChild(btn);
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('input', (e) => {
  if (state.isRearranging) toggleRearrangeMode(false); // Disable rearrange when searching
  state.searchQuery = e.target.value;
  renderCanvas();
});

// ─── Tile Click Handler ───────────────────────────────────────────────────────
async function handleTileClick(e, tile) {
  if (state.isRearranging) return; // Prevent clicks while rearranging
  e.stopPropagation();
  hideContextMenu();

  if (tile.type === 'logs') {
    openLogsModal();
    return;
  }

  switch (tile.type) {
    case 'media':
      await window.commandDeck.sendMediaKey(tile.action);
      showToast(`Media: ${tile.action}`, 'success', 1200);
      break;

    case 'shell':
      if (tile.command) {
        const res = await window.commandDeck.runCommand(tile.command);
        if (!res.success) showToast(`Error: ${res.error}`, 'error');
      }
      break;

    case 'action':
      if (tile.command) {
        const res = await window.commandDeck.runCommand(tile.command);
        if (!res.success) showToast(`Error: ${res.error}`, 'error');
      } else if (tile.path) {
        const res = await window.commandDeck.launchApp(tile.path, tile.args);
        if (!res.success) showToast(`Launch failed: ${res.error}`, 'error');
        else showToast(`Launched ${tile.label || 'app'}`, 'success', 1500);
      } else {
        openEditModal(tile);
      }
      break;

    case 'stat':
    case 'clock':
    case 'weather':
      // no-op on click for info tiles
      break;
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
function showContextMenu(e, tile) {
  if (state.isRearranging) return; // Prevent context menu while rearranging
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();

  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-edit">
      <span>${getIcon('edit')}&nbsp; Edit Tile</span>
    </div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" id="ctx-delete">
      <span>${getIcon('trash')}&nbsp; Remove Tile</span>
    </div>`;

  document.body.appendChild(menu);

  // Position
  const { clientX: x, clientY: y } = e;
  const mw = 170, mh = 80;
  menu.style.left = `${Math.min(x, window.innerWidth  - mw - 8)}px`;
  menu.style.top  = `${Math.min(y, window.innerHeight - mh - 8)}px`;

  requestAnimationFrame(() => menu.classList.add('visible'));

  menu.querySelector('#ctx-edit').addEventListener('click', () => {
    hideContextMenu(); openEditModal(tile);
  });
  menu.querySelector('#ctx-delete').addEventListener('click', () => {
    hideContextMenu(); deleteTile(tile.id);
  });

  state.contextMenu = menu;
}

function hideContextMenu() {
  const m = document.getElementById('context-menu');
  if (m) m.remove();
  state.contextMenu = null;
}

document.addEventListener('click',     () => hideContextMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

// ─── Edit Modal ───────────────────────────────────────────────────────────────
const PRESET_COLORS = [
  '#0f1fb5','#1539a8','#4c1d95','#5b21b6','#9d174d',
  '#881337','#0a1a3a','#1e3a5f','#065f46','#7f5009',
];

function openEditModal(tile) {
  state.editingTile = tile;
  const modal = document.getElementById('edit-modal');
  const body  = document.getElementById('edit-modal-body');

  const isWeather = tile.type === 'weather';

  const TYPE_LABELS = {
    action:  'Application (EXE/Path)',
    shell:   'Shell Command (PowerShell)',
    media:   'Media Key',
    stat:    'System Stat',
    clock:   'Clock Widget',
    weather: 'Weather Widget',
  };

  const typeOpts = ['action','shell','media','stat','clock','weather']
    .map(t => `<option value="${t}" ${t === tile.type ? 'selected' : ''}>${TYPE_LABELS[t] || t}</option>`)
    .join('');

  const iconOpts = Object.keys(ICONS)
    .map(k => `<option value="${k}" ${k === (tile.icon||'') ? 'selected' : ''}>${k}</option>`)
    .join('');

  const colorSwatches = PRESET_COLORS
    .map(c => `<div class="color-swatch${c === tile.color ? ' active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></div>`)
    .join('');

  const currentCity = tile.config?.city || '';
  const currentUnit = tile.config?.unit || 'fahrenheit';

  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Label</label>
      <input class="form-input" id="ef-label" value="${esc(tile.label)}" placeholder="Tile label" />
    </div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <select class="form-select" id="ef-type">${typeOpts}</select>
    </div>
    <div class="form-group" id="ef-icon-group" ${isWeather ? 'style="display:none"' : ''}>
      <label class="form-label">Default Icon</label>
      <select class="form-select" id="ef-icon">${iconOpts}</select>
    </div>
    <div class="form-group" id="ef-icon-url-group" ${isWeather ? 'style="display:none"' : ''}>
      <div class="label-row">
        <label class="form-label">Custom Icon URL</label>
        <button id="btn-find-logo" class="btn-text-action">Find Logo ⬈</button>
      </div>
      <div class="url-input-row">
        <input class="form-input" id="ef-icon-url" value="${esc(tile.iconUrl)}" placeholder="Paste PNG/SVG URL here" />
        <div id="ef-icon-preview" class="icon-input-preview">${tile.iconUrl ? `<img src="${esc(tile.iconUrl)}" />` : ''}</div>
      </div>
    </div>
    <div class="form-group" id="ef-cmd-group" ${isWeather ? 'style="display:none"' : ''}>
      <label class="form-label" id="ef-cmd-label">${tile.type === 'shell' ? 'PowerShell Command' : (tile.type === 'action' ? 'App Path / Script' : 'Command')}</label>
      <input class="form-input" id="ef-command" value="${esc(tile.command || tile.path)}" placeholder="e.g. C:\Windows\notepad.exe" />
    </div>
    <div class="form-group" id="ef-args-group" ${tile.type === 'action' ? '' : 'style="display:none"'}>
      <label class="form-label">Arguments</label>
      <input class="form-input" id="ef-args" value="${esc((tile.args || []).join(' '))}" placeholder="e.g. --profile-directory=Default --app-id=..." />
      <p class="form-hint">Tip: If you paste a shortcut with arguments into the Path field, I'll split them for you automatically.</p>
    </div>
    ${isWeather ? `
    <div class="form-group" id="ef-weather-group">
      <label class="form-label">City / Location</label>
      <input class="form-input" id="ef-weather-city" value="${esc(currentCity)}" placeholder="e.g. Chicago, New York, London" />
      <p class="form-hint">Changing the city will re-fetch weather on save.</p>
    </div>
    <div class="form-group">
      <label class="form-label">Temperature Unit</label>
      <div class="unit-toggle-row">
        <button class="unit-btn ${currentUnit === 'fahrenheit' ? 'active' : ''}" id="ef-unit-f" data-unit="fahrenheit">°F — Fahrenheit</button>
        <button class="unit-btn ${currentUnit === 'celsius' ? 'active' : ''}" id="ef-unit-c" data-unit="celsius">°C — Celsius</button>
      </div>
    </div>` : ''}
    <div class="form-group">
      <label class="form-label">Size</label>
      <select class="form-select" id="ef-size">
        ${['small','wide','tall','large'].map(s => `<option value="${s}" ${s === (tile.size||'small') ? 'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Priority (0-100)</label>
      <input type="number" class="form-input" id="ef-priority" value="${tile.priority || 0}" min="0" max="100" />
      <p class="form-hint">Higher priority tiles appear first when Auto-Sort is enabled.</p>
    </div>
    <div class="form-group">
      <label class="form-label">Accent Color</label>
      <div class="color-row" id="ef-colors">
        ${colorSwatches}
        <input type="color" class="form-color-custom" id="ef-color-custom" value="${tile.color || '#0a1a3a'}" />
      </div>
    </div>`;

  // Color swatch interaction
  let chosenColor = tile.color || '#0a1a3a';
  body.querySelectorAll('.color-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      body.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      chosenColor = sw.dataset.color;
      body.querySelector('#ef-color-custom').value = chosenColor;
    });
  });
  body.querySelector('#ef-color-custom').addEventListener('input', (e) => {
    chosenColor = e.target.value;
    body.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  });

  // Weather unit toggle
  let chosenUnit = currentUnit;
  if (isWeather) {
    body.querySelectorAll('.unit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        body.querySelectorAll('.unit-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        chosenUnit = btn.dataset.unit;
      });
    });
  }

  // Type change handling (show/hide fields)
  body.querySelector('#ef-type').addEventListener('change', (e) => {
    const type = e.target.value;
    const isAct   = type === 'action';
    const isShell = type === 'shell';
    const isWeath = type === 'weather';

    body.querySelector('#ef-icon-group').style.display = isWeath ? 'none' : '';
    body.querySelector('#ef-icon-url-group').style.display = isWeath ? 'none' : '';
    body.querySelector('#ef-cmd-group').style.display = isWeath ? 'none' : '';
    body.querySelector('#ef-args-group').style.display = isAct ? '' : 'none';
    
    body.querySelector('#ef-cmd-label').textContent = isShell ? 'PowerShell Command' : (isAct ? 'App Path / Script' : 'Command');
  });

  // Icon URL Preview & Find Logo
  const iconUrlInput = body.querySelector('#ef-icon-url');
  const iconPreview  = body.querySelector('#ef-icon-preview');
  
  iconUrlInput.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    iconPreview.innerHTML = url ? `<img src="${url}" />` : '';
  });

  body.querySelector('#btn-find-logo')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const label = body.querySelector('#ef-label').value.trim() || 'app';
    const query = encodeURIComponent(`${label} logo transparent png`);
    const searchUrl = `https://www.google.com/search?q=${query}&tbm=isch`;
    
    console.log(`[UI] Find Logo clicked for: ${label}`);
    try {
      await window.commandDeck.openExternal(searchUrl);
    } catch (err) {
      console.error(`[UI] Find Logo failed: ${err.message}`);
    }
  });

  // Magic Paste splitting (for Action tiles)
  body.querySelector('#ef-command').addEventListener('input', (e) => {
    if (body.querySelector('#ef-type').value !== 'action') return;
    const val = e.target.value.trim();
    // If it starts with a quote and has content after the closing quote
    // e.g. "C:\Path\To\app.exe" --arg1 --arg2
    const match = val.match(/^"([^"]+)"\s+(.+)$/);
    if (match) {
      const path = match[1];
      const args = match[2];
      e.target.value = path;
      const argsInput = body.querySelector('#ef-args');
      if (argsInput) argsInput.value = args;
      showToast('Magic Split: Path and Args separated!', 'info', 2000);
    }
  });

  modal.classList.remove('hidden');

  // Save
  document.getElementById('btn-modal-save').onclick = async () => {
    const newType = body.querySelector('#ef-type').value;
    tile.priority = parseInt(body.querySelector('#ef-priority')?.value || 0, 10);
    tile.label = body.querySelector('#ef-label').value.trim();
    tile.type  = newType;
    tile.size  = body.querySelector('#ef-size').value;
    tile.color = chosenColor;

    if (newType === 'weather') {
      const newCity = (body.querySelector('#ef-weather-city')?.value || '').trim();
      const cityChanged = newCity !== currentCity;
      tile.config = {
        ...(tile.config || {}),
        city: newCity,
        unit: chosenUnit,
        // Clear cached coords when city changes so it re-geocodes
        lat: cityChanged ? null : (tile.config?.lat ?? null),
        lon: cityChanged ? null : (tile.config?.lon ?? null),
      };
      if (cityChanged) state.weather = null; // force re-fetch
    } else {
      tile.icon    = body.querySelector('#ef-icon').value;
      tile.iconUrl = body.querySelector('#ef-icon-url')?.value.trim() || null;
      const cmdRaw = body.querySelector('#ef-command').value.trim();
      const argsRaw = body.querySelector('#ef-args').value.trim();

      if (newType === 'action') {
        tile.path = cmdRaw;
        tile.args = argsRaw ? argsRaw.split(' ') : [];
        delete tile.command;
      } else if (newType === 'shell') {
        tile.command = cmdRaw;
        delete tile.path;
        delete tile.args;
      } else {
        tile.command = cmdRaw;
        delete tile.path;
        delete tile.args;
      }
    }

    await saveConfig();
    closeEditModal();

    // Re-fetch weather if config changed
    if (newType === 'weather') {
      renderCanvas();
      updateClock();
      if (tile.config?.city) {
        fetchWeather(tile).then((w) => {
          state.weather = w;
          renderCanvas();
        });
      }
    } else {
      renderCanvas();
      updateClock();
    }
    showToast('Tile saved', 'success');
  };
}

function openAddModal() {
  const newTile = {
    id:    `tile-${Date.now()}`,
    type:  'action',
    size:  'small',
    color: '#1539a8',
    label: 'New Tile',
    icon:  'zap',
  };
  state.config.tiles.push(newTile);
  openEditModal(newTile);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  state.editingTile = null;
}

async function deleteTile(id) {
  state.config.tiles = state.config.tiles.filter(t => t.id !== id);
  await saveConfig();
  renderCanvas();
  showToast('Tile removed', 'success');
}

// Modal close / delete bindings
document.getElementById('btn-modal-close').addEventListener('click',  closeEditModal);
document.getElementById('btn-modal-cancel').addEventListener('click', closeEditModal);
document.getElementById('edit-modal-backdrop').addEventListener('click', closeEditModal);
document.getElementById('btn-modal-delete').addEventListener('click', async () => {
  if (!state.editingTile) return;
  await deleteTile(state.editingTile.id);
  closeEditModal();
});

// ─── Default Tiles (for restore) ─────────────────────────────────────────────
// Mirrors the bundled config/tiles.json defaults so we can restore any tile
// the user accidentally deleted — without wiping any custom tiles.
const DEFAULT_TILES = [
  { id: 'clock',       type: 'clock',   size: 'wide',  color: '#0f1fb5', label: 'CLOCK' },
  { id: 'mute',        type: 'media',   action: 'mute',       size: 'small', color: '#5b1e8a', label: '',         icon: 'volume-x' },
  { id: 'weather',     type: 'weather', size: 'wide',  color: '#0a0f2e', label: 'WEATHER', config: { city: '', lat: null, lon: null, unit: 'fahrenheit' } },
  { id: 'media-prev',  type: 'media',   action: 'prev',       size: 'small', color: '#1539a8', label: '',         icon: 'skip-back' },
  { id: 'media-play',  type: 'media',   action: 'play-pause', size: 'small', color: '#0f1fb5', label: '',         icon: 'play' },
  { id: 'media-next',  type: 'media',   action: 'next',       size: 'small', color: '#1539a8', label: '',         icon: 'skip-forward' },
  { id: 'cpu-clock',   type: 'stat',    stat: 'cpuSpeed', size: 'small', color: '#0a1a3a', label: 'CPU CLOCK',  unit: 'MHZ' },
  { id: 'cpu-usage',   type: 'stat',    stat: 'cpuLoad',  size: 'small', color: '#0a1a3a', label: 'CPU USAGE',  unit: '%' },
  { id: 'cpu-temp',    type: 'stat',    stat: 'cpuTemp',  size: 'small', color: '#0a1a3a', label: 'CPU TEMP',   unit: '°C' },
  { id: 'gpu-temp',    type: 'stat',    stat: 'gpuTemp',  size: 'small', color: '#0a1a3a', label: 'GPU TEMP',   unit: '°C' },
  { id: 'cpu-power',   type: 'stat',    stat: 'cpuPower', size: 'small', color: '#881337', label: 'CPU POWER',  unit: 'W' },
  { id: 'mem-clock',   type: 'stat',    stat: 'memClock', size: 'small', color: '#0a1a3a', label: 'MEM CLOCK',  unit: 'MHZ' },
  { id: 'gemini',     type: 'action',  size: 'small', color: '#1539a8', label: 'GEMINI',       icon: 'zap',         path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', args: ['--profile-directory=Default', '--app-id=gdfaincndogidkdcdkhapmbffkckdkhn'] },
  { id: 'music-app',   type: 'action',  size: 'small', color: '#1539a8', label: 'MUSIC',        icon: 'music',       path: '', args: [] },
  { id: 'flame',       type: 'action',  size: 'small', color: '#1539a8', label: 'HOTSPOT',      icon: 'flame',       path: '', args: [] },
  { id: 'live-streams',type: 'action',  size: 'wide',  color: '#4c1d95', label: 'LIVE STREAMS', icon: 'radio',       path: '', args: [] },
  { id: 'layers',      type: 'action',  size: 'small', color: '#5b21b6', label: '',             icon: 'layers',      path: '', args: [] },
  { id: 'work-macros', type: 'action',  size: 'small', color: '#9d174d', label: 'WORK MACROS',  icon: 'folder-open', path: '', args: [] },
  { id: 'system-logs', type: 'logs', size: 'small', color: '#0d122b', label: 'SYSTEM LOGS', icon: 'terminal' },
];

function getDeletedDefaults() {
  const existing = new Set(state.config.tiles.map(t => t.id));
  return DEFAULT_TILES.filter(t => !existing.has(t.id));
}

async function restoreDefaultTile(defaultTile) {
  // Don't double-add
  if (state.config.tiles.find(t => t.id === defaultTile.id)) return;
  state.config.tiles.push({ ...defaultTile });
  await saveConfig();
  renderCanvas();
  renderRestoreList();
  showToast(`Restored: ${defaultTile.label || defaultTile.id}`, 'success');
}

async function restoreAllDefaults() {
  const missing = getDeletedDefaults();
  if (!missing.length) { showToast('All default tiles are present', ''); return; }
  missing.forEach(d => state.config.tiles.push({ ...d }));
  await saveConfig();
  renderCanvas();
  renderRestoreList();
  showToast(`Restored ${missing.length} tile${missing.length > 1 ? 's' : ''}`, 'success');
}

function renderRestoreList() {
  const wrap = document.getElementById('restore-missing-list');
  if (!wrap) return;
  const missing = getDeletedDefaults();
  const restoreAllBtn = document.getElementById('btn-restore-all');

  if (!missing.length) {
    wrap.innerHTML = '<p class="restore-all-clear">✓ All default tiles are present</p>';
    if (restoreAllBtn) restoreAllBtn.disabled = true;
    return;
  }

  if (restoreAllBtn) restoreAllBtn.disabled = false;
  wrap.innerHTML = '';
  missing.forEach(d => {
    const row = document.createElement('div');
    row.className = 'restore-tile-row';
    row.innerHTML = `
      <span class="restore-tile-label">${d.label || d.id}</span>
      <span class="restore-tile-type">${d.type}</span>
      <button class="btn-restore-one" data-id="${d.id}">+ Restore</button>`;
    row.querySelector('.btn-restore-one').addEventListener('click', () => restoreDefaultTile(d));
    wrap.appendChild(row);
  });
}

// ─── Add Tile Button ──────────────────────────────────────────────────────────
document.getElementById('btn-add-tile').addEventListener('click', openAddModal);

// ─── Rearrange Mode ──────────────────────────────────────────────────────────
function toggleRearrangeMode(forceState) {
  const newState = forceState !== undefined ? forceState : !state.isRearranging;
  if (newState === state.isRearranging) return;

  // Only allow rearranging in 'All' category with no search
  if (newState && (state.activeCat !== 'All' || state.searchQuery)) {
    showToast('Switch to "All" category & clear search to rearrange', 'warn');
    return;
  }

  state.isRearranging = newState;
  const btn = document.getElementById('btn-rearrange');
  const canvas = document.getElementById('tile-canvas');

  if (state.isRearranging) {
    if (state.settings.autoSort) {
      showToast('Disable "Auto-Sort Tiles" in settings to rearrange manually', 'warn');
      state.isRearranging = false;
      return;
    }
    btn.classList.add('active');
    canvas.classList.add('rearranging');
    initSortable();
    showToast('Rearrange mode active', 'info', 1500);
  } else {
    btn.classList.remove('active');
    canvas.classList.remove('rearranging');
    destroySortable();
    showToast('Changes saved', 'success', 1500);
  }

  renderCanvas(); // Redraw tiles with rearrange handles
}

function initSortable() {
  const canvas = document.getElementById('tile-canvas');
  if (!window.Sortable) {
    console.error('SortableJS not loaded');
    return;
  }

  state.sortableInst = window.Sortable.create(canvas, {
    animation: 250,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    draggable: '.tile',
    scroll: true,
    scrollSensitivity: 50,
    scrollSpeed: 10,
    bubbleScroll: true,
    onEnd: async () => {
      // Get new ID order from DOM
      const currentIds = Array.from(canvas.querySelectorAll('.tile'))
        .map(el => el.dataset.id)
        .filter(Boolean);

      // Reorder state.config.tiles based on these IDs
      const newTileOrder = [];
      currentIds.forEach((id) => {
        const t = state.config.tiles.find(tile => tile.id === id);
        if (t) newTileOrder.push(t);
      });

      // Append any tiles that were filtered out (just in case, though we only allow rearranging in 'All')
      state.config.tiles.forEach((t) => {
        if (!currentIds.includes(t.id)) newTileOrder.push(t);
      });

      state.config.tiles = newTileOrder;
      await saveConfig();
      showToast('Layout updated', 'success', 800);
    }
  });
}

function destroySortable() {
  if (state.sortableInst) {
    state.sortableInst.destroy();
    state.sortableInst = null;
  }
}

document.getElementById('btn-rearrange')?.addEventListener('click', () => toggleRearrangeMode());

// ─── Settings Modal ───────────────────────────────────────────────────────────────

// Apply/remove compact-mode class (hides titlebar, expands app height)
function applyWindowBehavior({ hideHeader, alwaysOnTop }) {
  document.body.classList.toggle('compact-mode', !!hideHeader);
  // Reflect always-on-top state on the toggle if it's rendered
  const aotToggle = document.getElementById('toggle-always-on-top');
  if (aotToggle) aotToggle.checked = !!alwaysOnTop;
  const hhToggle = document.getElementById('toggle-hide-header');
  if (hhToggle) hhToggle.checked = !!hideHeader;
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  renderDisplayList();
  renderWindowBehavior();
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

// ─── App Logs ──────────────────────────────────────────────────────────────

function renderWindowBehavior() {
  const wrap = document.getElementById('window-behavior-controls');
  if (!wrap) return;

  const hideHeader  = !!(state.settings.hideHeader);
  const alwaysOnTop = !!(state.settings.alwaysOnTop);

  wrap.innerHTML = `
    <div class="behavior-row">
      <div class="behavior-info">
        <span class="behavior-label">Hide Titlebar</span>
        <span class="behavior-desc">Removes the title bar, minimize, maximize &amp; close buttons for a fully clean display.</span>
      </div>
      <label class="toggle-switch" title="Toggle titlebar visibility">
        <input type="checkbox" id="toggle-hide-header" ${hideHeader ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>
    <div class="behavior-row">
      <div class="behavior-info">
        <span class="behavior-label">Always on Top</span>
        <span class="behavior-desc">Keeps CommandDeck above every other window on its monitor — including browsers and other apps — so shortcuts are always available. Other programs can still open on that screen but will appear behind CommandDeck.</span>
      </div>
      <label class="toggle-switch" title="Toggle always on top">
        <input type="checkbox" id="toggle-always-on-top" ${alwaysOnTop ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>
    <div class="behavior-row">
      <div class="behavior-info">
        <span class="behavior-label">Auto-Sort Tiles</span>
        <span class="behavior-desc">Automatically organize tiles by priority (highest first) and then alphabetically. Disables manual rearranging.</span>
      </div>
      <label class="toggle-switch" title="Toggle automatic sorting">
        <input type="checkbox" id="toggle-auto-sort" ${state.settings.autoSort ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>`;

  // Wire toggles
  function syncBehavior() {
    const hh  = document.getElementById('toggle-hide-header')?.checked  ?? hideHeader;
    const aot = document.getElementById('toggle-always-on-top')?.checked ?? alwaysOnTop;
    // Update renderer state
    state.settings.hideHeader  = hh;
    state.settings.alwaysOnTop = aot;
    // Apply CSS locally (immediate feedback, main process will confirm via IPC)
    applyWindowBehavior({ hideHeader: hh, alwaysOnTop: aot });
    // Persist & apply in main process
    window.commandDeck.setWindowBehavior({ hideHeader: hh, alwaysOnTop: aot });
  }

  document.getElementById('toggle-hide-header')?.addEventListener('change', syncBehavior);
  document.getElementById('toggle-always-on-top')?.addEventListener('change', syncBehavior);
  document.getElementById('toggle-auto-sort')?.addEventListener('change', (e) => {
    state.settings.autoSort = e.target.checked;
    window.commandDeck.setWindowBehavior(state.settings);
    renderCanvas();
    if (state.settings.autoSort && state.isRearranging) toggleRearrangeMode(false);
  });
}

function renderDisplayList() {
  const container = document.getElementById('display-list');
  if (!container) return;
  container.innerHTML = '';

  if (!state.displays.length) {
    container.innerHTML = '<p style="color:var(--text-dim);font-size:12px;text-align:center;padding:16px">No display info available.</p>';
    return;
  }

  state.displays.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'display-card' + (d.index === state.activeDisplayIdx ? ' active' : '');
    card.dataset.index = d.index;
    card.id = `display-card-${d.index}`;

    const badges = [
      d.isPrimary ? '<span class="badge-primary">PRIMARY</span>' : '',
      d.index === state.activeDisplayIdx ? '<span class="badge-active">ACTIVE</span>' : '',
    ].filter(Boolean).join('');

    const dpi = d.scaleFactor !== 1 ? ` @${d.scaleFactor}x` : '';
    const label = d.label && d.label !== `Display ${d.index + 1}` ? d.label : `Display ${d.index + 1}`;

    card.innerHTML = `
      <div class="display-check">✓</div>
      <div class="display-card-top">
        <div class="display-icon"></div>
        <div class="display-badges">${badges}</div>
      </div>
      <div class="display-index">${String(d.index + 1).padStart(2, '0')}</div>
      <div class="display-name">${label}</div>
      <div class="display-res">${d.width} × ${d.height}${dpi}</div>`;

    card.addEventListener('click', async () => {
      if (d.index === state.activeDisplayIdx) return;

      // Optimistic UI update
      state.activeDisplayIdx = d.index;
      container.querySelectorAll('.display-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      // Re-render all badges
      renderDisplayList();

      const res = await window.commandDeck.setDisplay(d.index);
      if (res.success) {
        // Use dimensions returned by IPC (target display's physical resolution)
        // because window.screen won't update synchronously after the move.
        applyTileSizing(res.width || d.width, res.height || d.height);
        // Also persist the selection in renderer state so re-opening settings shows correct active display
        state.settings.preferredDisplay = d.index;
        showToast(`Moved to ${label}`, 'success');
      } else {
        // Revert optimistic update on failure
        state.activeDisplayIdx = state.settings.preferredDisplay ?? 0;
        renderDisplayList();
        showToast(`Failed: ${res.error}`, 'error');
      }
    });

    container.appendChild(card);
  });
}

// Close bindings
document.getElementById('btn-settings-close').addEventListener('click', closeSettingsModal);
document.getElementById('btn-settings-done').addEventListener('click',  closeSettingsModal);
document.getElementById('settings-modal-backdrop').addEventListener('click', closeSettingsModal);

// Sidebar button
document.getElementById('btn-settings').addEventListener('click', openSettingsModal);

// Restore defaults button
document.getElementById('btn-restore-all')?.addEventListener('click', restoreAllDefaults);


// ─── Titlebar controls ────────────────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.commandDeck.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.commandDeck.maximize());
document.getElementById('btn-close').addEventListener('click',    () => window.commandDeck.close());

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = '', duration = 2500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Apply tile sizing immediately based on current screen resolution
  applyTileSizing();

  // Load config and settings in parallel
  const [cfg] = await Promise.all([
    window.commandDeck.readConfig(),
  ]);
  state.config = cfg;

  try {
    state.settings         = await window.commandDeck.readSettings();
    state.displays         = await window.commandDeck.getDisplays();
    state.activeDisplayIdx = typeof state.settings.preferredDisplay === 'number'
      ? state.settings.preferredDisplay
      : 0;
    
    // Set dynamic username in header
    const userInfo = await window.commandDeck.getUserInfo();
    const profileEl = document.getElementById('header-profile');
    if (profileEl) profileEl.textContent = userInfo.username || 'USER';
  } catch { /* non-critical */ }

  if (!state.config) {
    document.getElementById('tile-canvas').innerHTML =
      '<p style="color:var(--text-dim);padding:20px;font-family:monospace">No config found. Check config/tiles.json.</p>';
    return;
  }

  renderSidebar();

  // Fetch weather tile data
  const weatherTile = state.config.tiles.find(t => t.type === 'weather');
  if (weatherTile && (weatherTile.config?.city || weatherTile.config?.lat)) {
    fetchWeather(weatherTile).then((w) => {
      state.weather = w;
      renderCanvas();
    });
  }

  renderCanvas();

  // Tick clock
  updateClock();
  setInterval(updateClock, 1000);

  // Subscribe to stats
  window.commandDeck.onStats((stats) => applyStats(stats));

  // Receive window behavior from main (on startup + after changes)
  window.commandDeck.onApplyWindowBehavior((opts) => {
    applyWindowBehavior(opts);
    // Keep renderer state in sync
    if (typeof opts.hideHeader  === 'boolean') state.settings.hideHeader  = opts.hideHeader;
    if (typeof opts.alwaysOnTop === 'boolean') state.settings.alwaysOnTop = opts.alwaysOnTop;
  });

  // Initial restore list render (after config is loaded)
  renderRestoreList();

  // Apply saved window behavior from settings (backup in case IPC push fires before init)
  applyWindowBehavior({
    hideHeader:  !!state.settings.hideHeader,
    alwaysOnTop: !!state.settings.alwaysOnTop,
  });

  setupLogsModalListeners();
  setupTouchListeners();
}

// ─── Quick Logs Modal ──────────────────────────────────────────────────────
async function openLogsModal() {
  const modal = document.getElementById('logs-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  refreshQuickLogs();
}

function closeLogsModal() {
  document.getElementById('logs-modal')?.classList.add('hidden');
}

async function refreshQuickLogs() {
  const viewer = document.getElementById('quick-logs-viewer');
  if (!viewer) return;
  viewer.textContent = 'Streaming logs…';
  const logs = await window.commandDeck.readLogs();
  viewer.textContent = logs || 'No log history available.';
  viewer.scrollTop = viewer.scrollHeight;
}

function setupLogsModalListeners() {
  document.getElementById('btn-logs-modal-refresh')?.addEventListener('click', () => refreshQuickLogs());
  document.getElementById('btn-logs-modal-folder')?.addEventListener('click', () => window.commandDeck.openLogFolder());
  document.getElementById('btn-logs-modal-close')?.addEventListener('click', () => closeLogsModal());
  document.getElementById('logs-modal-backdrop')?.addEventListener('click', () => closeLogsModal());
}


// ─── Touch Fix Utility ──────────────────────────────────────────────────────
function openTouchModal() {
  document.getElementById('touch-modal')?.classList.remove('hidden');
}

function closeTouchModal() {
  document.getElementById('touch-modal')?.classList.add('hidden');
}

function setupTouchListeners() {
  document.getElementById('btn-touch-fix')?.addEventListener('click', openTouchModal);
  document.getElementById('btn-touch-modal-close')?.addEventListener('click', closeTouchModal);
  document.getElementById('touch-modal-backdrop')?.addEventListener('click', closeTouchModal);

  document.getElementById('btn-touch-copy')?.addEventListener('click', async () => {
    const cmd = "C:\\Windows\\System32\\multidigimon.exe -touch";
    try {
      await navigator.clipboard.writeText(cmd);
      showToast('Command copied to clipboard', 'success', 1500);
      setTimeout(closeTouchModal, 400); // Small delay for visual feedback
    } catch (err) {
      showToast('Failed to copy command', 'error');
      console.error('Copy error:', err);
    }
  });

  // Also close on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('touch-modal')?.classList.contains('hidden')) {
      closeTouchModal();
    }
  });
}

init();
