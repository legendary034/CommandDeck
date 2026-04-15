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
};

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
function applyTileSizing() {
  const w = window.screen.width;
  const h = window.screen.height;
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
  if (!el) return;

  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const timeStr = `${hh}:${mm}`;
  const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

  if (el.textContent !== timeStr) el.textContent = timeStr;
  if (de) de.textContent = dateStr;
}

// ─── Stats update ─────────────────────────────────────────────────────────────
function applyStats(stats) {
  Object.assign(state.stats, stats);
  state.cpuHistory.push(stats.cpuLoad);
  if (state.cpuHistory.length > 20) state.cpuHistory.shift();

  // Update all stat tiles
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

function renderClockTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-clock');
  div.innerHTML = `
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
    <div class="tile-icon">${getIcon(tile.icon || 'play')}</div>`;
  return div;
}

function renderActionTile(tile) {
  const div = buildTileBase(tile);
  div.classList.add('tile-action');
  const label = tile.label ? `<div class="tile-label">${tile.label}</div>` : '';
  div.innerHTML = `
    ${label}
    <div class="tile-icon">${getIcon(tile.icon || 'zap')}</div>`;
  return div;
}

function renderTile(tile) {
  switch (tile.type) {
    case 'clock':   return renderClockTile(tile);
    case 'weather': return renderWeatherTile(tile);
    case 'stat':    return renderStatTile(tile);
    case 'media':   return renderMediaTile(tile);
    case 'action':
    default:        return renderActionTile(tile);
  }
}

// ─── Canvas Render ────────────────────────────────────────────────────────────
function renderCanvas() {
  const canvas = document.getElementById('tile-canvas');
  canvas.innerHTML = '';

  const query = state.searchQuery.toLowerCase();
  const cat   = state.activeCat;

  state.config.tiles.forEach((tile) => {
    // Category filter
    if (cat !== 'All' && tile.category && tile.category !== cat) return;
    // Search filter
    if (query && !`${tile.label}${tile.type}${tile.id}`.toLowerCase().includes(query)) return;

    const el = renderTile(tile);
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
      state.activeCat = cat;
      renderSidebar();
      renderCanvas();
    });
    nav.appendChild(btn);
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
document.getElementById('search-input').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderCanvas();
});

// ─── Tile Click Handler ───────────────────────────────────────────────────────
async function handleTileClick(e, tile) {
  e.stopPropagation();
  hideContextMenu();

  switch (tile.type) {
    case 'media':
      await window.commandDeck.sendMediaKey(tile.action);
      showToast(`Media: ${tile.action}`, 'success', 1200);
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

  const typeOpts = ['action','media','stat','clock','weather']
    .map(t => `<option value="${t}" ${t === tile.type ? 'selected' : ''}>${t}</option>`)
    .join('');

  const iconOpts = Object.keys(ICONS)
    .map(k => `<option value="${k}" ${k === (tile.icon||'') ? 'selected' : ''}>${k}</option>`)
    .join('');

  const colorSwatches = PRESET_COLORS
    .map(c => `<div class="color-swatch${c === tile.color ? ' active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></div>`)
    .join('');

  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Label</label>
      <input class="form-input" id="ef-label" value="${tile.label || ''}" placeholder="Tile label" />
    </div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <select class="form-select" id="ef-type">${typeOpts}</select>
    </div>
    <div class="form-group" id="ef-icon-group">
      <label class="form-label">Icon</label>
      <select class="form-select" id="ef-icon">${iconOpts}</select>
    </div>
    <div class="form-group" id="ef-cmd-group">
      <label class="form-label">Command / App Path</label>
      <input class="form-input" id="ef-command" value="${tile.command || tile.path || ''}" placeholder="e.g. notepad.exe or powershell -Command …" />
    </div>
    <div class="form-group">
      <label class="form-label">Size</label>
      <select class="form-select" id="ef-size">
        ${['small','wide','tall','large'].map(s => `<option value="${s}" ${s === (tile.size||'small') ? 'selected':''}>${s}</option>`).join('')}
      </select>
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

  modal.classList.remove('hidden');

  // Save
  document.getElementById('btn-modal-save').onclick = async () => {
    tile.label   = body.querySelector('#ef-label').value.trim();
    tile.type    = body.querySelector('#ef-type').value;
    tile.icon    = body.querySelector('#ef-icon').value;
    tile.command = body.querySelector('#ef-command').value.trim();
    tile.size    = body.querySelector('#ef-size').value;
    tile.color   = chosenColor;
    delete tile.path;
    if (tile.command && !tile.command.includes(' ') && tile.command.endsWith('.exe')) {
      tile.path = tile.command;
      delete tile.command;
    }
    await saveConfig();
    closeEditModal();
    renderCanvas();
    updateClock();
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

// ─── Add Tile Button ──────────────────────────────────────────────────────────
document.getElementById('btn-add-tile').addEventListener('click', openAddModal);

// ─── Settings Modal ─────────────────────────────────────────────────────────────
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  renderDisplayList();
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
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
        applyTileSizing();
        showToast(`Moved to ${label}`, 'success');
      } else {
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
  const [cfg, settings] = await Promise.all([
    window.commandDeck.readConfig(),
    window.commandDeck.readSettings(),
  ]);
  state.config   = cfg;
  state.settings = settings || {};

  // Load display list
  try {
    state.displays         = await window.commandDeck.getDisplays();
    state.activeDisplayIdx = typeof state.settings.preferredDisplay === 'number'
      ? state.settings.preferredDisplay
      : 0;
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
}

init();
