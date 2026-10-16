const fs   = require('fs');
const path = require('path');
const { romanize, hasIndic } = require('./translit');

const ICON_PLAY  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
const ICON_VOL   = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
const ICON_MUTE  = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

// Only strip real audio extensions, so names like "Alone_ Pt. II - Alan Walker" stay intact
const stripExt = n => n.replace(/\.(mp3|wav|m4a|flac|ogg|aac)$/i, "");

let songs = [];
let currentIndex = 0;
let sound = null;

let loopA = null;
let loopB = null;
let currentTitle    = "";
let currentSongPath = "";

let repeatMode = "all";
let isMuted    = false;
let lastVolume = 80;

const lyricsFile    = path.join(__dirname, "lyrics.json");
const favoritesFile = path.join(__dirname, "favorites.json");
const playlistsFile = path.join(__dirname, "playlists.json");
const FOLDERS_FILE  = path.join(__dirname, "folders.json");

// ── SLEEP TIMER ──────────────────────────────────────────────
let sleepTimerTimeout  = null;  // the setTimeout handle
let sleepTimerEnd      = null;  // Date.ms when it fires
let sleepTimerInterval = null;  // countdown display interval

function showSleepTimer() {
  const existing = document.getElementById("pl-prompt");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;
  `;

  const box = document.createElement("div");
  box.style.cssText = `
    background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 280px; display: flex; flex-direction: column; gap: 14px;
  `;

  const title = document.createElement("div");
  title.textContent = "⏱ Sleep Timer";
  title.style.cssText = "font-size: 13px; font-weight: 600; color: #e8e8f0;";

  // Preset buttons
  const presets = [5, 10, 15, 20, 30, 45, 60, 90];
  const presetWrap = document.createElement("div");
  presetWrap.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";

  presets.forEach(mins => {
    const btn = document.createElement("button");
    btn.textContent = mins < 60 ? `${mins}m` : `${mins / 60}h`;
    btn.style.cssText = `
      flex: 1; min-width: 48px; background: var(--surface2, #1a1a24);
      color: var(--accent2); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-radius: 8px; padding: 7px 4px; font-family: inherit;
      font-size: 12px; cursor: pointer; transition: all 0.15s;
    `;
    btn.onmouseenter = () => btn.style.background = "color-mix(in srgb, var(--accent) 20%, transparent)";
    btn.onmouseleave = () => btn.style.background = "var(--surface2, #1a1a24)";
    btn.onclick = () => { overlay.remove(); startSleepTimer(mins * 60); };
    presetWrap.appendChild(btn);
  });

  // Custom input
  const customRow = document.createElement("div");
  customRow.style.cssText = "display: flex; gap: 8px; align-items: center;";

  const customInput = document.createElement("input");
  customInput.type        = "number";
  customInput.placeholder = "Custom (min)";
  customInput.min         = "1";
  customInput.max         = "300";
  customInput.style.cssText = `
    flex: 1; background: #0c0c10; border: 1px solid #ffffff0f; border-radius: 7px;
    padding: 7px 10px; color: #e8e8f0; font-size: 12px; font-family: inherit; outline: none;
  `;

  const setBtn = document.createElement("button");
  setBtn.textContent = "Set";
  setBtn.style.cssText = `
    background: var(--accent); color: white; border: none; border-radius: 7px;
    padding: 7px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
  `;
  setBtn.onclick = () => {
    const val = parseInt(customInput.value);
    if (!val || val < 1) return;
    overlay.remove();
    startSleepTimer(val * 60);
  };
  customInput.addEventListener("keydown", e => { if (e.key === "Enter") setBtn.click(); });

  customRow.append(customInput, setBtn);

  // Cancel button (only shown if timer is active)
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid #ffffff0f; padding-top: 10px;";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = `
    background: transparent; color: #6b6b80; border: 1px solid #ffffff0f;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit; font-size: 12px;
  `;
  closeBtn.onclick = () => overlay.remove();

  if (sleepTimerTimeout) {
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel Timer";
    cancelBtn.style.cssText = `
      background: rgba(255,92,138,0.1); color: #ff5c8a; border: 1px solid rgba(255,92,138,0.3);
      border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit; font-size: 12px;
    `;
    cancelBtn.onclick = () => { overlay.remove(); cancelSleepTimer(); };
    btnRow.append(cancelBtn, closeBtn);
  } else {
    btnRow.appendChild(closeBtn);
  }

  box.append(title, presetWrap, customRow, btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => customInput.focus(), 0);
}

function startSleepTimer(seconds) {
  cancelSleepTimer(); // clear any existing

  sleepTimerEnd = Date.now() + seconds * 1000;

  sleepTimerTimeout = setTimeout(() => {
    fadeOutAndStop();
    cancelSleepTimer();
    updateSleepTimerBtn();
  }, seconds * 1000);

  // Update the button countdown every second
  sleepTimerInterval = setInterval(updateSleepTimerBtn, 1000);
  updateSleepTimerBtn();
}

function cancelSleepTimer() {
  if (sleepTimerTimeout)  clearTimeout(sleepTimerTimeout);
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  sleepTimerTimeout  = null;
  sleepTimerEnd      = null;
  sleepTimerInterval = null;
  updateSleepTimerBtn();
}

function updateSleepTimerBtn() {
  const btn = document.getElementById("sleepTimerBtn");
  if (!btn) return;
  if (sleepTimerEnd) {
    const remaining = Math.max(0, Math.ceil((sleepTimerEnd - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    btn.textContent = `${m}:${s < 10 ? "0" + s : s}`;
    btn.classList.add("active");
  } else {
    btn.textContent = "Sleep";
    btn.classList.remove("active");
  }
}

// ── FAVORITES ────────────────────────────────────────────────
function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(favoritesFile)); }
  catch { return []; }
}
function saveFavorites(favs) {
  fs.writeFileSync(favoritesFile, JSON.stringify(favs, null, 2));
}

// ── PLAYLISTS ────────────────────────────────────────────────
function loadPlaylists() {
  try { return JSON.parse(fs.readFileSync(playlistsFile)); }
  catch { return []; }
}
function savePlaylists(lists) {
  fs.writeFileSync(playlistsFile, JSON.stringify(lists, null, 2));
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── PLAYLIST PLAYBACK STATE ──────────────────────────────────
let playlistMode      = false;
let activePlaylistId  = null;
let activePlaylistIdx = 0;

// ── LIBRARY TREE ────────────────────────────────────────────
let libraryTree     = {};
let currentElement  = null;
let allSongElements = [];

// ── SONG DURATION CACHE ──────────────────────────────────────
// We read duration async using a hidden Audio element — fast and non-blocking
const durationCache = {};

function getSongDuration(filePath, callback) {
  if (durationCache[filePath] !== undefined) {
    callback(durationCache[filePath]);
    return;
  }
  const audio = new Audio();
  audio.src = filePath;
  audio.addEventListener("loadedmetadata", () => {
    durationCache[filePath] = audio.duration;
    callback(audio.duration);
    audio.src = ""; // free memory
  });
  audio.addEventListener("error", () => {
    durationCache[filePath] = null;
    callback(null);
  });
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" + s : s);
}

function buildTree(folder) {
  function scan(dir) {
    const name = path.basename(dir);
    const node = { name, type: "folder", children: [] };
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        node.children.push(scan(full));
      } else if (/\.(mp3|wav|m4a|flac)$/i.test(file)) {
        node.children.push({ name: file, path: full, type: "file" });
      }
    });
    return node;
  }
  const tree = scan(folder);
  renderTreeWithRoot(tree, null, true, folder);
}

function renderTreeWithRoot(node, parent = null, appendMode = false, rootFolder = null) {
  const container = parent || document.getElementById("songList");
  if (!parent && !appendMode) { container.innerHTML = ""; allSongElements = []; }

  const li = document.createElement("li");

  if (node.type === "folder") {
    li.textContent = node.name;
    li.classList.add("folder-item");
    const ul = document.createElement("ul");
    ul.classList.add("sub-list");
    ul.style.display = "none";
    li.onclick = (e) => {
      e.stopPropagation();
      const open = ul.style.display !== "none";
      ul.style.display = open ? "none" : "block";
      li.classList.toggle("open", !open);
    };
    // Right-click to remove — only on root-level folders
    if (!parent && rootFolder) {
      li.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const old = document.getElementById("folder-ctx-menu");
        if (old) old.remove();
        const menu = document.createElement("div");
        menu.id = "folder-ctx-menu";
        menu.style.cssText = `
          position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
          background: #1a1a24; border: 1px solid #ffffff18; border-radius: 8px;
          padding: 4px; z-index: 3000; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          min-width: 160px;
        `;
        const removeItem = document.createElement("div");
        removeItem.textContent = "✕  Remove from Library";
        removeItem.style.cssText = `
          padding: 7px 12px; font-size: 12px; color: #ff5c8a;
          border-radius: 5px; cursor: pointer;
        `;
        removeItem.onmouseenter = () => removeItem.style.background = "rgba(255,92,138,0.1)";
        removeItem.onmouseleave = () => removeItem.style.background = "transparent";
        removeItem.onclick = () => {
          menu.remove();
          const updated = (loadFolders() || []).filter(f => f !== rootFolder);
          saveFolders(updated);
          reloadLibrary();
        };
        menu.appendChild(removeItem);
        document.body.appendChild(menu);
        setTimeout(() => {
          document.addEventListener("click", function handler() {
            menu.remove();
            document.removeEventListener("click", handler);
          }, { once: true });
        }, 0);
      };
    }
    container.appendChild(li);
    container.appendChild(ul);
    node.children.forEach(child => renderTreeWithRoot(child, ul, false, rootFolder));
  } else {
    const cleanName = stripExt(node.name);

    li.classList.add("song-item");
    li.title = cleanName;
    li.dataset.path = node.path;
    li.dataset.name = cleanName.toLowerCase();
    li.dataset.songPath = node.path;
    li.dataset.songName = cleanName;

    // Name span
    const nameSpan = document.createElement("span");
    nameSpan.className   = "song-name-text";
    nameSpan.textContent = cleanName;

    // Duration span — filled async
    const durSpan = document.createElement("span");
    durSpan.className = "song-duration";
    durSpan.textContent = "";

    getSongDuration(node.path, (dur) => {
      durSpan.textContent = formatDuration(dur);
    });

    li.append(nameSpan, durSpan, queueBtn({ name: cleanName, path: node.path }));

    li.onclick = (e) => {
      e.stopPropagation();
      playlistMode = false;
      activePlaylistId = null;
      updatePlaylistBadge();
      playSongFromTree(node, li);
    };
    container.appendChild(li);
    allSongElements.push(li);
  }
}

// ── SEARCH ──────────────────────────────────────────────────
function filterSongs(query) {
  const q = query.toLowerCase().trim();
  allSongElements.forEach(el => {
    const match = !q || el.dataset.name.includes(q);
    el.style.display = match ? "" : "none";
    const parentUl = el.closest("ul.sub-list");
    if (parentUl && match) parentUl.style.display = "block";
  });
}

// ── CORE PLAY ────────────────────────────────────────────────
// ── REMEMBER LAST SONG ───────────────────────────────────────
// Stored in localStorage: { name, path, pos } — restored (paused) on next launch.
const LAST_PLAYED_KEY = "lastPlayed";
function saveLastPlayed(pos) {
  if (!currentSongPath) return;
  try {
    localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify({
      name: currentTitle, path: currentSongPath, pos: Math.max(0, Math.floor(pos || 0))
    }));
  } catch {}
}
function currentPosition() {
  const p = sound ? sound.seek() : 0;
  return typeof p === "number" ? p : 0;
}
// Show the last song in the UI without loading audio; the first Play starts it from the saved position
let pendingRestore = null;   // { song, element, pos }
function restoreLastPlayed() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_PLAYED_KEY)); } catch {}
  if (!last || !last.path || !fs.existsSync(last.path)) return;
  const el  = allSongElements.find(li => li.dataset.path === last.path) || null;
  const pos = last.pos || 0;
  pendingRestore = { song: { name: last.name, path: last.path }, element: el, pos };

  currentTitle    = stripExt(last.name);
  currentSongPath = last.path;
  updateFavButton();
  updateNowPlaying();
  if (el) { el.classList.add("active"); currentElement = el; }
  document.getElementById("songMeta").textContent = last.path;
  document.getElementById("timeLeft").textContent = formatTime(pos);
  updateMediaSession();
  loadSongMeta(false);
  loadLyricsByPath(last.path);
}
function resumePendingRestore() {
  const { song, element, pos } = pendingRestore;
  pendingRestore = null;
  playSongFromTree(song, element, { startAt: pos });
}
window.addEventListener("beforeunload", () => { if (sound && currentSongPath) saveLastPlayed(currentPosition()); });

function playSongFromTree(song, element, opts = {}) {
  const { startAt = 0 } = opts;
  pendingRestore = null;
  if (sound) sound.stop();

  sound = new Howl({
    src: [song.path],
    html5: true,
    volume: lastVolume / 100,
    onplay:  () => onSoundPlay(),
    onpause: () => { updatePlayButton(false); saveLastPlayed(currentPosition()); },
    onstop:  () => { updatePlayButton(false); saveLastPlayed(0); },
    onend:   () => handleSongEnd()
  });

  requestFadeIn();
  sound.play();
  updatePlayButton(true);
  if (startAt > 0) {
    // Jump to the saved position once playback has actually begun (ignore if it was within the last 3s)
    const s = sound;
    s.once("play", () => { const d = s.duration(); if (d && startAt < d - 3) s.seek(startAt); });
  }

  currentTitle    = stripExt(song.name);
  currentSongPath = song.path;
  updateFavButton();
  saveLastPlayed(startAt);
  onSongStarted(song);

  loopA = null; loopB = null;
  updateNowPlaying();
  updateLoopOverlay();
  updateABButtons();
  updateLoopLabels();

  if (currentElement) currentElement.classList.remove("active");
  if (element) { element.classList.add("active"); currentElement = element; }

  document.getElementById("songMeta").textContent = song.path;
  loadLyricsByPath(song.path);

  const bar = document.getElementById("seekBar");
  bar.value = 0;
  bar.style.setProperty('--progress', '0%');
  if (window.seekInterval) clearInterval(window.seekInterval);
  startSeek();
}

// ── SONG END HANDLER ─────────────────────────────────────────
function handleSongEnd() {
  if (loopA !== null && loopB !== null) { sound.seek(loopA); sound.play(); return; }
  if (playQueuedNext()) return;

  if (playlistMode && activePlaylistId) {
    const lists = loadPlaylists();
    const pl    = lists.find(p => p.id === activePlaylistId);
    if (!pl) { updatePlayButton(false); return; }

    const mode  = pl.mode || "loop";
    const total = pl.songs.length;

    if (mode === "loop") {
      playFromPlaylist(activePlaylistId, (activePlaylistIdx + 1) % total);
    } else if (mode === "stop") {
      if (activePlaylistIdx < total - 1) playFromPlaylist(activePlaylistId, activePlaylistIdx + 1);
      else updatePlayButton(false);
    } else if (mode === "next") {
      if (activePlaylistIdx < total - 1) {
        playFromPlaylist(activePlaylistId, activePlaylistIdx + 1);
      } else {
        const lists2 = loadPlaylists();
        const plIdx  = lists2.findIndex(p => p.id === activePlaylistId);
        const nextPl = lists2[plIdx + 1];
        if (nextPl && nextPl.songs.length > 0) playFromPlaylist(nextPl.id, 0);
        else updatePlayButton(false);
      }
    } else if (mode === "shuffle") {
      playFromPlaylist(activePlaylistId, Math.floor(Math.random() * total));
    }
    return;
  }

  if (repeatMode === "one") { sound.play(); return; }
  if (shuffleOn) { if (!shufflePlayNext(repeatMode === "all")) updatePlayButton(false); return; }
  if (repeatMode === "all") { playNextFromTree(); return; }
  updatePlayButton(false);
}

// ── SEEK ─────────────────────────────────────────────────────
let seekTicks = 0;
function startSeek() {
  if (window.seekInterval) clearInterval(window.seekInterval);
  window.seekInterval = setInterval(() => {
    if (!sound || !sound.playing()) return;
    const current  = sound.seek();
    const duration = sound.duration();
    if (!duration) return;
    const progress = (current / duration) * 100;
    const bar = document.getElementById("seekBar");
    bar.value = progress;
    bar.style.setProperty('--progress', progress + '%');
    updateLoopOverlay();
    trackPlayTime(duration);
    if (seekTicks % 4 === 0) syncMediaPosition(current, duration);
    if (++seekTicks % 20 === 0) saveLastPlayed(current);   // every ~5s
    document.getElementById("timeLeft").textContent  = formatTime(current);
    document.getElementById("timeRight").textContent = formatTime(duration);
    if (loopA !== null && loopB !== null && sound.seek() >= loopB) sound.seek(loopA);
  }, 250);
}

document.getElementById("seekBar").addEventListener("input", function () {
  if (sound) sound.seek((this.value / 100) * sound.duration());
});

function seekRel(secs) {
  if (sound) sound.seek(Math.max(0, sound.seek() + secs));
}

// ── TRANSPORT ────────────────────────────────────────────────
function togglePlay() {
  if (!sound && pendingRestore) { resumePendingRestore(); return; }
  if (!sound) return;
  if (fadeTogglePlay()) return;
  if (sound.playing()) { sound.pause(); updatePlayButton(false); }
  else { sound.play(); updatePlayButton(true); }
}

function stop() {
  if (sound) { sound.stop(); updatePlayButton(false); }
}

function next() {
  if (playQueuedNext()) return;
  if (playlistMode && activePlaylistId) {
    const lists = loadPlaylists();
    const pl    = lists.find(p => p.id === activePlaylistId);
    if (!pl) return;
    const mode = pl.mode || "loop";
    if (mode === "shuffle") {
      playFromPlaylist(activePlaylistId, Math.floor(Math.random() * pl.songs.length));
    } else {
      const n = activePlaylistIdx + 1;
      if (n < pl.songs.length) playFromPlaylist(activePlaylistId, n);
      else if (mode === "loop") playFromPlaylist(activePlaylistId, 0);
    }
  } else if (shuffleOn) {
    shufflePlayNext(true);
  } else {
    playNextFromTree();
  }
}

function prev() {
  if (playlistMode && activePlaylistId) {
    const lists = loadPlaylists();
    const pl    = lists.find(p => p.id === activePlaylistId);
    if (!pl) return;
    const n = activePlaylistIdx - 1;
    playFromPlaylist(activePlaylistId, n >= 0 ? n : pl.songs.length - 1);
  } else if (shuffleOn) {
    shufflePlayPrev();
  } else {
    const items = document.querySelectorAll(".song-item");
    for (let i = 0; i < items.length; i++) {
      if (items[i] === currentElement) {
        (i > 0 ? items[i - 1] : items[items.length - 1]).click();
        return;
      }
    }
  }
}

function playNextFromTree() {
  const items = document.querySelectorAll(".song-item");
  for (let i = 0; i < items.length; i++) {
    if (items[i] === currentElement) {
      (i < items.length - 1 ? items[i + 1] : items[0]).click();
      return;
    }
  }
}

function updatePlayButton(isPlaying) {
  syncMediaState(isPlaying);
  document.getElementById("playPauseBtn").innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
}

// ── REPEAT (library mode) ────────────────────────────────────
function toggleRepeat() {
  const modes  = ["all", "one", "none"];
  const labels = { all: "Repeat all", one: "Repeat one", none: "Repeat off" };
  repeatMode   = modes[(modes.indexOf(repeatMode) + 1) % 3];
  const btn    = document.getElementById("repeatBtn");
  btn.textContent = labels[repeatMode];
  btn.classList.toggle("active", repeatMode !== "none");
}

// ── A-B LOOP ─────────────────────────────────────────────────
function setA() {
  if (!sound) return;
  if (loopA !== null && loopB !== null) { clearLoop(); return; }
  loopA = sound.seek();
  updateNowPlaying(); updateLoopOverlay(); updateABButtons(); updateLoopLabels();
}
function setB() {
  if (!sound || loopA === null) return;
  loopB = sound.seek();
  if (loopB <= loopA) loopB = loopA + 1;
  updateNowPlaying(); updateLoopOverlay(); updateABButtons(); updateLoopLabels();
}
function clearLoop() {
  if (loopA === null && loopB === null) return;
  loopA = null; loopB = null;
  updateNowPlaying(); updateLoopOverlay(); updateABButtons(); updateLoopLabels();
}
function updateABButtons() {
  document.getElementById("btnA").classList.toggle("set", loopA !== null);
  document.getElementById("btnB").classList.toggle("set", loopB !== null);
}
function updateLoopLabels() {
  document.getElementById("labelA").textContent = loopA !== null ? `A: ${formatTime(loopA)}` : "";
  document.getElementById("labelB").textContent = loopB !== null ? `B: ${formatTime(loopB)}` : "";
}
function updateLoopOverlay() {
  const overlay = document.getElementById("loopOverlay");
  if (!sound || loopA === null || loopB === null) { overlay.style.width = "0"; return; }
  const duration = sound.duration();
  if (!duration) return;
  overlay.style.left  = (loopA / duration * 100) + "%";
  overlay.style.width = ((loopB - loopA) / duration * 100) + "%";
}

// ── VOLUME ───────────────────────────────────────────────────
function setVolume(val) {
  lastVolume = parseInt(val);
  if (sound) sound.volume(lastVolume / 100);
  document.getElementById("volumeBar").style.setProperty('--vol', lastVolume + '%');
  isMuted = lastVolume === 0;
  updateVolIcon();
}
function toggleMute() {
  if (!sound) return;
  isMuted = !isMuted;
  sound.volume(isMuted ? 0 : lastVolume / 100);
  updateVolIcon();
}
function updateVolIcon() {
  document.getElementById("volIcon").innerHTML = isMuted ? ICON_MUTE : ICON_VOL;
}
document.getElementById("volumeBar").style.setProperty('--vol', '80%');

// ── THEME ────────────────────────────────────────────────────
function changeTheme(color) {
  document.documentElement.style.setProperty('--accent', color);
  try { localStorage.setItem("accent", color); } catch {}
}

// ── LYRICS ───────────────────────────────────────────────────
let lyricsMode   = "edit";   // "edit" | "sync"
let syncLines    = [];       // [{ time, text }]
let syncInterval = null;
let activeSyncIdx = -1;

// ── LRC PARSER ───────────────────────────────────────────────
function parseLRC(lrc) {
  const lines = [];
  const regex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/;
  lrc.split("\n").forEach(line => {
    const m = line.match(regex);
    if (!m) return;
    const time = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3].padEnd(3,"0")) / 1000;
    const text = m[4].trim();
    if (text) lines.push({ time, text });
  });
  return lines.sort((a, b) => a.time - b.time);
}

// ── FILENAME → track + artist ─────────────────────────────────
function parseFilename(title) {
  // Try "Artist - Track" or "Track - Artist"
  const sep = title.indexOf(" - ");
  if (sep !== -1) {
    return {
      track:  title.slice(sep + 3).trim(),
      artist: title.slice(0, sep).trim()
    };
  }
  return { track: title.trim(), artist: "" };
}

// ── FETCH LYRICS FROM LRCLIB ──────────────────────────────────
// Strip noise from filenames: "(Official Video)", "[HD]", "_" used for ":" etc.
function cleanTitle(t) {
  return t
    .replace(/[\(\[][^\)\]]*(official|video|audio|lyric|lyrics|hd|4k|remaster|full song|music)[^\)\]]*[\)\]]/gi, " ")
    .replace(/\b(official|lyrical|lyric|video|audio|full song|hd|4k)\b/gi, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function lrclibJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function toResult(d) {
  if (!d || (!d.syncedLyrics && !d.plainLyrics)) return null;
  // Always show lyrics in English letters, whatever the song's language
  return {
    synced: d.syncedLyrics ? romanize(d.syncedLyrics) : null,
    plain:  d.plainLyrics  ? romanize(d.plainLyrics)  : null
  };
}

async function fetchLyrics(title) {
  const cleaned = cleanTitle(title);
  const { track, artist } = parseFilename(cleaned);
  const dur = sound && sound.duration() ? Math.round(sound.duration()) : null;

  // 0. Embedded tags (real artist/title) beat guessing from the filename
  const meta = typeof getMeta === "function" ? await getMeta(currentSongPath) : null;
  const tag  = typeof tagLyricsKeys === "function" ? tagLyricsKeys(meta) : null;
  if (tag) {
    for (const a of tag.artists) {
      const p = new URLSearchParams({ track_name: tag.track, artist_name: a });
      if (meta.album && a === tag.artists[0]) p.set("album_name", meta.album);
      if (dur) p.set("duration", dur);
      const hit = toResult(await lrclibJson(`https://lrclib.net/api/get?${p}`));
      if (hit) return hit;
    }
  }

  // 1. Exact match (works when "Artist - Track" is right)
  if (artist) {
    const p = new URLSearchParams({ track_name: track, artist_name: artist });
    if (dur) p.set("duration", dur);
    const hit = toResult(await lrclibJson(`https://lrclib.net/api/get?${p}`));
    if (hit) return hit;
  }

  // 2. Fuzzy search — try the full cleaned name, then each half, then track only
  const queries = [cleaned];
  if (artist) queries.push(`${track} ${artist}`, track, artist);
  if (tag) queries.unshift(`${tag.track} ${tag.artists[tag.artists.length - 1]}`, tag.track);
  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const list = await lrclibJson(`https://lrclib.net/api/search?${new URLSearchParams({ q })}`);
    if (!Array.isArray(list) || !list.length) continue;
    const usable = list.filter(d => d.syncedLyrics || d.plainLyrics);
    if (!usable.length) continue;
    // Prefer synced, then closest duration
    usable.sort((x, y) => {
      const sx = x.syncedLyrics ? 0 : 1, sy = y.syncedLyrics ? 0 : 1;
      if (sx !== sy) return sx - sy;
      // A version already written in English letters beats auto-romanizing
      const lx = hasIndic(x.syncedLyrics || x.plainLyrics) ? 1 : 0, ly = hasIndic(y.syncedLyrics || y.plainLyrics) ? 1 : 0;
      if (lx !== ly) return lx - ly;
      if (dur) return Math.abs((x.duration || 0) - dur) - Math.abs((y.duration || 0) - dur);
      return 0;
    });
    // Reject results whose length is far off (wrong song)
    const best = usable.find(d => !dur || !d.duration || Math.abs(d.duration - dur) <= 8);
    if (best) return toResult(best);
  }
  return null;
}

