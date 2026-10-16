const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs   = require('fs');
const path = require('path');

app.setName('Serien Music Player');

// chrome-sandbox can't be setuid on an NTFS mount (and Ubuntu 24.04-based distros restrict user namespaces)
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// Lets the OS drive playback: media keys, and the sound menu / lock screen via MPRIS (Linux)
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');

function createWindow() {
  const win = new BrowserWindow({
    title: 'Serien Music Player',
    width: 1200,
    height: 800,
    autoHideMenuBar: true,   // menu bar hidden; press Alt to show it
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0a0a0c',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('index.html');

  // ── Mini player: shrink to a small always-on-top window and back ──
  let normalState = null;
  ipcMain.handle('set-mini', (event, on) => {
    if (on && !normalState) {
      normalState = { bounds: win.getBounds(), maximized: win.isMaximized(), minSize: win.getMinimumSize() };
      if (normalState.maximized) win.unmaximize();
      win.setMinimumSize(300, 150);
      win.setContentSize(380, 210);
      win.setAlwaysOnTop(true, 'floating');
    } else if (!on && normalState) {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(...normalState.minSize);
      win.setBounds(normalState.bounds);
      if (normalState.maximized) win.maximize();
      normalState = null;
    }
    return !!normalState;
  });

  // ── Save / open a file (backup export & import) ──
  ipcMain.handle('save-file-dialog', async (event, { name, filters }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('open-file-dialog', async (event, { filters }) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('set-fullscreen', (event, on) => { win.setFullScreen(!!on); });

  // ── Folder picker dialog ─────────────────────────────────────
  ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── List available drive letters (Windows) ───────────────────
  ipcMain.handle('list-drives', async () => {
    if (process.platform !== 'win32') {
      // On macOS/Linux return /Volumes or /mnt entries
      try {
        const base = process.platform === 'darwin' ? '/Volumes' : '/mnt';
        const entries = fs.readdirSync(base).map(d => path.join(base, d));
        return ['/'].concat(entries);
      } catch { return ['/']; }
    }
    // Windows: probe A–Z
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      try { fs.accessSync(drive); drives.push(drive); } catch {}
    }
    return drives;
  });

  // ── Recursively scan a drive for audio folders ───────────────
  ipcMain.handle('scan-drive', async (event, root) => {
    const AUDIO = /\.(mp3|wav|m4a|flac|ogg|aac)$/i;
    const foldersWithAudio = [];
    const MAX_DEPTH = 8; // don't go too deep

    function walk(dir, depth) {
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; } // permission denied etc.

      const hasAudio = entries.some(e => e.isFile() && AUDIO.test(e.name));
      if (hasAudio) foldersWithAudio.push(dir);

      for (const e of entries) {
        if (e.isDirectory()) {
          // Skip system/hidden folders on Windows
          const skip = /^(Windows|System32|Program Files|ProgramData|\$Recycle\.Bin|Recovery|Config\.Msi)$/i;
          if (skip.test(e.name) || e.name.startsWith('.')) continue;
          walk(path.join(dir, e.name), depth + 1);
        }
      }
    }

    walk(root, 0);
    return foldersWithAudio;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});