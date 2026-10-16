# Serien Music Player

An elegant, feature-rich desktop music player built with **Electron**, **Node.js**, and **HTML5/CSS3**, tailored for Linux desktop environments with multi-drive support.

---

## ✨ Features

- **Multi-Format Audio Engine**: High-fidelity local playback powered by [Howler.js](https://howlerjs.com) supporting `.mp3`, `.flac`, `.wav`, `.m4a`, `.ogg`, and `.aac`.
- **🕉️ Indic Script Transliteration**: Powered by `@indic-transliteration/sanscript`. Search across 8 Indian scripts (*Devanagari, Malayalam, Tamil, Telugu, Bengali, Gujarati, Gurmukhi, Kannada*) phonetically using standard Latin/English keystrokes.
- **🎛️ 5-Band Graphic Equalizer**: Web Audio API BiquadFilter equalizer (80 Hz, 250 Hz, 1 kHz, 4 kHz, 10 kHz) with gain preamp, peak limiter, and 8 built-in sound presets (*Bass boost, Treble boost, Vocal, Rock, Pop, Classical, Loudness, Flat*).
- **📊 Real-Time Audio Visualizer**: Spectrum frequency analyzer with 3 distinct visualization modes: **Bars**, **Waveform**, and **Radial Ring**.
- **🪟 Floating Mini-Player**: Switch instantly into a compact, always-on-top floating mini-player mode.
- **🐧 Linux Desktop & Media Keys Integration**: Seamless MPRIS lock screen and sound menu integration, along with native hardware media key handling.
- **🔍 Duplicate Track Finder**: Detect and manage duplicate songs across multiple folders using cryptographic audio hashing and metadata comparison.
- **💾 Backup & Restore**: One-click JSON export/import of all your playlists, favorites, categories, and player preferences.
- **📜 Lyrics Panel**: Collapsible lyrics viewer and editor with local caching.
- **🔀 Queue & History**: Persistent play queue, recent track history, play count tracking, and smooth audio cross-fading.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| **Space** | Play / Pause |
| **Ctrl + B** | Toggle Sidebar |
| **Ctrl + L** | Toggle Lyrics Panel |
| **Ctrl + Shift + M** | Toggle Floating Mini-Player |
| **V** | Cycle Visualizer Mode (*Off → Bars → Wave → Ring*) |
| **E** | Open Equalizer |

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm`

### Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:aditya-kumar-k/serien-music-player.git
   cd serien-music-player
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Launch the player:
   ```bash
   npm start
   ```
   Or execute directly using the launcher script:
   ```bash
   ./launch.sh
   ```

---

## 🖥️ Linux Desktop Integration

To add Serien Music Player to your application launcher (GNOME, KDE Plasma, etc.):

1. Edit `music-player.desktop` and ensure the paths to `launch.sh` and `icon.png` point to your installation directory.
2. Copy the desktop entry to your local applications directory:
   ```bash
   cp music-player.desktop ~/.local/share/applications/
   ```

---

## 📁 Project Structure

```text
├── main.js              # Electron main process (IPC, mini-player, drive scanner)
├── renderer.js          # Core playback logic, library & playlist management
├── index.html           # Main player interface & layout
├── styles.css           # Modern dark styling, animations, and responsive layout
├── eq.js                # 5-Band Web Audio API equalizer & limiter
├── visualizer.js        # Canvas-based spectrum & waveform visualizers
├── extras.js            # Queue, history, toast notifications, cross-fades
├── library-tools.js     # Duplicate finder and backup & restore manager
├── translit.js          # Indic language transliteration engine
├── launch.sh            # Shell launcher resolving Electron runtime
├── music-player.desktop # Linux desktop application entry
├── icon.png / icon.svg  # Application branding icons
└── package.json         # Dependencies and metadata
```

---

## 📄 License

ISC License.