// ── SHOW SYNCED LYRICS ────────────────────────────────────────
function showSyncedLyrics(lines) {
  lyricsMode = "sync";
  syncLines  = lines;
  activeSyncIdx = -1;

  const panel = document.getElementById("lyricsPanel");
  panel.style.display = "none";

  let syncDiv = document.getElementById("syncLyricsDiv");
  if (!syncDiv) {
    syncDiv = document.createElement("div");
    syncDiv.id = "syncLyricsDiv";
    panel.parentNode.appendChild(syncDiv);
  }
  syncDiv.style.display = "flex";
  syncDiv.innerHTML = "";

  lines.forEach((line, i) => {
    const el = document.createElement("div");
    el.className   = "sync-line";
    el.textContent = line.text;
    el.dataset.idx = i;
    el.onclick = () => { if (sound) sound.seek(line.time); };
    syncDiv.appendChild(el);
  });

  updateLyricsHeader(true);
  startSyncHighlight();
}

// ── SHOW PLAIN LYRICS ─────────────────────────────────────────
function showPlainLyrics(text) {
  lyricsMode = "edit";
  stopSyncHighlight();

  const syncDiv = document.getElementById("syncLyricsDiv");
  if (syncDiv) syncDiv.style.display = "none";

  const panel = document.getElementById("lyricsPanel");
  panel.style.display = "";
  panel.value = text;
  updateLyricsHeader(false);
}

