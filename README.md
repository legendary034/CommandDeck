# ⬡ CommandDeck

> A tile-based hotkey dashboard for Windows 11 — launch apps, monitor live system stats, control media, and display real-time information from a single customizable interface.  Free Open Source software to be utilized with cheap 7 inch screens like https://a.co/d/05MqhGJp.

![CommandDeck](https://img.shields.io/badge/platform-Windows%2011-0078D4?style=flat-square&logo=windows)
![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## ✨ Features

| Feature | Details |
|---|---|
| 🕐 **Live Clock** | Realtime digital clock with date display |
| 🌤 **Weather Tile** | Current temp & conditions via [Open-Meteo](https://open-meteo.com/) (no API key required) |
| 📊 **System Stats** | CPU load, CPU temp, CPU clock speed, GPU temp, RAM usage — polled every 2 seconds |
| 🎵 **Media Controls** | Play/Pause, Next, Previous, Mute via Windows media keys (user32 P/Invoke) |
| 🚀 **App Launcher** | Launch any `.exe` or run any shell command from a click |
| 🎨 **Fully Editable** | Right-click any tile to edit label, icon, color, command, or size |
| 🔍 **Search** | Filter tiles in real-time by name or type |
| 💾 **Persistent Config** | All tile settings saved to `config/tiles.json` |
| 📐 **Responsive Grid** | Fluid 5-column grid that reflows from compact to wide-screen |

---

## 🖥 Screenshot

```
┌─────────────────────────────────────────────────────────────┐
│ ⬡ COMMANDDECK                            [─] [□] [✕]       │
├──────┬──────────────────────────────────────────────────────┤
│  ⁙   │  [ Search tiles...                    ]   USER       │
│  ⌥   ├──────────────────────────────────────────────────────┤
│  ♫   │                                                      │
│  ⬡   │  [ 15:26          ] [🔇] [ Los Angeles  64°F  ]     │
│  ◈   │  [ Wed Apr 15 2026 ]     [ CLEAR              ]     │
│      │                                                      │
│  +   │  [ ⏮ ] [ ▶ ] [ ⏭ ] [ CPU CLOCK ] [ CPU USAGE ]   │
│  ⚙   │                        [ 3800 MHZ ] [   61 %  ]   │
│      │                                                      │
└──────┴──────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Windows 10 / 11

### Install & Run

```bash
git clone https://github.com/legendary034/CommandDeck.git
cd CommandDeck
npm install
npm run dev
```

### Build Installer

```bash
npm run build
# Output: dist/CommandDeck Setup x.x.x.exe
```

---

## 🧩 Tile Types

### 🕐 Clock
Displays the current time (HH:MM) and date. Updates every second using the system clock.

### 🌤 Weather
Fetches live weather from [Open-Meteo](https://open-meteo.com/) — no API key needed.  
On first launch, click the tile and enter your city name to configure.

### 📊 Stat
Displays a live system metric. Available stats:

| `stat` key | Description |
|---|---|
| `cpuLoad` | CPU utilization % (with sparkline graph) |
| `cpuTemp` | CPU package temperature (°C) |
| `cpuSpeed` | CPU clock speed (MHz) |
| `memUsed` | RAM usage % |
| `gpuTemp` | GPU temperature (°C) |
| `cpuPower` | CPU power draw (W) |
| `memClock` | Memory clock speed (MHz) |

Values turn **yellow** at warning thresholds and **red** (pulsing) at critical thresholds.

### 🎵 Media
Sends a Windows media key via `user32.dll`. Available actions:

| `action` | Function |
|---|---|
| `play-pause` | Toggle play/pause |
| `next` | Next track |
| `prev` | Previous track |
| `mute` | Toggle mute |
| `vol-up` / `vol-down` | Volume control |

### 🚀 Action
Launches an application or runs a shell command.

- Set `path` to an `.exe` path for direct launch (e.g. `C:\Program Files\...`)  
- Set `command` for any PowerShell / CMD command  
- Clicking a tile with no path/command configured opens the editor automatically

---

## ⚙ Configuration

All tile configuration is stored in `config/tiles.json`. You can edit it directly or use the in-app editor (right-click any tile → **Edit Tile**).

### Tile Schema

```json
{
  "id": "my-tile",
  "type": "action",
  "size": "small",
  "color": "#1539a8",
  "label": "NOTEPAD",
  "icon": "edit",
  "path": "notepad.exe"
}
```

| Field | Values | Description |
|---|---|---|
| `type` | `action` `media` `stat` `clock` `weather` | Tile behaviour |
| `size` | `small` `wide` `tall` `large` | Grid span |
| `color` | Any hex color | Background color |
| `icon` | See icon list below | SVG icon name |
| `path` | File path string | App to launch |
| `command` | PowerShell/CMD string | Shell command to run |
| `stat` | See stat keys above | Live metric to display |
| `action` | See media actions above | Media key to send |

### Available Icons

`volume-x` · `volume-2` · `skip-back` · `skip-forward` · `play` · `pause` · `gamepad` · `music` · `flame` · `radio` · `layers` · `folder-open` · `settings` · `terminal` · `cpu` · `moon` · `sun` · `cloud` · `cloud-rain` · `cloud-snow` · `zap` · `edit` · `trash` · `search` · `menu` · `plus` · `x` · `check`

---

## 🗂 Project Structure

```
CommandDeck/
├── electron.cjs          # Main process — window, IPC, stats polling, media keys
├── preload.cjs           # contextBridge API (secure renderer ↔ main)
├── index.html            # App shell — titlebar, sidebar, header, tile canvas
├── src/
│   ├── app.js            # Renderer — tile engine, stats, weather, edit modal
│   ├── style.css         # CRT/neon design system
│   └── icons.js          # SVG icon library (25+ icons)
├── config/
│   └── tiles.json        # Tile layout config (user-editable)
└── package.json
```

---

## 🛠 Tech Stack

- **[Electron 33](https://electronjs.org/)** — Chromium + Node.js desktop shell
- **[systeminformation](https://systeminformation.io/)** — Cross-platform system metrics
- **[Open-Meteo API](https://open-meteo.com/)** — Free weather, no API key
- **[Orbitron](https://fonts.google.com/specimen/Orbitron)** + **[Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono)** — Google Fonts
- Vanilla HTML / CSS / ES Modules (no frontend framework)

---

## 📄 License

MIT © 2024 CommandDeck Contributors
