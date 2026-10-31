/**
 * Platform Adapter for Serein Music Player
 * Unifies Electron (Desktop Linux/Windows) and Capacitor (Android) / Web environments.
 */
(function() {
  const isElectron = typeof process !== 'undefined' && process.versions && !!process.versions.electron;
  const isCapacitor = typeof window !== 'undefined' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
  const isAndroid = isCapacitor || (/android/i.test(navigator.userAgent));

  window.isElectron = isElectron;
  window.isCapacitor = isCapacitor;
  window.isAndroid = isAndroid;

  // ─── PATH SHIM ──────────────────────────────────────────
  const pathShim = {
    basename: function(p, ext) {
      if (!p) return "";
      const segments = p.split(/[\\/]/).filter(Boolean);
      let base = segments[segments.length - 1] || "";
      if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
      return base;
    },
    dirname: function(p) {
      if (!p) return "";
      const segments = p.split(/[\\/]/).filter(Boolean);
      if (segments.length <= 1) return "";
      segments.pop();
      return (p.startsWith('/') ? '/' : '') + segments.join('/');
    },
    join: function(...parts) {
      return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    },
    extname: function(p) {
      if (!p) return "";
      const base = pathShim.basename(p);
      const idx = base.lastIndexOf('.');
      return idx > 0 ? base.slice(idx) : "";
    }
  };

  // ─── STORAGE & FS SHIM ──────────────────────────────────
  const storageCache = {};

  const FS_STORAGE_KEYS = {
    "favorites.json": "mp_favorites",
    "playlists.json": "mp_playlists",
    "lyrics.json": "mp_lyrics",
    "history.json": "mp_history",
    "folders.json": "mp_folders",
    "favorite-categories.json": "mp_fav_categories"
  };

  function getStorageKey(filePath) {
    const base = pathShim.basename(filePath);
    return FS_STORAGE_KEYS[base] || ("mp_file_" + base);
  }

  const fsShim = {
    readFileSync: function(filePath, encoding) {
      const key = getStorageKey(filePath);
      if (storageCache[key] !== undefined) return storageCache[key];
      const val = localStorage.getItem(key);
      if (val !== null) {
        storageCache[key] = val;
        return val;
      }
      // Defaults for known files
      if (key === "mp_folders") {
        if (window.AndroidBridge && window.AndroidBridge.foldersMap && window.AndroidBridge.foldersMap.size > 0) {
          return JSON.stringify(Array.from(window.AndroidBridge.foldersMap.keys()));
        }
        return JSON.stringify(["Music"]);
      }
      if (key === "mp_favorites" || key === "mp_playlists" || key === "mp_fav_categories") return "[]";
      if (key === "mp_lyrics") return "{}";
      if (key === "mp_history") return '{"recent":[],"counts":{}}';
      return "{}";
    },
    writeFileSync: function(filePath, data) {
      const key = getStorageKey(filePath);
      const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      storageCache[key] = str;
      try { localStorage.setItem(key, str); } catch (e) { console.warn("Storage write failed", e); }
    },
    existsSync: function(filePath) {
      if (!filePath) return false;
      const key = getStorageKey(filePath);
      if (localStorage.getItem(key) !== null) return true;
      if (window.AndroidBridge && window.AndroidBridge.hasFile(filePath)) return true;
      return true; // Keep tracks valid in library
    },
    readdirSync: function(dir) {
      if (window.AndroidBridge) {
        return window.AndroidBridge.readDir(dir);
      }
      return [];
    },
    statSync: function(filePath) {
      const isDir = window.AndroidBridge ? window.AndroidBridge.isDirectory(filePath) : false;
      return {
        isDirectory: () => isDir,
        isFile: () => !isDir
      };
    }
  };

  // ─── ELECTRON IPC SHIM ──────────────────────────────────
  const electronShim = {
    ipcRenderer: {
      invoke: async function(channel, ...args) {
        if (channel === 'open-folder-dialog') {
          return await window.AndroidBridge.pickFolderOrScan();
        }
        if (channel === 'scan-drive') {
          return await window.AndroidBridge.scanAudioFolders();
        }
        if (channel === 'list-drives') {
          return ['Device Storage'];
        }
        if (channel === 'set-mini') {
          const miniMode = !!args[0];
          document.body.classList.toggle('mini-mode', miniMode);
          return miniMode;
        }
        if (channel === 'set-fullscreen') {
          const on = !!args[0];
          if (on && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          }
          return;
        }
        if (channel === 'save-file-dialog') {
          return 'export';
        }
        if (channel === 'open-file-dialog') {
          return 'import';
        }
        return null;
      },
      on: function() {},
      removeListener: function() {}
    },
    shell: {
      showItemInFolder: function(path) {
        window.showScanToast("Song path: " + path);
      }
    }
  };

  // ─── ANDROID BRIDGE ─────────────────────────────────────
  const AndroidBridge = {
    allDeviceSongs: [],
    foldersMap: new Map(), // folderName -> [songObjects]

    init: async function() {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MediaStorePlugin) {
        this.plugin = window.Capacitor.Plugins.MediaStorePlugin;
        this.bindNativeMediaButtons();
        // Headphones/Bluetooth disconnected: pause instead of blasting out of the speaker
        try {
          this.plugin.addListener("audioBecomingNoisy", () => {
            if (typeof sound !== "undefined" && sound && sound.playing()) {
              sound.pause();
              if (typeof updatePlayButton === "function") updatePlayButton(false);
            }
          });
        } catch (e) {}
      }
      // Load cached songs
      try {
        const cached = localStorage.getItem("mp_device_songs");
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.setSongs(parsed);
          }
        }
      } catch (e) {}

      // Auto-scan on Android if no songs yet; otherwise quietly refresh the cached list
      if (isCapacitor && this.allDeviceSongs.length === 0) {
        setTimeout(() => { this.scanMediaStore(); }, 800);
      } else if (isCapacitor && this.plugin) {
        setTimeout(() => { this.refreshSongs(true); }, 1500);
      }
      // ...and again whenever the app comes back to the foreground
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && isCapacitor) this.refreshSongs();
      });
    },

    // Folders the user excluded in Manage (names, lower-case). WhatsApp is always excluded.
    getExcluded: function() {
      try { const a = JSON.parse(localStorage.getItem("mp_excluded_folders")); return Array.isArray(a) ? a : []; } catch (e) { return []; }
    },
    excludeFolder: function(name) {
      const list = this.getExcluded();
      const n = String(name).toLowerCase();
      if (!list.includes(n)) list.push(n);
      try { localStorage.setItem("mp_excluded_folders", JSON.stringify(list)); } catch (e) {}
    },
    includeFolder: function(name) {
      const n = String(name).toLowerCase();
      try { localStorage.setItem("mp_excluded_folders", JSON.stringify(this.getExcluded().filter(x => x !== n))); } catch (e) {}
      this.scanMediaStore();   // bring its songs back
    },
    folderNameOf: function(song) {
      let folder = song.folder || "Music";
      if (folder.includes("/")) folder = pathShim.basename(folder);
      if (!folder || folder === "0" || folder.toLowerCase() === "emulated") folder = "Music";
      return folder;
    },

    setSongs: function(songs) {
      const excluded = new Set(this.getExcluded());
      // WhatsApp and user-excluded folders are never part of the library (also drops them from older cached scans)
      let firstSeen = {};
      try { firstSeen = JSON.parse(localStorage.getItem("mp_first_seen")) || {}; } catch (e) {}
      let seenChanged = false;
      const nowSec = Math.floor(Date.now() / 1000);
      this.allDeviceSongs = (songs || []).filter(s =>
        !/whatsapp/i.test(String(s.path || "") + " " + String(s.folder || "")) &&
        !excluded.has(this.folderNameOf(s).toLowerCase()));
      // songs without a MediaStore date (picked by hand) are dated by when we first saw them
      this.allDeviceSongs.forEach(s => {
        if (s.dateAdded) return;
        const k = s.contentUri || s.path;
        if (!firstSeen[k]) { firstSeen[k] = nowSec; seenChanged = true; }
        s.dateAdded = firstSeen[k];
      });
      if (seenChanged) { try { localStorage.setItem("mp_first_seen", JSON.stringify(firstSeen)); } catch (e) {} }
      this.foldersMap.clear();
      this.allDeviceSongs.forEach(song => {
        const folder = this.folderNameOf(song);
        song.folder = folder;
        if (!this.foldersMap.has(folder)) this.foldersMap.set(folder, []);
        this.foldersMap.get(folder).push(song);
      });

      const folderNames = Array.from(this.foldersMap.keys());
      try {
        localStorage.setItem("mp_device_songs", JSON.stringify(this.allDeviceSongs));
        localStorage.setItem("mp_folders", JSON.stringify(folderNames.length > 0 ? folderNames : ["Music"]));
      } catch (e) {}

      if (typeof window.reloadLibrary === 'function') {
        window.reloadLibrary();
      }
    },

    // Quiet rescan of the phone's media library: drops songs whose files are gone, picks up new ones.
    // Songs added by hand (picked files / folders) are left alone. Only re-renders when something changed.
    refreshSongs: async function(force, manual) {
      if (!this.plugin || !this.plugin.scanAudioFiles) return;
      const now = Date.now();
      if (this._refreshing || (!force && now - (this._lastRefresh || 0) < 30000)) return;
      this._refreshing = true; this._lastRefresh = now;
      try {
        if (manual) showScanToast("Refreshing library…");
        const result = await this.plugin.scanAudioFiles();
        if (!result || !Array.isArray(result.songs)) { if (manual) showScanToast("Refresh failed"); return; }
        const isMedia = (s) => String(s.contentUri || s.path || "").startsWith("content://media/");
        const fresh = result.songs;
        if (fresh.length === 0 && this.allDeviceSongs.some(isMedia)) { if (manual) showScanToast("Refresh found no songs, kept your library"); return; }   // empty result = probably a hiccup
        const manualSongs = this.allDeviceSongs.filter(s => !isMedia(s));
        const key = (s) => s.contentUri || s.path;
        const before = new Set(this.allDeviceSongs.filter(isMedia).map(key));
        const after = new Set(fresh.map(key));
        const removed = [...before].filter(k => !after.has(k)).length;
        const added = [...after].filter(k => !before.has(k)).length;
        if (!removed && !added && !this._datesFixed) { this._datesFixed = true;  // once per launch: adopt the real MediaStore dates
          this.setSongs(fresh.concat(manualSongs)); if (manual) showScanToast("Library is up to date"); return; }
        if (!removed && !added) { if (manual) showScanToast("Library is up to date"); return; }
        this.setSongs(fresh.concat(manualSongs));
        if (manual || removed) {
          const bits = [];
          if (removed) bits.push(`removed ${removed} missing`);
          if (added) bits.push(`added ${added} new`);
          showScanToast(bits.join(", ").replace(/^./, c => c.toUpperCase()));
        }
      } catch (e) {
        console.warn("Library refresh failed:", e);
        if (manual) showScanToast("Refresh failed: " + (e.message || e));
      } finally {
        this._refreshing = false;
      }
    },

    scanMediaStore: async function() {
      if (this.plugin && this.plugin.scanAudioFiles) {
        try {
          showScanToast("Scanning device for music…");
          const result = await this.plugin.scanAudioFiles();
          if (result && result.songs && result.songs.length > 0) {
            this.setSongs(result.songs);
            showScanToast(`Discovered ${result.songs.length} tracks!`);
            return result.songs;
          } else {
            showScanToast("No audio tracks found via MediaStore.");
          }
        } catch (err) {
          console.error("MediaStore scan failed:", err);
          showScanToast("Permission or scan error: " + (err.message || err));
        }
      } else {
        // Fallback for browser testing
        return this.pickWebFolder();
      }
      return this.allDeviceSongs;
    },

    chooseFolder: async function() {
      if (isCapacitor && this.plugin && this.plugin.chooseFolder) {
        try {
          showScanToast("Opening folder picker…");
          const result = await this.plugin.chooseFolder();
          if (result && result.songs && result.songs.length > 0) {
            const currentMap = new Map();
            (this.allDeviceSongs || []).forEach(s => currentMap.set(s.path || s.id, s));
            result.songs.forEach(s => currentMap.set(s.path || s.id, s));
            const merged = Array.from(currentMap.values());
            this.setSongs(merged);
            showScanToast(`Added ${result.songs.length} tracks from ${result.folder || 'Folder'}!`);
            return result.folder;
          } else {
            showScanToast("No audio tracks found in selected folder.");
          }
        } catch (err) {
          if (!/cancelled/i.test(err.message || String(err))) {
            showScanToast("Folder selection: " + (err.message || err));
          }
        }
        return null;
      }
      return this.pickWebFolder();
    },

    chooseAudioFiles: async function() {
      if (isCapacitor && this.plugin && this.plugin.chooseAudioFiles) {
        try {
          showScanToast("Opening audio picker…");
          const result = await this.plugin.chooseAudioFiles();
          if (result && result.songs && result.songs.length > 0) {
            const currentMap = new Map();
            (this.allDeviceSongs || []).forEach(s => currentMap.set(s.path || s.id, s));
            result.songs.forEach(s => currentMap.set(s.path || s.id, s));
            const merged = Array.from(currentMap.values());
            this.setSongs(merged);
            showScanToast(`Added ${result.songs.length} audio tracks!`);
            return "Imported Music";
          } else {
            showScanToast("No audio tracks selected.");
          }
        } catch (err) {
          if (!/cancelled/i.test(err.message || String(err))) {
            showScanToast("File selection: " + (err.message || err));
          }
        }
        return null;
      }
      return this.pickWebAudioFiles();
    },

    pickFolderOrScan: function() {
      return new Promise((resolve) => {
        const existing = document.getElementById("addMusicModal");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.id = "addMusicModal";
        overlay.style.cssText = `
          position: fixed; inset: 0; background: rgba(0,0,0,0.72);
          display: flex; align-items: center; justify-content: center; z-index: 10000;
          padding: 20px; backdrop-filter: blur(8px);
        `;

        const card = document.createElement("div");
        card.style.cssText = `
          background: #191924; border: 1px solid rgba(255,255,255,0.12); border-radius: 16px;
          padding: 22px; width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px;
          box-shadow: 0 16px 48px rgba(0,0,0,0.7); color: #fff;
        `;

        card.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-size:16px; font-weight:600; color:#fff;">Add Music to Library</div>
            <button id="closeAddMusic" style="background:none; border:none; color:#888; font-size:18px; cursor:pointer; padding:4px;">✕</button>
          </div>
          <div style="font-size:12.5px; color:#9a9ab0; line-height:1.45;">
            Choose how you want to add tracks to your music player:
          </div>
          <div style="display:flex; flex-direction:column; gap:10px; margin-top:4px;">
            <button id="optChooseFolder" style="display:flex; align-items:center; gap:12px; padding:12px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:#fff; cursor:pointer; text-align:left;">
              <span style="font-size:22px;">📁</span>
              <div>
                <div style="font-size:13px; font-weight:600;">Choose Music Folder</div>
                <div style="font-size:11px; color:#8a8a9e;">Pick a folder on storage (e.g. Music, SD Card)</div>
              </div>
            </button>
            <button id="optChooseFiles" style="display:flex; align-items:center; gap:12px; padding:12px 14px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:#fff; cursor:pointer; text-align:left;">
              <span style="font-size:22px;">🎵</span>
              <div>
                <div style="font-size:13px; font-weight:600;">Select Audio Files</div>
                <div style="font-size:11px; color:#8a8a9e;">Choose specific audio tracks manually</div>
              </div>
            </button>
            <button id="optScanDevice" style="display:flex; align-items:center; gap:12px; padding:12px 14px; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.3); border-radius:10px; color:#c7d2fe; cursor:pointer; text-align:left;">
              <span style="font-size:22px;">🔍</span>
              <div>
                <div style="font-size:13px; font-weight:600;">Scan Entire Device</div>
                <div style="font-size:11px; color:#a5b4fc;">Auto-detect all audio tracks across storage</div>
              </div>
            </button>
          </div>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const close = () => {
          overlay.remove();
          resolve(null);
        };

        card.querySelector("#closeAddMusic").onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        card.querySelector("#optChooseFolder").onclick = async () => {
          overlay.remove();
          const res = await AndroidBridge.chooseFolder();
          resolve(res);
        };

        card.querySelector("#optChooseFiles").onclick = async () => {
          overlay.remove();
          const res = await AndroidBridge.chooseAudioFiles();
          resolve(res);
        };

        card.querySelector("#optScanDevice").onclick = async () => {
          overlay.remove();
          const res = await AndroidBridge.scanMediaStore();
          resolve(res);
        };
      });
    },

    pickWebFolder: function() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.webkitdirectory = true;
        input.accept = "audio/*";
        input.onchange = (e) => {
          const files = Array.from(e.target.files);
          if (files.length === 0) return resolve(null);
          const newSongs = files.filter(f => /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(f.name)).map(f => {
            const blobUrl = URL.createObjectURL(f);
            const folder = f.webkitRelativePath ? pathShim.dirname(f.webkitRelativePath) : "Imported Music";
            return {
              id: "file_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6),
              name: f.name,
              title: f.name.replace(/\.[^/.]+$/, ""),
              artist: "",
              album: folder,
              path: blobUrl,
              folder: folder,
              fileObj: f
            };
          });
          const combined = (AndroidBridge.allDeviceSongs || []).concat(newSongs);
          AndroidBridge.setSongs(combined);
          showScanToast(`Added ${newSongs.length} songs!`);
          resolve("Imported Music");
        };
        input.click();
      });
    },

    pickWebAudioFiles: function() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "audio/*";
        input.onchange = (e) => {
          const files = Array.from(e.target.files);
          if (files.length === 0) return resolve(null);
          const newSongs = files.filter(f => /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(f.name)).map(f => {
            const blobUrl = URL.createObjectURL(f);
            return {
              id: "file_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6),
              name: f.name,
              title: f.name.replace(/\.[^/.]+$/, ""),
              artist: "",
              album: "Imported Files",
              path: blobUrl,
              folder: "Imported Files",
              fileObj: f
            };
          });
          const combined = (AndroidBridge.allDeviceSongs || []).concat(newSongs);
          AndroidBridge.setSongs(combined);
          showScanToast(`Added ${newSongs.length} tracks!`);
          resolve("Imported Files");
        };
        input.click();
      });
    },

    scanAudioFolders: async function() {
      const folders = Array.from(this.foldersMap.keys());
      return folders.length > 0 ? folders : ["Device Music"];
    },

    readDir: function(dir) {
      if (this.foldersMap.has(dir)) {
        return this.foldersMap.get(dir).map(s => s.name);
      }
      return [];
    },

    isDirectory: function(p) {
      return this.foldersMap.has(p);
    },

    hasFile: function(p) {
      if (!p) return false;
      if (p.startsWith('blob:') || p.startsWith('http:') || p.startsWith('https:')) return true;
      return this.allDeviceSongs.some(s => s.path === p);
    },

    // Album art as a data URL (WebView can't load content:// URIs); cached per track + size
    artCache: new Map(),
    getArt: function(song, size) {
      const uri = song && (song.contentUri || song.path);
      if (!uri || !this.plugin || !this.plugin.getAlbumArt) return Promise.resolve(null);
      const key = uri + "@" + size;
      if (!this.artCache.has(key)) {
        this.artCache.set(key, this.plugin.getAlbumArt({ uri, size })
          .then(r => (r && r.data) || null)
          .catch(() => null));
      }
      return this.artCache.get(key);
    },

    // ── Notification / lock-screen controls (native MediaSession + foreground service) ──
    pushNativeMedia: function(playingOverride) {
      if (!this.plugin || !this.plugin.updateMedia) return;
      if (typeof currentSongPath === "undefined" || !currentSongPath) return;
      const s = (typeof sound !== "undefined") ? sound : null;
      const playing = playingOverride !== undefined ? !!playingOverride : !!(s && s.playing());
      let pos = 0, dur = 0;
      try { pos = s ? Number(s.seek()) || 0 : 0; dur = s ? Number(s.duration()) || 0 : 0; } catch (e) {}
      const meta = (typeof currentMeta !== "undefined" && currentMeta) || {};
      const state = {
        title: (typeof currentTitle !== "undefined" && currentTitle) || "Playing",
        artist: meta.artist || "", album: meta.album || "",
        playing, position: pos, duration: dur, uri: currentSongPath
      };
      // Android 13+ asks once for permission to show notifications; send the state after the answer
      if (!this._notifReady) {
        this._notifReady = this.plugin.ensureNotificationPermission ? this.plugin.ensureNotificationPermission().catch(() => {}) : Promise.resolve();
      }
      this._notifReady.then(() => this.plugin.updateMedia(state)).catch(() => {});
    },

    startBackgroundAudio: function() { this.pushNativeMedia(true); },

    // A song change stops the old sound a moment before the new one starts: only report "stopped" if it stays stopped
    stopBackgroundAudio: function() {
      clearTimeout(this._stopTimer);
      this._stopTimer = setTimeout(() => {
        const s = (typeof sound !== "undefined") ? sound : null;
        if (!s || !s.playing()) this.pushNativeMedia(false);
      }, 400);
    },

    bindNativeMediaButtons: function() {
      if (!this.plugin || !this.plugin.addListener) return;
      this.plugin.addListener("mediaAction", (ev) => {
        const s = (typeof sound !== "undefined") ? sound : null;
        switch (ev && ev.action) {
          case "play":  if (!s || !s.playing()) togglePlay(); break;
          case "pause": if (s && s.playing()) togglePlay(); break;
          case "next":  next(); break;
          case "prev":  prev(); break;
          case "stop":  stop(); break;
          case "seek": {
            // lock-screen scrubbing sends many positions: apply only the last one, straight on the audio
            // element (Howler's seek() pauses and restarts playback, which races when called repeatedly)
            clearTimeout(this._seekTimer);
            this._seekTimer = setTimeout(() => {
              const cur = (typeof sound !== "undefined") ? sound : null;
              if (!cur) return;
              const t = (ev.position || 0) / 1000;
              const node = cur._sounds && cur._sounds[0] && cur._sounds[0]._node;
              if (node && !cur._webAudio && isFinite(t)) { node.currentTime = t; this.pushNativeMedia(); }
              else cur.seek(t);
            }, 120);
            break;
          }
        }
      });
    }
  };

  window.AndroidBridge = AndroidBridge;
  window.pathShim = pathShim;
  window.fsShim = fsShim;
  window.electronShim = electronShim;

  // Convert file path to playable URL (Capacitor convertFileSrc for Android local file paths)
  window.getPlayableAudioSrc = function(filePath) {
    if (!filePath) return "";
    if (filePath.startsWith("blob:") || filePath.startsWith("data:") || filePath.startsWith("http:") || filePath.startsWith("https:")) {
      return filePath;
    }
    if (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
      return window.Capacitor.convertFileSrc(filePath);
    }
    return filePath;
  };

  // Provide global require shim if require is not defined (Android / browser)
  if (typeof window.require === 'undefined') {
    window.require = function(moduleName) {
      if (moduleName === 'fs') return fsShim;
      if (moduleName === 'path') return pathShim;
      if (moduleName === 'electron') return electronShim;
      if (moduleName === '@indic-transliteration/sanscript') return window.Sanscript || {};
      if (moduleName === './translit' || moduleName === 'translit') return window.Translit || {};
      if (moduleName === 'music-metadata') return window.mmShim || {};
      if (moduleName === 'crypto') return {
        createHash: () => ({
          update: () => {},
          digest: () => "hash_" + Math.random().toString(36).substr(2, 8)
        })
      };
      console.warn("require shim called for unknown module:", moduleName);
      return {};
    };
  }

  // Toast feedback
  function showScanToast(msg) {
    let t = document.getElementById("scanToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "scanToast";
      t.style.cssText = `
        position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%);
        background: #1e1e2aec; color: #ececf1; padding: 10px 20px; border-radius: 24px;
        font-size: 13px; font-weight: 500; z-index: 99999; border: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 8px 32px rgba(0,0,0,0.6); backdrop-filter: blur(12px);
        transition: opacity 0.3s ease, transform 0.3s ease; pointer-events: none;
        max-width: 90vw; text-align: center;
      `;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    t.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.style.opacity = "0";
      t.style.transform = "translateX(-50%) translateY(10px)";
    }, 3200);
  }
  window.showScanToast = showScanToast;

  document.addEventListener("DOMContentLoaded", () => {
    AndroidBridge.init();
  });

})();