// ── SYNC HIGHLIGHT LOOP ───────────────────────────────────────
function startSyncHighlight() {
  stopSyncHighlight();
  syncInterval = setInterval(() => {
    if (!sound || !sound.playing() || !syncLines.length) return;
    const cur = sound.seek();
    let idx = -1;
    for (let i = 0; i < syncLines.length; i++) {
      if (syncLines[i].time <= cur) idx = i;
      else break;
    }
    if (idx !== activeSyncIdx) {
      activeSyncIdx = idx;
      highlightSyncLine(idx);
    }
  }, 200);
}

function stopSyncHighlight() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

function highlightSyncLine(idx) {
  const syncDiv = document.getElementById("syncLyricsDiv");
  if (!syncDiv) return;
  syncDiv.querySelectorAll(".sync-line").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    el.classList.toggle("past",   i < idx);
  });
  if (idx >= 0) {
    const active = syncDiv.querySelector(".sync-line.active");
    if (active) active.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── LYRICS HEADER TOGGLE ──────────────────────────────────────
function updateLyricsHeader(isSynced) {
  const editBtn  = document.getElementById("lyricsEditBtn");
  const fetchBtn = document.getElementById("lyricsFetchBtn");
  const saveBtn  = document.querySelector(".btn-save");
  if (editBtn)  editBtn.style.display  = isSynced ? "" : "none";
  if (fetchBtn) fetchBtn.style.display = isSynced ? "none" : "";
  if (saveBtn)  saveBtn.style.display  = isSynced ? "none" : "";
}

function switchToEditMode() {
  lyricsMode = "edit";
  stopSyncHighlight();
  const syncDiv = document.getElementById("syncLyricsDiv");
  if (syncDiv) syncDiv.style.display = "none";
  const panel = document.getElementById("lyricsPanel");
  panel.style.display = "";
  updateLyricsHeader(false);
}

// ── FETCH BUTTON HANDLER ──────────────────────────────────────
async function onFetchLyrics() {
  if (!currentTitle) return;
  const fetchBtn = document.getElementById("lyricsFetchBtn");
  fetchBtn.textContent = "Fetching…";
  fetchBtn.disabled    = true;

  const result = await fetchLyrics(currentTitle);

  fetchBtn.textContent = "Fetch";
  fetchBtn.disabled    = false;

  if (!result) {
    fetchBtn.textContent = "Not found";
    setTimeout(() => { fetchBtn.textContent = "Fetch"; }, 2000);
    return;
  }

  if (result.synced) {
    const lines = parseLRC(result.synced);
    if (lines.length > 0) { showSyncedLyrics(lines); return; }
  }
  if (result.plain) {
    showPlainLyrics(result.plain);
    return;
  }

  fetchBtn.textContent = "Not found";
  setTimeout(() => { fetchBtn.textContent = "Fetch"; }, 2000);
}

// ── LOAD LYRICS ON SONG CHANGE ────────────────────────────────
function loadLyricsByPath(songPath) {
  // Stop any running sync
  stopSyncHighlight();
  lyricsMode    = "edit";
  syncLines     = [];
  activeSyncIdx = -1;

  // Hide sync div, show textarea
  const syncDiv = document.getElementById("syncLyricsDiv");
  if (syncDiv) syncDiv.style.display = "none";
  const panel = document.getElementById("lyricsPanel");
  panel.style.display = "";
  updateLyricsHeader(false);

  // Load saved lyrics
  try {
    const data = JSON.parse(fs.readFileSync(lyricsFile));
    panel.value = data[songPath] || "";
  } catch { panel.value = ""; }

  // Auto-fetch if no saved lyrics
  if (!panel.value.trim()) {
    setTimeout(() => onFetchLyrics(), 300);
  }
}

function saveLyrics() {
  if (lyricsMode === "sync") { switchToEditMode(); return; }
  let data = {};
  try { data = JSON.parse(fs.readFileSync(lyricsFile)); } catch {}
  data[currentSongPath] = document.getElementById("lyricsPanel").value;
  fs.writeFileSync(lyricsFile, JSON.stringify(data, null, 2));
  const btn = document.querySelector(".btn-save");
  btn.textContent = "Saved ✓";
  setTimeout(() => btn.textContent = "Save", 1500);
}

// ── NOW PLAYING ──────────────────────────────────────────────
function updateNowPlaying() {
  document.getElementById("nowPlaying").textContent = currentTitle || "No song selected";
}
function updatePlaylistBadge() {
  const badge = document.getElementById("playlistBadge");
  if (!badge) return;
  if (playlistMode && activePlaylistId) {
    const pl = loadPlaylists().find(p => p.id === activePlaylistId);
    badge.textContent   = pl ? `▶ ${pl.name}` : "";
    badge.style.display = "block";
  } else {
    badge.style.display = "none";
  }
}

// ── FAVORITES ────────────────────────────────────────────────
// favorites.json : [{ name, path, category? }]   (no category = "General")
// favorite-categories.json : ["Workout", "Chill", …] — user-defined, ordered
const favCatsFile = path.join(__dirname, "favorite-categories.json");
const GENERAL = "";                      // internal key for uncategorised favorites
const collapsedFavCats = new Set();      // categories folded shut in the sidebar

function loadFavCategories() {
  let cats = [];
  try { cats = JSON.parse(fs.readFileSync(favCatsFile)); } catch {}
  // Never lose a category that favorites still reference
  loadFavorites().forEach(f => { if (f.category && !cats.includes(f.category)) cats.push(f.category); });
  return cats;
}
function saveFavCategories(cats) {
  fs.writeFileSync(favCatsFile, JSON.stringify(cats, null, 2));
}
function findFavorite(songPath) {
  return loadFavorites().find(f => f.path === songPath);
}

// Add the song to favorites under `category`, or move it there if already saved
function setFavorite(song, category) {
  const favs = loadFavorites();
  const fav  = favs.find(f => f.path === song.path);
  if (fav) { if (category) fav.category = category; else delete fav.category; }
  else {
    const entry = { name: song.name, path: song.path };
    if (category) entry.category = category;
    favs.push(entry);
  }
  saveFavorites(favs);
  updateFavButton();
  if (currentSection === "favorites") renderFavorites();
}
function removeFavorite(songPath) {
  saveFavorites(loadFavorites().filter(f => f.path !== songPath));
  if (currentSongPath === songPath) updateFavButton();
  if (currentSection === "favorites") renderFavorites();
}

// Keyboard shortcut (F): quick add to General / remove
function toggleFavorite() {
  if (!currentSongPath) return;
  if (findFavorite(currentSongPath)) removeFavorite(currentSongPath);
  else setFavorite({ name: currentTitle, path: currentSongPath }, GENERAL);
}
// ★ button: pick (or change) the category
function onFavClick() {
  if (!currentSongPath) return;
  showFavCategoryPopup({ name: currentTitle, path: currentSongPath }, document.getElementById("favBtn"));
}
function updateFavButton() {
  if (!currentSongPath) return;
  const isFav = !!findFavorite(currentSongPath);
  const btn   = document.getElementById("favBtn");
  btn.textContent = isFav ? "★" : "☆";
  btn.classList.toggle("active", isFav);
}

// Small text-input dialog (used for naming / renaming categories)
function promptText(title, placeholder, initial, onOk) {
  const overlay = document.createElement("div");
  overlay.className = "dlg-overlay";
  const box = document.createElement("div");
  box.className = "dlg-box";

  const label = document.createElement("div");
  label.className = "dlg-title";
  label.textContent = title;

  const input = document.createElement("input");
  input.type = "text"; input.placeholder = placeholder; input.value = initial || "";
  input.className = "dlg-input"; input.maxLength = 40;

  const row = document.createElement("div");
  row.className = "dlg-row";
  const cancel = document.createElement("button");
  cancel.className = "dlg-btn"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "dlg-btn dlg-btn-primary"; ok.textContent = "Save";

  const close = () => overlay.remove();
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.classList.add("invalid"); return; }
    if (onOk(v) === false) { input.classList.add("invalid"); return; }   // rejected (e.g. duplicate)
    close();
  };
  cancel.onclick = close;
  ok.onclick = submit;
  input.oninput = () => input.classList.remove("invalid");
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); });
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });

  row.append(cancel, ok);
  box.append(label, input, row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// Returns false if the name is empty/duplicate so the dialog stays open
function addFavCategory(name) {
  const cats = loadFavCategories();
  if (cats.some(c => c.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === "general") return false;
  cats.push(name);
  saveFavCategories(cats);
  return true;
}

function createFavCategory() {
  promptText("New category", "e.g. Workout, Late night…", "", name => {
    if (addFavCategory(name) === false) return false;
    if (currentSection === "favorites") renderFavorites();
  });
}

function renameFavCategory(oldName) {
  promptText("Rename category", "Category name…", oldName, name => {
    if (name === oldName) return;
    const cats = loadFavCategories();
    if (cats.some(c => c !== oldName && c.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === "general") return false;
    saveFavCategories(cats.map(c => c === oldName ? name : c));
    saveFavorites(loadFavorites().map(f => f.category === oldName ? { ...f, category: name } : f));
    if (collapsedFavCats.delete(oldName)) collapsedFavCats.add(name);
    renderFavorites();
  });
}

function deleteFavCategory(name) {
  const n = loadFavorites().filter(f => f.category === name).length;
  const msg = n ? `Delete "${name}"?\n\nIts ${n} song${n === 1 ? "" : "s"} will stay in your favorites under General.`
                : `Delete the empty category "${name}"?`;
  if (!window.confirm(msg)) return;
  saveFavCategories(loadFavCategories().filter(c => c !== name));
  saveFavorites(loadFavorites().map(f => { if (f.category === name) { const { category, ...rest } = f; return rest; } return f; }));
  collapsedFavCats.delete(name);
  renderFavorites();
}

// Popup: choose which category a song's favorite lives in (also move / remove)
function showFavCategoryPopup(song, anchor) {
  const existing = document.getElementById("fav-popup");
  const sameAnchor = existing && existing._anchor === anchor;
  if (existing) existing.remove();
  if (sameAnchor) return;

  const fav     = findFavorite(song.path);
  const current = fav ? (fav.category || GENERAL) : null;
  const popup   = document.createElement("div");
  popup.id = "fav-popup"; popup.className = "pl-popup"; popup._anchor = anchor;

  const head = document.createElement("div");
  head.className = "pl-popup-head";
  head.textContent = fav ? "Move to category" : "Save to category";
  popup.appendChild(head);

  const addRow = (label, key) => {
    const row = document.createElement("div");
    row.className = "pl-popup-row" + (current === key ? " is-current" : "");
    const name = document.createElement("span"); name.textContent = label;
    const tick = document.createElement("small"); tick.textContent = current === key ? "✓" : "";
    row.append(name, tick);
    row.onclick = () => { popup.remove(); setFavorite(song, key); };
    popup.appendChild(row);
  };
  addRow("General", GENERAL);
  loadFavCategories().forEach(c => addRow(c, c));

  popup.appendChild(Object.assign(document.createElement("div"), { className: "pl-popup-divider" }));

  const newRow = document.createElement("div");
  newRow.className = "pl-popup-row pl-popup-new";
  newRow.textContent = "+ New category";
  newRow.onclick = () => {
    popup.remove();
    promptText("New category", "e.g. Workout, Late night…", "", name => {
      if (addFavCategory(name) === false) return false;
      setFavorite(song, name);
    });
  };
  popup.appendChild(newRow);

  if (fav) {
    const rm = document.createElement("div");
    rm.className = "pl-popup-row pl-popup-danger";
    rm.textContent = "Remove from favorites";
    rm.onclick = () => { popup.remove(); removeFavorite(song.path); };
    popup.appendChild(rm);
  }

  document.body.appendChild(popup);
  // Anchor under or above the trigger, whichever half of the window it sits in; keep on-screen
  const rect = anchor.getBoundingClientRect();
  const pw = popup.offsetWidth;
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + "px";
  if (rect.top > window.innerHeight / 2) popup.style.bottom = (window.innerHeight - rect.top + 6) + "px";
  else                                   popup.style.top    = (rect.bottom + 6) + "px";

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener("mousedown", handler); }
    });
  }, 0);
}

// ── SECTIONS ─────────────────────────────────────────────────
let currentSection = "library";

function showSection(section) {
  currentSection = section;
  ["library", "favorites", "playlists", "history", "queue"].forEach(s => {
    document.getElementById("nav-" + s).classList.toggle("active", s === section);
  });
  document.querySelector(".search-wrap").style.display  = section === "library" ? "" : "none";
  document.querySelector(".folder-btns").style.display  = section === "library" ? "" : "none";
  document.getElementById("langChips").classList.toggle("section-hidden", !["library", "favorites", "history"].includes(section));
  if      (section === "library")   reloadLibrary();
  else if (section === "favorites") renderFavorites();
  else if (section === "playlists") renderPlaylistList();
  else if (section === "history")   renderHistory();
  else if (section === "queue")     renderQueue();
}

function renderFavorites() {
  const container = document.getElementById("songList");
  container.innerHTML = "";
  const favs = loadFavorites().filter(f => songVisible(f.path));
  const cats = loadFavCategories();

  const newBtn = document.createElement("div");
  newBtn.className = "pl-new-btn";
  newBtn.textContent = "+ New category";
  newBtn.onclick = createFavCategory;
  container.appendChild(newBtn);

  if (favs.length === 0 && (cats.length === 0 || langFilter.size)) {
    container.insertAdjacentHTML("beforeend", langFilter.size
      ? `<div class="empty-msg">No favorites in the selected language.</div>`
      : `<div class="empty-msg">No favorites yet.<br>Press ★ while a song plays to save it to a category.</div>`);
    return;
  }

  // User categories in their own order, General (uncategorised) last and only when used
  const groups = cats.map(c => ({ key: c, label: c, editable: true }))
    .filter(g => !langFilter.size || favs.some(f => f.category === g.key));   // hide empty categories while filtering
  if (favs.some(f => !f.category || !cats.includes(f.category))) groups.push({ key: GENERAL, label: "General", editable: false });

  groups.forEach(g => {
    const songs = favs.filter(f => g.key === GENERAL ? (!f.category || !cats.includes(f.category)) : f.category === g.key);
    const collapsed = collapsedFavCats.has(g.key);

    const head = document.createElement("li");
    head.className = "folder-item fav-cat" + (collapsed ? "" : " open");

    const title = document.createElement("span");
    title.className = "fav-cat-name"; title.textContent = g.label;
    const count = document.createElement("span");
    count.className = "fav-cat-count"; count.textContent = songs.length;
    head.append(title, count);

    if (g.editable) {
      const tools = document.createElement("span");
      tools.className = "fav-cat-tools";
      const mk = (glyph, tip, fn) => {
        const b = document.createElement("button");
        b.className = "pl-btn"; b.textContent = glyph; b.title = tip;
        b.onclick = e => { e.stopPropagation(); fn(); };
        return b;
      };
      tools.append(mk("✎", "Rename category", () => renameFavCategory(g.key)),
                   mk("✕", "Delete category", () => deleteFavCategory(g.key)));
      head.appendChild(tools);
    }

    const rows = [];
    head.onclick = () => {
      const nowCollapsed = !collapsedFavCats.has(g.key);
      if (nowCollapsed) collapsedFavCats.add(g.key); else collapsedFavCats.delete(g.key);
      head.classList.toggle("open", !nowCollapsed);
      rows.forEach(li => li.style.display = nowCollapsed ? "none" : "");
    };
    container.appendChild(head);

    if (songs.length === 0) {
      const hint = document.createElement("li");
      hint.className = "fav-empty"; hint.textContent = "Empty — use ★ on a playing song";
      hint.style.display = collapsed ? "none" : "";
      rows.push(hint); container.appendChild(hint);
    }

    songs.forEach(song => {
      const li = document.createElement("li");
      li.classList.add("song-item", "fav-song");
      li.title = song.name;
      li.dataset.name = song.name.toLowerCase();
      li.dataset.songPath = song.path; li.dataset.songName = song.name;
      if (collapsed) li.style.display = "none";

      const nameSpan = document.createElement("span");
      nameSpan.className   = "song-name-text";
      nameSpan.textContent = song.name;
      nameSpan.onclick = () => {
        playlistMode = false; activePlaylistId = null; updatePlaylistBadge();
        playSongFromTree({ name: song.name + ".mp3", path: song.path }, li);
      };

      const moveBtn = document.createElement("button");
      moveBtn.className = "fav-row-btn"; moveBtn.textContent = "⋯"; moveBtn.title = "Move to another category";
      moveBtn.onclick = e => { e.stopPropagation(); showFavCategoryPopup(song, moveBtn); };

      const removeBtn = document.createElement("button");
      removeBtn.className = "fav-row-btn fav-row-star"; removeBtn.textContent = "★"; removeBtn.title = "Remove from favorites";
      removeBtn.onclick = e => { e.stopPropagation(); removeFavorite(song.path); };

      li.append(nameSpan, queueBtn(song), moveBtn, removeBtn);
      rows.push(li);
      container.appendChild(li);
    });
  });
}

// ── PLAYLIST UI ──────────────────────────────────────────────
let viewingPlaylistId = null;

function renderPlaylistList() {
  viewingPlaylistId = null;
  const container   = document.getElementById("songList");
  container.innerHTML = "";
  const lists = loadPlaylists();

  const newBtn = document.createElement("div");
  newBtn.className   = "pl-new-btn";
  newBtn.textContent = "+ New Playlist";
  newBtn.onclick     = () => createPlaylist();
  container.appendChild(newBtn);

  if (lists.length === 0) {
    const msg = document.createElement("div");
    msg.className   = "empty-msg";
    msg.textContent = "No playlists yet.";
    container.appendChild(msg);
    return;
  }

  lists.forEach(pl => {
    const row  = document.createElement("div");
    row.className = "pl-row";

    const info = document.createElement("div");
    info.className = "pl-info";
    info.innerHTML = `<span class="pl-name">${pl.name}</span><span class="pl-count">${pl.songs.length} songs</span>`;
    info.onclick   = () => renderPlaylistDetail(pl.id);

    const btns = document.createElement("div");
    btns.className = "pl-btns";

    const playBtn = document.createElement("button");
    playBtn.className = "pl-btn"; playBtn.textContent = "▶"; playBtn.title = "Play playlist";
    playBtn.onclick = (e) => { e.stopPropagation(); playFromPlaylist(pl.id, 0); };

    const renameBtn = document.createElement("button");
    renameBtn.className = "pl-btn"; renameBtn.textContent = "✏"; renameBtn.title = "Rename";
    renameBtn.onclick = (e) => { e.stopPropagation(); renamePlaylist(pl.id); };

    const delBtn = document.createElement("button");
    delBtn.className = "pl-btn pl-btn-del"; delBtn.textContent = "🗑"; delBtn.title = "Delete";
    delBtn.onclick = (e) => { e.stopPropagation(); deletePlaylist(pl.id); };

    btns.append(playBtn, renameBtn, delBtn);
    row.append(info, btns);
    container.appendChild(row);
  });
}

function renderPlaylistDetail(id) {
  viewingPlaylistId = id;
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;

  const container = document.getElementById("songList");
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "pl-detail-header";
  header.innerHTML = `<button class="pl-back-btn" onclick="renderPlaylistList()">← Back</button>
    <span class="pl-detail-title">${pl.name}</span>`;
  container.appendChild(header);

  const modeWrap = document.createElement("div");
  modeWrap.className = "pl-mode-wrap";
  const modes = [
    { value: "loop",    label: "🔁 Loop" },
    { value: "stop",    label: "⏹ Stop" },
    { value: "next",    label: "⏭ Next PL" },
    { value: "shuffle", label: "🔀 Shuffle" },
  ];
  modes.forEach(m => {
    const btn = document.createElement("button");
    btn.className   = "pl-mode-btn" + ((pl.mode === m.value || (!pl.mode && m.value === "loop")) ? " active" : "");
    btn.textContent = m.label;
    btn.onclick     = () => setPlaylistMode(id, m.value);
    modeWrap.appendChild(btn);
  });
  container.appendChild(modeWrap);

  const addBtn = document.createElement("div");
  addBtn.className   = "pl-new-btn";
  addBtn.textContent = "+ Add Current Song";
  addBtn.onclick     = () => {
    if (!currentSongPath) return;
    addSongToPlaylist(id, { name: currentTitle, path: currentSongPath });
  };
  container.appendChild(addBtn);

  if (pl.songs.length === 0) {
    const msg = document.createElement("div");
    msg.className = "empty-msg"; msg.textContent = "No songs yet.";
    container.appendChild(msg);
    return;
  }

  pl.songs.forEach((song, idx) => {
    const row = document.createElement("div");
    row.dataset.songPath = song.path; row.dataset.songName = song.name;
    row.className = "pl-song-row" + (playlistMode && activePlaylistId === id && activePlaylistIdx === idx ? " active" : "");

    const name = document.createElement("span");
    name.className = "pl-song-name"; name.textContent = song.name; name.title = song.name;
    name.onclick = () => playFromPlaylist(id, idx);

    const del = document.createElement("button");
    del.className = "pl-btn pl-btn-del"; del.textContent = "✕"; del.title = "Remove";
    del.onclick = () => removeSongFromPlaylist(id, idx);

    row.append(name, del);
    container.appendChild(row);
  });
}

// ── PLAYLIST OPERATIONS ──────────────────────────────────────
function createPlaylist(andAddSong = false) {
  const existing = document.getElementById("pl-prompt");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;`;

  const box = document.createElement("div");
  box.style.cssText = `background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 280px; display: flex; flex-direction: column; gap: 12px;`;

  const label = document.createElement("div");
  label.textContent = "New Playlist";
  label.style.cssText = "font-size: 13px; font-weight: 600; color: #e8e8f0;";

  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "Playlist name…";
  input.style.cssText = `background: #0c0c10; border: 1px solid #ffffff0f; border-radius: 7px;
    padding: 8px 10px; color: #e8e8f0; font-size: 13px; font-family: inherit; outline: none; width: 100%;`;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `background: transparent; color: #6b6b80; border: 1px solid #ffffff0f;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;
  cancelBtn.onclick = () => overlay.remove();

  const createBtn = document.createElement("button");
  createBtn.textContent = "Create";
  createBtn.style.cssText = `background: var(--accent); color: white; border: none;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;

  const doCreate = () => {
    const name = input.value.trim();
    if (!name) return;
    overlay.remove();
    const lists = loadPlaylists();
    const pl    = { id: genId(), name, songs: [], mode: "loop" };
    if (andAddSong && currentSongPath) pl.songs.push({ name: currentTitle, path: currentSongPath });
    lists.push(pl);
    savePlaylists(lists);
    if (currentSection === "playlists") renderPlaylistList();
  };

  createBtn.onclick = doCreate;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  doCreate();
    if (e.key === "Escape") overlay.remove();
  });

  btnRow.append(cancelBtn, createBtn);
  box.append(label, input, btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 0);
}

function renamePlaylist(id) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;

  const existing = document.getElementById("pl-prompt");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;`;

  const box = document.createElement("div");
  box.style.cssText = `background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 280px; display: flex; flex-direction: column; gap: 12px;`;

  const label = document.createElement("div");
  label.textContent = "Rename Playlist";
  label.style.cssText = "font-size: 13px; font-weight: 600; color: #e8e8f0;";

  const input = document.createElement("input");
  input.type = "text"; input.value = pl.name;
  input.style.cssText = `background: #0c0c10; border: 1px solid #ffffff0f; border-radius: 7px;
    padding: 8px 10px; color: #e8e8f0; font-size: 13px; font-family: inherit; outline: none; width: 100%;`;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `background: transparent; color: #6b6b80; border: 1px solid #ffffff0f;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;
  cancelBtn.onclick = () => overlay.remove();

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.style.cssText = `background: var(--accent); color: white; border: none;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;

  const doRename = () => {
    const name = input.value.trim();
    if (!name) return;
    overlay.remove();
    pl.name = name;
    savePlaylists(lists);
    renderPlaylistList();
  };

  saveBtn.onclick = doRename;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  doRename();
    if (e.key === "Escape") overlay.remove();
  });

  btnRow.append(cancelBtn, saveBtn);
  box.append(label, input, btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function deletePlaylist(id) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;

  const existing = document.getElementById("pl-prompt");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;`;

  const box = document.createElement("div");
  box.style.cssText = `background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 280px; display: flex; flex-direction: column; gap: 12px;`;

  const label = document.createElement("div");
  label.textContent = "Delete Playlist";
  label.style.cssText = "font-size: 13px; font-weight: 600; color: #e8e8f0;";

  const msg = document.createElement("div");
  msg.textContent = `Delete "${pl.name}"? This cannot be undone.`;
  msg.style.cssText = "font-size: 12px; color: #6b6b80; line-height: 1.5;";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `background: transparent; color: #6b6b80; border: 1px solid #ffffff0f;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;
  cancelBtn.onclick = () => overlay.remove();

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.style.cssText = `background: #ff5c8a; color: white; border: none;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit;`;
  delBtn.onclick = () => {
    overlay.remove();
    savePlaylists(loadPlaylists().filter(p => p.id !== id));
    if (activePlaylistId === id) { playlistMode = false; activePlaylistId = null; updatePlaylistBadge(); }
    renderPlaylistList();
  };

  btnRow.append(cancelBtn, delBtn);
  box.append(label, msg, btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function addSongToPlaylist(id, song) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;
  if (pl.songs.some(s => s.path === song.path)) { alert("Song already in playlist."); return; }
  pl.songs.push(song);
  savePlaylists(lists);
  if (viewingPlaylistId === id) renderPlaylistDetail(id);
}

function removeSongFromPlaylist(id, idx) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;
  pl.songs.splice(idx, 1);
  savePlaylists(lists);
  renderPlaylistDetail(id);
}

function setPlaylistMode(id, mode) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl) return;
  pl.mode = mode;
  savePlaylists(lists);
  renderPlaylistDetail(id);
}

function playFromPlaylist(id, idx) {
  const lists = loadPlaylists();
  const pl    = lists.find(p => p.id === id);
  if (!pl || !pl.songs[idx]) return;

  playlistMode      = true;
  activePlaylistId  = id;
  activePlaylistIdx = idx;
  updatePlaylistBadge();

  if (currentSection === "playlists" && viewingPlaylistId === id) renderPlaylistDetail(id);
  playSongFromTree({ name: pl.songs[idx].name, path: pl.songs[idx].path }, null);
}

// ── ADD TO PLAYLIST POPUP ────────────────────────────────────
function showAddToPlaylistPopup() {
  if (!currentSongPath) return;

  const existing = document.getElementById("pl-popup");
  if (existing) { existing.remove(); return; }

  const lists = loadPlaylists();
  const popup = document.createElement("div");
  popup.id = "pl-popup"; popup.className = "pl-popup";

  const newRow = document.createElement("div");
  newRow.className = "pl-popup-row pl-popup-new";
  newRow.textContent = "+ Create New Playlist";
  newRow.onclick = () => { popup.remove(); createPlaylist(true); };
  popup.appendChild(newRow);

  if (lists.length > 0) {
    const divider = document.createElement("div");
    divider.className = "pl-popup-divider";
    popup.appendChild(divider);
    lists.forEach(pl => {
      const row = document.createElement("div");
      row.className = "pl-popup-row";
      row.innerHTML = `<span>${pl.name}</span><small>${pl.songs.length} songs</small>`;
      row.onclick = () => { addSongToPlaylist(pl.id, { name: currentTitle, path: currentSongPath }); popup.remove(); };
      popup.appendChild(row);
    });
  }

  const btn  = document.getElementById("addToPlaylistBtn");
  const rect = btn.getBoundingClientRect();
  popup.style.bottom = (window.innerHeight - rect.top + 6) + "px";
  popup.style.left   = rect.left + "px";
  document.body.appendChild(popup);

  setTimeout(() => {
    document.addEventListener("click", function handler(e) {
      if (!popup.contains(e.target) && e.target !== btn) {
        popup.remove();
        document.removeEventListener("click", handler);
      }
    });
  }, 0);
}

// ── FOLDERS ──────────────────────────────────────────────────
function loadFolders() {
  try { return JSON.parse(fs.readFileSync(FOLDERS_FILE)); }
  catch { return null; }
}
function saveFolders(folders) {
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

async function addFolder() {
  const { ipcRenderer } = require('electron');
  const folder = await ipcRenderer.invoke('open-folder-dialog');
  if (!folder) return;
  const existing = loadFolders() || [];
  if (!existing.includes(folder)) { existing.push(folder); saveFolders(existing); }
  reloadLibrary();
}

function reloadLibrary() {
  renderLangChips();
  const folders = loadFolders();
  if (!folders || folders.length === 0) { showWelcomeScreen(); return; }
  const container = document.getElementById("songList");
  container.innerHTML = "";
  allSongElements = [];
  folders.forEach(folder => { if (fs.existsSync(folder) && languageSelected(languageOfFolder(folder))) buildTree(folder); });
  afterLibraryReload();
}

// ── WELCOME SCREEN ───────────────────────────────────────────
function showWelcomeScreen() {
  const container = document.getElementById("songList");
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "welcome-wrap";
  wrap.innerHTML = `
    <div class="welcome-icon">🎵</div>
    <div class="welcome-title">Welcome!</div>
    <div class="welcome-sub">No music folders added yet.<br>Scan a drive or add a folder to get started.</div>
    <button class="welcome-btn welcome-btn-primary" id="scanDriveBtn">🔍 Scan Drive</button>
    <button class="welcome-btn" id="addFolderBtn">+ Add Folder</button>
  `;
  container.appendChild(wrap);
  document.getElementById("scanDriveBtn").onclick = () => showDrivePicker();
  document.getElementById("addFolderBtn").onclick  = () => addFolder();
}

// ── DRIVE PICKER ─────────────────────────────────────────────
async function showDrivePicker() {
  const { ipcRenderer } = require('electron');
  const drives = await ipcRenderer.invoke('list-drives');

  const existing = document.getElementById("pl-prompt");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;`;

  const box = document.createElement("div");
  box.style.cssText = `background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 300px; display: flex; flex-direction: column; gap: 12px;`;

  const title = document.createElement("div");
  title.textContent = "Choose a drive to scan";
  title.style.cssText = "font-size: 13px; font-weight: 600; color: #e8e8f0;";

  const sub = document.createElement("div");
  sub.textContent = "We'll find all folders containing audio files.";
  sub.style.cssText = "font-size: 11.5px; color: #6b6b80; line-height: 1.5;";

  const driveList = document.createElement("div");
  driveList.style.cssText = "display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto;";

  drives.forEach(drive => {
    const btn = document.createElement("button");
    btn.textContent = drive;
    btn.style.cssText = `background: #0c0c10; border: 1px solid #ffffff0f; border-radius: 8px;
      padding: 9px 12px; color: #e8e8f0; font-size: 13px; font-family: inherit;
      text-align: left; cursor: pointer; transition: border-color 0.15s;`;
    btn.onmouseenter = () => btn.style.borderColor = "var(--accent)";
    btn.onmouseleave = () => btn.style.borderColor = "#ffffff0f";
    btn.onclick = () => { overlay.remove(); scanDrive(drive); };
    driveList.appendChild(btn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `background: transparent; color: #6b6b80; border: 1px solid #ffffff0f;
    border-radius: 7px; padding: 6px 14px; cursor: pointer; font-family: inherit; align-self: flex-end;`;
  cancelBtn.onclick = () => overlay.remove();

  box.append(title, sub, driveList, cancelBtn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ── DRIVE SCAN ───────────────────────────────────────────────
async function scanDrive(drive) {
  const { ipcRenderer } = require('electron');
  const container = document.getElementById("songList");
  container.innerHTML = "";
  const progress = document.createElement("div");
  progress.className = "scan-progress";
  progress.innerHTML = `
    <div class="scan-spinner">⏳</div>
    <div class="scan-title">Scanning ${drive}</div>
    <div class="scan-sub">Looking for audio files…</div>
  `;
  container.appendChild(progress);

  try {
    const folders = await ipcRenderer.invoke('scan-drive', drive);
    if (folders.length === 0) {
      container.innerHTML = `<div class="empty-msg">No audio files found on ${drive}.<br>Try a different drive or add a folder manually.</div>`;
      const addBtn = document.createElement("button");
      addBtn.className = "welcome-btn"; addBtn.textContent = "+ Add Folder Manually";
      addBtn.style.cssText = "margin: 8px auto; display: block;";
      addBtn.onclick = () => addFolder();
      container.appendChild(addBtn);
      return;
    }
    const existing = loadFolders() || [];
    const merged   = [...new Set([...existing, ...folders])];
    saveFolders(merged);
    container.innerHTML = `<div class="scan-progress">
      <div class="scan-spinner">✅</div>
      <div class="scan-title">Found ${folders.length} folder${folders.length !== 1 ? "s" : ""}!</div>
      <div class="scan-sub">Loading your library…</div>
    </div>`;
    setTimeout(() => reloadLibrary(), 800);
  } catch {
    container.innerHTML = `<div class="empty-msg">Scan failed.<br>Try adding folders manually instead.</div>`;
  }
}

// ── FOLDER MANAGER ───────────────────────────────────────────
function showFolderManager() {
  const existing = document.getElementById("pl-prompt");
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement("div");
  overlay.id = "pl-prompt";
  overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 2000;`;

  const box = document.createElement("div");
  box.style.cssText = `background: #1a1a24; border: 1px solid #ffffff0f; border-radius: 12px;
    padding: 20px; width: 360px; max-height: 70vh; display: flex; flex-direction: column; gap: 12px;`;

  const header = document.createElement("div");
  header.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
  header.innerHTML = `<span style="font-size:13px; font-weight:600; color:#e8e8f0;">Music Folders</span>`;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `background: transparent; color: #6b6b80; border: none; font-size: 14px; cursor: pointer; padding: 0 4px;`;
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);

  const sub = document.createElement("div");
  sub.textContent = "Remove folders you no longer want in your library.";
  sub.style.cssText = "font-size: 11.5px; color: #6b6b80; line-height: 1.5;";

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "display: flex; flex-direction: column; gap: 6px; overflow-y: auto; max-height: 300px;";

  function rebuildList() {
    listWrap.innerHTML = "";
    const current = loadFolders() || [];
    if (current.length === 0) {
      listWrap.innerHTML = `<div style="color:#6b6b80; font-size:12px; text-align:center; padding:16px 0;">No folders added.</div>`;
      return;
    }
    current.forEach((folder) => {
      let songCount = 0;
      try {
        function countAudio(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          entries.forEach(e => {
            if (e.isFile() && /\.(mp3|wav|m4a|flac)$/i.test(e.name)) songCount++;
            else if (e.isDirectory()) countAudio(path.join(dir, e.name));
          });
        }
        if (fs.existsSync(folder)) countAudio(folder);
      } catch {}

      const row = document.createElement("div");
      row.className = "fm-row";
      const info = document.createElement("div");
      info.className = "fm-info";
      info.innerHTML = `<span class="fm-path">${folder}</span><span class="fm-count">${songCount} song${songCount !== 1 ? "s" : ""}</span>`;
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕"; removeBtn.className = "fm-remove-btn"; removeBtn.title = "Remove folder";
      removeBtn.onclick = () => {
        const updated = (loadFolders() || []).filter(f => f !== folder);
        saveFolders(updated);
        rebuildList();
        if (currentSection === "library") reloadLibrary();
      };
      row.append(info, removeBtn);
      listWrap.appendChild(row);
    });
  }

  rebuildList();

  const actions = document.createElement("div");
  actions.style.cssText = "display: flex; gap: 8px; border-top: 1px solid #ffffff0f; padding-top: 10px; flex-wrap: wrap;";

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add Folder";
  addBtn.style.cssText = `flex: 1; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent2);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); border-radius: 8px;
    padding: 7px; font-family: inherit; font-size: 12px; cursor: pointer;`;
  addBtn.onclick = async () => { overlay.remove(); await addFolder(); showFolderManager(); };

  const scanBtn = document.createElement("button");
  scanBtn.textContent = "🔍 Scan Drive";
  scanBtn.style.cssText = `flex: 1; background: transparent; color: #6b6b80;
    border: 1px solid #ffffff0f; border-radius: 8px;
    padding: 7px; font-family: inherit; font-size: 12px; cursor: pointer;`;
  scanBtn.onclick = () => { overlay.remove(); showDrivePicker(); };

  const loadBtn = document.createElement("button");
  loadBtn.textContent = "✓ Add to Library";
  loadBtn.style.cssText = `width: 100%; background: var(--accent); color: white; border: none;
    border-radius: 8px; padding: 9px; font-family: inherit; font-size: 12px;
    cursor: pointer; font-weight: 600;`;
  loadBtn.onclick = () => {
    overlay.remove();
    if (currentSection === "library") reloadLibrary();
    else showSection("library");
  };

  actions.append(addBtn, scanBtn, loadBtn);
  box.append(header, sub, listWrap, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ── UTILS ────────────────────────────────────────────────────
function formatTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" + s : s);
}

// ── KEYBOARD ─────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  switch (e.code) {
    case "Space":      e.preventDefault(); togglePlay(); break;
    case "ArrowRight": e.ctrlKey ? next() : seekRel(5); break;
    case "ArrowLeft":  e.ctrlKey ? prev() : seekRel(-5); break;
    case "ArrowUp":    next(); break;
    case "ArrowDown":  prev(); break;
    case "KeyS":       stop(); break;
    case "KeyA":       setA(); break;
    case "KeyB":       setB(); break;
    case "KeyC":       clearLoop(); break;
    case "KeyM":       toggleMute(); break;
    case "KeyF":       toggleFavorite(); break;
  }
});

// ── INIT ─────────────────────────────────────────────────────
window.onload = () => { reloadLibrary(); restoreLastPlayed(); };

// ── EXPORTS ──────────────────────────────────────────────────
window.prev                   = prev;
window.next                   = next;
window.stop                   = stop;
window.setA                   = setA;
window.setB                   = setB;
window.clearLoop              = clearLoop;
window.toggleRepeat           = toggleRepeat;
window.togglePlay             = togglePlay;
window.toggleMute             = toggleMute;
window.setVolume              = setVolume;
window.changeTheme            = changeTheme;
window.saveLyrics             = saveLyrics;
window.filterSongs            = filterSongs;
window.seekRel                = seekRel;
window.addFolder              = addFolder;
window.showFolderManager      = showFolderManager;
window.showDrivePicker        = showDrivePicker;
window.scanDrive              = scanDrive;
window.toggleFavorite         = toggleFavorite;
window.onFavClick             = onFavClick;
window.showSection            = showSection;
window.showAddToPlaylistPopup = showAddToPlaylistPopup;
window.renderPlaylistList     = renderPlaylistList;
window.renderPlaylistDetail   = renderPlaylistDetail;
window.showSleepTimer         = showSleepTimer;
window.onFetchLyrics          = onFetchLyrics;
window.switchToEditMode       = switchToEditMode;