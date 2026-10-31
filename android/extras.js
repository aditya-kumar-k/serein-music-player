// Play queue · Recently played · Most played
// Loaded after renderer.js (shares its top-level state: sound, currentSongPath, currentSection, …)

var fs = window.fs || (typeof require !== 'undefined' ? require('fs') : null) || window.fsShim;
var path = window.path || (typeof require !== 'undefined' ? require('path') : null) || window.pathShim;
var baseDir = window.baseDir || (typeof __dirname !== 'undefined' ? __dirname : "");

// ── TOAST ────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// Re-render whichever of these tabs is open
function refreshActiveSection() {
  if (currentSection === "history") renderHistory();
  else if (currentSection === "queue") renderQueue();
}

// Play a song picked from a list that isn't a folder tree (history, queue)
function playStandalone(song, opts) {
  if (!fs.existsSync(song.path)) { toast("File not found — is the drive mounted?"); return false; }
  playlistMode = false; activePlaylistId = null; updatePlaylistBadge();
  playSongFromTree({ name: song.name, path: song.path }, null, opts);
  return true;
}

// Playing from the History tab: the list shown there plays on in order and starts over after its last song.
// The order is the one on screen when the song was tapped (History itself reshuffles as songs play).
let historyList = null;                 // { songs: [{name, path}], idx }
function playHistoryList(songs, idx) {
  if (!playStandalone(songs[idx], { fromHistory: true })) return;
  historyList = { songs: songs.map(s => ({ name: s.name, path: s.path })), idx };
}
// Hook for next() / song end / prev(): returns true if the history list took over
function playHistoryStep(dir) {
  if (!historyList || playlistMode) return false;
  const n = historyList.songs.length;
  for (let k = 1; k <= n; k++) {
    const i = ((historyList.idx + dir * k) % n + n) % n;
    const song = historyList.songs[i];
    if (!fs.existsSync(song.path)) continue;
    historyList.idx = i;
    playStandalone(song, { fromHistory: true });
    return true;
  }
  return false;
}

// Called from the Howl's "play" event
function onSoundPlay() {
  updatePlayButton(true);
  if (typeof eqAttach === "function") eqAttach();
  if (typeof vizAttach === "function") vizAttach();
}

// Sleep timer: ease the volume down, then stop
const SLEEP_FADE_MS = 5000;
function stopForSleepTimer() {
  if (!sound) return;
  const s = sound;
  if (!s.playing()) { s.stop(); updatePlayButton(false); return; }
  const vol = s.volume();
  s.fade(vol, 0, SLEEP_FADE_MS);
  setTimeout(() => {
    if (sound !== s) return;               // another song took over meanwhile
    s.stop();
    s.volume(vol);
    updatePlayButton(false);
  }, SLEEP_FADE_MS + 100);
}

// ── HISTORY: recently played + most played ───────────────────
const historyFile = path.join(baseDir, "history.json");
const HISTORY_MAX = 50;
const MOST_PLAYED_MAX = 15;
const COUNT_AFTER_SECS = 30;           // a "play" counts after 30s (or half of a short song)
let playHistory = { recent: [], plays: {} };
try { playHistory = { recent: [], plays: {}, ...JSON.parse(fs.readFileSync(historyFile)) }; } catch {}
let histView = "recent";               // "recent" | "most"
let playedSecs = 0, playCounted = false, trackedPath = "";

function saveHistory() {
  try { fs.writeFileSync(historyFile, JSON.stringify(playHistory, null, 2)); } catch {}
}

// Hook: a song just started playing
function onSongStarted(song) {
  const name = stripExt(song.name);
  playHistory.recent = playHistory.recent.filter(r => r.path !== song.path);
  playHistory.recent.unshift({ name, path: song.path, at: Date.now() });
  playHistory.recent.length = Math.min(playHistory.recent.length, HISTORY_MAX);
  playedSecs = 0; playCounted = false; trackedPath = song.path; resetPlayTick();
  saveHistory();
  refreshActiveSection();
  currentMeta = null;
  updateMediaSession();
  loadSongMeta(true);
  shuffleNoteStarted(song);
  if (typeof smoothSongStarted === "function") smoothSongStarted(song);
}

// Hook: called from the seek loop while playing. Counts real elapsed time, so a slowed-down
// timer (screen off, app in the background) can't make a play take longer to register.
let lastPlayTick = 0;
function resetPlayTick() { lastPlayTick = 0; }
function trackPlayTime(duration) {
  if (playCounted || !trackedPath) return;
  const now = performance.now();
  const dt = lastPlayTick ? Math.min((now - lastPlayTick) / 1000, 5) : 0.25;   // ignore long gaps (e.g. after a pause)
  lastPlayTick = now;
  playedSecs += dt;
  if (playedSecs < Math.min(COUNT_AFTER_SECS, (duration || COUNT_AFTER_SECS) / 2)) return;
  playCounted = true;
  const rec = playHistory.plays[trackedPath] || { name: currentTitle, count: 0 };
  rec.count++; rec.last = Date.now(); rec.name = currentTitle;
  playHistory.plays[trackedPath] = rec;
  saveHistory();
  refreshActiveSection();
}

function timeAgo(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d < 30 ? d + "d ago" : new Date(ms).toLocaleDateString();
}

function songRow(song, sub, cls = "hist-row") {
  const li = document.createElement("li");
  li.className = cls + (song.path === currentSongPath ? " active" : "");
  li.dataset.songPath = song.path; li.dataset.songName = song.name;
  li.title = song.name;

  const name = document.createElement("span");
  name.className = "hist-name"; name.textContent = song.name;
  const meta = document.createElement("span");
  meta.className = "hist-meta"; meta.textContent = sub;
  li.append(name, meta);
  return li;
}

function queueBtn(song) {
  const b = document.createElement("button");
  b.className = "row-q"; b.textContent = "+"; b.title = "Add to queue";
  b.onclick = e => { e.stopPropagation(); queueAdd(song); };
  return b;
}

function renderHistory() {
  const container = document.getElementById("songList");
  container.innerHTML = "";

  const seg = document.createElement("div");
  seg.className = "hist-seg";
  [["recent", "Recent"], ["most", "Most played"]].forEach(([key, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = histView === key ? "active" : "";
    b.onclick = () => { histView = key; renderHistory(); };
    seg.appendChild(b);
  });
  container.appendChild(seg);

  let rows;
  if (histView === "recent") {
    rows = playHistory.recent.filter(r => songVisible(r.path)).map(r => ({ song: r, sub: timeAgo(r.at) }));
  } else {
    rows = Object.entries(playHistory.plays)
      .filter(([p]) => songVisible(p))
      .map(([p, r]) => ({ song: { name: r.name, path: p }, count: r.count, last: r.last }))
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, MOST_PLAYED_MAX)
      .map(x => ({ song: x.song, sub: x.count + (x.count === 1 ? " play" : " plays") }));
  }

  if (!rows.length) {
    container.insertAdjacentHTML("beforeend", `<div class="empty-msg">${
      langFilter.size ? "No history for the selected language."
      : histView === "recent" ? "Nothing played yet.<br>Songs you play will show up here."
                            : "No plays counted yet.<br>A song counts once you've listened for 30 seconds."}</div>`);
    return;
  }

  rows.forEach(({ song, sub }, i) => {
    const li = songRow(song, sub);
    if (histView === "most") {
      const rank = document.createElement("span");
      rank.className = "hist-rank"; rank.textContent = i + 1;
      li.prepend(rank);
      li.classList.add("hist-most");
    }
    li.append(queueBtn(song));
    li.onclick = () => playHistoryList(rows.map(r => r.song), i);
    container.appendChild(li);
  });

  const clear = document.createElement("div");
  clear.className = "pl-new-btn hist-clear";
  clear.textContent = "Clear history";
  clear.onclick = () => {
    if (!window.confirm("Clear recently played and play counts?")) return;
    playHistory = { recent: [], plays: {} };
    saveHistory(); renderHistory();
  };
  container.appendChild(clear);
}

// ── PLAY QUEUE ───────────────────────────────────────────────
let queue = [];
try { queue = JSON.parse(localStorage.getItem("queue")) || []; } catch {}
let dragFrom = null;

function saveQueue() {
  try { localStorage.setItem("queue", JSON.stringify(queue)); } catch {}
  const badge = document.getElementById("queueBadge");
  if (badge) { badge.textContent = queue.length || ""; badge.style.display = queue.length ? "" : "none"; }
}

function queueAdd(song, atFront = false) {
  const item = { name: stripExt(song.name), path: song.path };
  if (atFront) queue.unshift(item); else queue.push(item);
  saveQueue();
  toast(atFront ? `Playing next: ${item.name}` : `Added to queue: ${item.name}`);
  refreshActiveSection();
}

// Hook for next() / song end: returns true if a queued song took over
function playQueuedNext() {
  while (queue.length) {
    const item = queue.shift();
    saveQueue();
    if (fs.existsSync(item.path)) {
      playSongFromTree({ name: item.name, path: item.path }, null, { fromHistory: true });
      refreshActiveSection();
      return true;
    }
    toast(`Skipped missing file: ${item.name}`);
  }
  refreshActiveSection();
  return false;
}

function renderQueue() {
  const container = document.getElementById("songList");
  container.innerHTML = "";

  if (currentSongPath) {
    container.insertAdjacentHTML("beforeend", `<li class="q-label">Now playing</li>`);
    const now = songRow({ name: currentTitle, path: currentSongPath }, "", "q-row q-now");
    container.appendChild(now);
  }

  const head = document.createElement("li");
  head.className = "q-label q-head";
  head.innerHTML = `<span>Up next${queue.length ? " · " + queue.length : ""}</span>`;
  if (queue.length) {
    const clear = document.createElement("button");
    clear.className = "q-clear"; clear.textContent = "Clear";
    clear.onclick = () => { queue = []; saveQueue(); renderQueue(); };
    head.appendChild(clear);
  }
  container.appendChild(head);

  if (!queue.length) {
    container.insertAdjacentHTML("beforeend",
      `<div class="empty-msg">Queue is empty.<br>Press + on a song, or right-click it for “Play next”.</div>`);
    return;
  }

  queue.forEach((item, i) => {
    const li = songRow(item, "", "q-row");
    li.draggable = true;
    li.onclick = () => {                       // jump to this one now
      const [it] = queue.splice(i, 1); saveQueue();
      if (!playStandalone(it)) queue.splice(i, 0, it), saveQueue();
      renderQueue();
    };
    li.ondragstart = e => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); };
    li.ondragend   = () => { dragFrom = null; li.classList.remove("dragging"); };
    li.ondragover  = e => { e.preventDefault(); li.classList.add("drag-over"); };
    li.ondragleave = () => li.classList.remove("drag-over");
    li.ondrop = e => {
      e.preventDefault();
      if (dragFrom === null || dragFrom === i) return;
      const [moved] = queue.splice(dragFrom, 1);
      queue.splice(i, 0, moved);
      saveQueue(); renderQueue();
    };

    const rm = document.createElement("button");
    rm.className = "row-q row-q-rm"; rm.textContent = "✕"; rm.title = "Remove from queue";
    rm.onclick = e => { e.stopPropagation(); queue.splice(i, 1); saveQueue(); renderQueue(); };
    li.append(rm);
    container.appendChild(li);
  });
}

// ── DELETE FROM PHONE (Android) ──────────────────────────────
// Only files the library found through MediaStore can be deleted; Android asks for confirmation itself.
function canDeleteFromPhone(songPath) {
  return !!(window.AndroidBridge && AndroidBridge.plugin && AndroidBridge.plugin.deleteAudio &&
            typeof songPath === "string" && songPath.startsWith("content://media/"));
}
async function deleteSongsFromPhone(songs) {
  if (!songs.length) return false;
  const paths = new Set(songs.map(x => x.path));
  const playing = paths.has(currentSongPath) && sound;
  try {
    await AndroidBridge.plugin.deleteAudio({ uris: [...paths] });
  } catch (e) {
    if (!/cancel/i.test(e.message || "")) showScanToast("Couldn't delete: " + (e.message || e));
    return false;
  }
  if (playing) { sound.stop(); sound.unload(); sound = null; updatePlayButton(false); }
  for (let i = queue.length - 1; i >= 0; i--) if (paths.has(queue[i].path)) queue.splice(i, 1);
  saveQueue(); renderQueue();
  AndroidBridge.setSongs(AndroidBridge.allDeviceSongs.filter(x => !paths.has(x.contentUri || x.path)));
  showScanToast(songs.length === 1 ? "Deleted " + songs[0].name : `Deleted ${songs.length} songs`);
  return true;
}
const deleteSongFromPhone = (song) => deleteSongsFromPhone([song]);

// ── MULTI-SELECT ─────────────────────────────────────────────
// "Select multiple…" in the song menu starts it; tap (or long-press) rows to tick them, then Delete.
const selected = new Map();            // path → name
let selBar = null;

function selecting() { return !!selBar; }
function rowSong(row) { return { name: row.dataset.songName, path: row.dataset.songPath }; }

function toggleSelected(row) {
  const song = rowSong(row);
  if (!canDeleteFromPhone(song.path)) { showScanToast("This song can't be deleted from here"); return; }
  if (selected.has(song.path)) { selected.delete(song.path); row.classList.remove("sel-row"); }
  else { selected.set(song.path, song.name); row.classList.add("sel-row"); }
  updateSelBar();
}

function updateSelBar() {
  if (!selBar) return;
  selBar.querySelector(".sel-count").textContent = selected.size ? `${selected.size} selected` : "Tap songs to select";
  selBar.querySelector(".sel-del").disabled = !selected.size;
}

function startSelecting(firstRow) {
  if (selBar) return;
  selBar = document.createElement("div");
  selBar.id = "sel-bar";
  selBar.innerHTML = '<button class="sel-cancel">Cancel</button><span class="sel-count"></span>' +
                     '<button class="sel-all">All</button><button class="sel-del">Delete</button>';
  document.body.appendChild(selBar);
  selBar.querySelector(".sel-cancel").onclick = stopSelecting;
  selBar.querySelector(".sel-all").onclick = () => {
    document.querySelectorAll("#songList [data-song-path]").forEach(r => {
      if (r.offsetParent !== null && !selected.has(r.dataset.songPath) && canDeleteFromPhone(r.dataset.songPath)) toggleSelected(r);
    });
  };
  selBar.querySelector(".sel-del").onclick = async () => {
    const list = [...selected].map(([path, name]) => ({ path, name }));
    if (await deleteSongsFromPhone(list)) stopSelecting();
  };
  document.body.classList.add("selecting");
  if (firstRow) toggleSelected(firstRow); else updateSelBar();
}

function stopSelecting() {
  selected.clear();
  document.querySelectorAll(".sel-row").forEach(r => r.classList.remove("sel-row"));
  document.body.classList.remove("selecting");
  if (selBar) selBar.remove();
  selBar = null;
}

// while selecting, a tap on a song row ticks it instead of playing it
document.addEventListener("click", e => {
  if (!selecting()) return;
  const row = e.target.closest("[data-song-path]");
  if (!row || row.classList.contains("q-row")) return;
  e.preventDefault(); e.stopPropagation();
  toggleSelected(row);
}, true);

// ── RIGHT-CLICK MENU on any song row ─────────────────────────
document.addEventListener("contextmenu", e => {
  const row = e.target.closest("[data-song-path]");
  if (!row || row.classList.contains("q-row")) return;
  e.preventDefault();
  if (selecting()) { toggleSelected(row); return; }
  showSongMenu(row, e.clientX, e.clientY);
});

// Touch screens: long-press a song row opens the same menu
(function () {
  let timer = null, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener("touchstart", e => {
    const row = e.target.closest("[data-song-path]");
    if (!row || row.classList.contains("q-row") || e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; fired = false;
    timer = setTimeout(() => { fired = true; if (selecting()) toggleSelected(row); else showSongMenu(row, sx, sy); }, 550);
  }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (timer && Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10) cancel();
  }, { passive: true });
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  // the lift after a long-press must not also play the song
  document.addEventListener("click", e => {
    if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

function showSongMenu(row, x, y) {
  const song = { name: row.dataset.songName, path: row.dataset.songPath };

  document.getElementById("song-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "song-menu"; menu.className = "pl-popup";

  const item = (label, fn) => {
    const r = document.createElement("div");
    r.className = "pl-popup-row"; r.textContent = label;
    r.onclick = () => { menu.remove(); fn(); };
    menu.appendChild(r);
    return r;
  };
  item("Play next",        () => queueAdd(song, true));
  item("Add to queue",     () => queueAdd(song));
  item("Save to favorites…", () => showFavCategoryPopup(song,
    { getBoundingClientRect: () => ({ left: x, top: y, bottom: y }) }));

  if (typeof ringtoneAvailable === "function" && ringtoneAvailable()) item("Make ringtone…", () => openRingtoneMaker({ path: song.path, name: song.name }));
  if (canDeleteFromPhone(song.path)) item("Select multiple…", () => startSelecting(row));
  if (canDeleteFromPhone(song.path)) item("Delete from phone…", () => deleteSongFromPhone(song)).classList.add("pl-popup-danger");

  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth  - menu.offsetWidth  - 8) + "px";
  menu.style.top  = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
  setTimeout(() => document.addEventListener("mousedown", function h(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", h); }
  }), 0);
}



// ── COVER ART & METADATA ─────────────────────────────────────
// Reads ID3/MP4/Vorbis tags with music-metadata: embedded cover → album art, artist/album → subtitle,
// cover colour → the glow behind the player, and tags → better lyric lookups and OS media info.
const mm = (typeof require !== 'undefined' ? require("music-metadata") : null);
const metaCache = new Map();           // songPath → Promise<meta | null>
const COVER_FILES = ["cover", "folder", "front", "album", "albumart"].flatMap(n => [".jpg", ".jpeg", ".png"].map(e => n + e));
let currentMeta = null, coverUrl = null;

function getMeta(songPath) {
  if (!songPath) return Promise.resolve(null);
  if (!metaCache.has(songPath)) {
    // Check if AndroidBridge has track metadata
    if (window.AndroidBridge && window.AndroidBridge.allDeviceSongs) {
      const devSong = window.AndroidBridge.allDeviceSongs.find(s => s.path === songPath || s.contentUri === songPath);
      if (devSong) {
        const res = window.AndroidBridge.getArt(devSong, 512).then(url => ({
          title: devSong.title || "",
          artist: devSong.artist || "",
          album: devSong.album || "",
          year: null,
          picture: url ? { data: url, isDataUrl: true } : null
        }));
        metaCache.set(songPath, res);
        return res;
      }
    }

    let p;
    if (mm && mm.parseFile) {
      p = mm.parseFile(songPath, { duration: false }).then(m => {
        const c = m.common, pic = c.picture && c.picture[0];
        let picture = pic ? { data: pic.data, format: pic.format } : null;
        if (!picture && fs.existsSync) {
          const dir = path.dirname(songPath);
          const f = COVER_FILES.find(n => fs.existsSync(path.join(dir, n)));
          if (f) picture = { data: fs.readFileSync(path.join(dir, f)), format: /png$/i.test(f) ? "image/png" : "image/jpeg" };
        }
        return { title: c.title || "", artist: c.artist || (c.artists && c.artists[0]) || "",
                 album: c.album || "", year: c.year || null, picture };
      }).catch(() => null);
    } else if (window.jsmediatags) {
      p = new Promise(resolve => {
        try {
          window.jsmediatags.read(songPath, {
            onSuccess: tag => {
              const t = tag.tags || {};
              let picture = null;
              if (t.picture) {
                const { data, format } = t.picture;
                let base64 = "";
                for (let i = 0; i < data.length; i++) base64 += String.fromCharCode(data[i]);
                picture = { data: "data:" + format + ";base64," + btoa(base64), isDataUrl: true };
              }
              resolve({
                title: t.title || "",
                artist: t.artist || "",
                album: t.album || "",
                year: t.year || null,
                picture
              });
            },
            onError: () => resolve(null)
          });
        } catch { resolve(null); }
      });
    } else {
      p = Promise.resolve(null);
    }
    metaCache.set(songPath, p);
    if (metaCache.size > 40) metaCache.delete(metaCache.keys().next().value);
  }
  return metaCache.get(songPath);
}

// Tag text → lookup keys: "Kanave Unai (From "X")" → "Kanave Unai"; "A, B & C" → ["A, B & C", "A"]
function tagLyricsKeys(meta) {
  if (!meta || !meta.title) return null;
  const track = meta.title.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").replace(/\s*[-–;].*$/, "").trim() || meta.title;
  const first = (meta.artist || "").split(/,|&|;|\bfeat\.?|\bft\.?|\bx\b/i)[0].trim();
  const artists = [meta.artist, first].filter((a, i, arr) => a && arr.indexOf(a) === i);
  return { track, artists };
}

// Vibrant average colour of the cover, tuned to look good as a glow
function coverColor(img) {
  const N = 24, c = document.createElement("canvas"); c.width = c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  let R = 0, G = 0, B = 0, W = 0, r0 = 0, g0 = 0, b0 = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    r0 += r; g0 += g; b0 += b;
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2;
    const sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    const w = sat * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6) + 0.001;
    R += r * w; G += g * w; B += b * w; W += w;
  }
  const n = px.length / 4;
  let r = W > 0.5 ? R / W : r0 / n, g = W > 0.5 ? G / W : g0 / n, b = W > 0.5 ? B / W : b0 / n;
  // → HSL, then clamp so it is neither muddy nor neon
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, sl = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn; sl = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return `hsl(${Math.round(h)} ${Math.round(Math.min(0.8, Math.max(0.35, sl)) * 100)}% ${Math.round(Math.min(0.6, Math.max(0.45, l)) * 100)}%)`;
}

function applyCover(meta) {
  const art = document.getElementById("albumArt"), img = document.getElementById("coverImg");
  if (coverUrl && !coverUrl.startsWith("content:") && !coverUrl.startsWith("data:")) {
    URL.revokeObjectURL(coverUrl);
  }
  coverUrl = null;
  if (meta && meta.picture) {
    if (meta.picture.isUri || meta.picture.isDataUrl) {
      coverUrl = meta.picture.data;
    } else {
      coverUrl = URL.createObjectURL(new Blob([meta.picture.data], { type: meta.picture.format || "image/jpeg" }));
    }
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      if (!coverUrl || probe.src !== coverUrl) return;
      try { document.documentElement.style.setProperty("--glow", coverColor(probe)); } catch {}
    };
    probe.src = coverUrl;
    img.src = coverUrl;
    art.classList.add("has-cover");
  } else {
    img.removeAttribute("src");
    art.classList.remove("has-cover");
    document.documentElement.style.removeProperty("--glow");
  }
  window.coverUrl = coverUrl;
  if (window.updateMobileMiniPlayer) window.updateMobileMiniPlayer();
}

async function loadSongMeta(notify = true) {
  const songPath = currentSongPath;
  if (!songPath) return;
  const meta = await getMeta(songPath);
  if (songPath !== currentSongPath) return;          // song changed while reading
  currentMeta = meta;
  window.currentMeta = meta;
  applyCover(meta);
  const sub = meta ? [meta.artist, meta.album, meta.year].filter(Boolean).join(" · ") : "";
  if (sub) document.getElementById("songMeta").textContent = sub;
  updateMediaSession();
  if (notify) notifySongChange();
}

// ── MEDIA KEYS · SOUND MENU · NOTIFICATIONS ──────────────────
// navigator.mediaSession is picked up by Chromium and exposed to the OS (MPRIS on Linux), so
// keyboard media keys, the Mint sound-menu applet and `playerctl` all control this player.
const hasMediaSession = "mediaSession" in navigator;

function songAlbum() { return path.basename(path.dirname(currentSongPath || "")); }   // language folder

function updateMediaSession() {
  if (window.AndroidBridge) window.AndroidBridge.pushNativeMedia();     // notification + lock screen on Android
  if (!hasMediaSession || !currentSongPath) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: currentTitle,
    artist: (currentMeta && currentMeta.artist) || "",
    album: (currentMeta && currentMeta.album) || songAlbum(),
    artwork: coverUrl ? [{ src: coverUrl }] : [{ src: "icon.png", sizes: "256x256", type: "image/png" }]
  });
}
function syncMediaState(isPlaying) {
  if (window.AndroidBridge) window.AndroidBridge.pushNativeMedia(isPlaying);
  if (hasMediaSession) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}
function syncMediaPosition(position, duration) {
  if (!hasMediaSession || !duration || !isFinite(duration)) return;
  try { navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 }); } catch {}
}

if (hasMediaSession) {
  const ms = navigator.mediaSession;
  const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
  on("play",          () => { if (!sound || !sound.playing()) togglePlay(); });
  on("pause",         () => { if (sound && sound.playing()) togglePlay(); });
  on("stop",          () => stop());
  on("nexttrack",     () => next());
  on("previoustrack", () => prev());
  on("seekbackward",  d => seekRel(-(d.seekOffset || 5)));
  on("seekforward",   d => seekRel(d.seekOffset || 5));
  on("seekto",        d => { if (sound && d.seekTime != null) sound.seek(d.seekTime); });
}

// Desktop notification on song change — only when the window isn't in front
function notifySongChange() {
  if (document.hasFocus() || typeof Notification === "undefined") return;
  const sub = currentMeta ? [currentMeta.artist, currentMeta.album].filter(Boolean).join(" · ") : "";
  try {
    new Notification(currentTitle, {
      body: sub || songAlbum() || "Now playing",
      icon: coverUrl || path.join(baseDir, "icon.png"), silent: true
    });
  } catch {}
}

// ── MINI PLAYER ──────────────────────────────────────────────
let miniMode = false;
async function toggleMini() {
  miniMode = !miniMode;
  document.body.classList.toggle("mini", miniMode);
  const ipc = (typeof require !== 'undefined' ? require("electron").ipcRenderer : null) || window.electronShim.ipcRenderer;
  await ipc.invoke("set-mini", miniMode);
}
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMini(); }
  else if (e.key === "Escape" && miniMode && !document.querySelector(".dlg-overlay, #pl-prompt")) toggleMini();
});


// ── LANGUAGE FILTER ──────────────────────────────────────────
// A song's language is the library folder it lives under (Music/Tamil → "Tamil").
// Chips narrow the library, favorites and history; the queue and playlists stay as curated.
let langFilter = new Set();            // empty = All
try { langFilter = new Set(JSON.parse(localStorage.getItem("langFilter")) || []); } catch {}

let langsExpanded = false;
try { langsExpanded = localStorage.getItem("langsExpanded") === "1"; } catch {}

function libraryLanguages() {
  if (window.AndroidBridge && window.AndroidBridge.foldersMap && window.AndroidBridge.foldersMap.size > 0) {
    return Array.from(window.AndroidBridge.foldersMap.keys());
  }
  return (loadFolders() || []).map(f => path.basename(f)).filter((n, i, a) => a.indexOf(n) === i);
}
function languageOfFolder(root) { return path.basename(root); }
function languageOf(songPath) {
  if (window.AndroidBridge && window.AndroidBridge.allDeviceSongs) {
    const s = window.AndroidBridge.allDeviceSongs.find(song => song.path === songPath || song.contentUri === songPath);
    if (s && s.folder) return s.folder;
  }
  const roots = (loadFolders() || []).filter(r => songPath.startsWith(r + path.sep)).sort((a, b) => b.length - a.length);
  return roots.length ? path.basename(roots[0]) : path.basename(path.dirname(songPath));
}
function languageSelected(lang) { return !langFilter.size || langFilter.has(lang); }
function songVisible(songPath)  { return languageSelected(languageOf(songPath)); }

function saveLangFilter() {
  try { localStorage.setItem("langFilter", JSON.stringify([...langFilter])); } catch {}
}

function renderLangChips() {
  const wrap = document.getElementById("langChips");
  if (!wrap) return;
  const langs = libraryLanguages();
  [...langFilter].forEach(l => { if (!langs.includes(l)) langFilter.delete(l); });   // folder was removed
  wrap.innerHTML = "";
  wrap.style.display = "";

  const mk = (parent, cls, label, active, onClick) => {
    const b = document.createElement("button");
    b.className = cls + (active ? " active" : "");
    b.textContent = label;
    b.onclick = onClick;
    parent.appendChild(b);
    return b;
  };
  const bar = document.createElement("div");
  bar.className = "lang-bar";
  wrap.appendChild(bar);
  mk(bar, "lang-main", "All", langFilter.size === 0, () => { langFilter.clear(); applyLanguageFilter(); });
  mk(bar, "lang-main", langsExpanded ? "Collapse ▴" : "Expand ▾" + (langFilter.size ? ` (${langFilter.size})` : ""),
     langsExpanded || langFilter.size > 0, () => {
       langsExpanded = !langsExpanded;
       try { localStorage.setItem("langsExpanded", langsExpanded ? "1" : "0"); } catch {}
       renderLangChips();
     });

  if (langsExpanded) {
    if (langs.length > 0) {
      const list = document.createElement("div");
      list.className = "lang-list";
      wrap.appendChild(list);
      langs.forEach(l => mk(list, "lang-chip", l, langFilter.has(l), () => {
        if (langFilter.has(l)) langFilter.delete(l); else langFilter.add(l);
        if (langFilter.size === langs.length) langFilter.clear();   // everything picked = All
        applyLanguageFilter();
      }));
    }

    const actionRow = document.createElement("div");
    actionRow.className = "folder-btns";
    actionRow.innerHTML = `
      <button class="btn-ab folder-action-btn" onclick="if (window.AndroidBridge && !window.isElectron) window.AndroidBridge.scanMediaStore(); else addFolder();" title="Scan device music">🔍 Scan</button>
      <button class="btn-ab folder-action-btn" onclick="if (window.AndroidBridge && window.AndroidBridge.refreshSongs && !window.isElectron) window.AndroidBridge.refreshSongs(true, true); else if (window.reloadLibrary) window.reloadLibrary();" title="Refresh library and clear missing songs">🔄 Refresh</button>
      <button class="btn-ab folder-action-btn" onclick="if (window.addFolder) window.addFolder(); else if (window.AndroidBridge) window.AndroidBridge.pickFolderOrScan();" title="Add music folder or files">+ Add</button>
      <button class="btn-ab folder-action-btn" onclick="showFolderManager()">Manage</button>
    `;
    wrap.appendChild(actionRow);
  }
}

function applyLanguageFilter() {
  saveLangFilter();
  renderLangChips();
  if      (currentSection === "library")   reloadLibrary();
  else if (currentSection === "favorites") renderFavorites();
  else if (currentSection === "history")   renderHistory();
}

// Called at the end of reloadLibrary(): re-link the playing song, reapply search, open filtered folders
function afterLibraryReload() {
  if (currentSongPath) {
    const el = allSongElements.find(li => li.dataset.path === currentSongPath);
    if (el) { el.classList.add("active"); currentElement = el; }
  }
  if (langFilter.size) {
    document.querySelectorAll("#songList > li.folder-item").forEach(li => { if (!li.classList.contains("open")) li.click(); });
  }
  const q = document.getElementById("searchInput").value;
  if (q) filterSongs(q);
}


// ── FULL-SCREEN LYRICS ───────────────────────────────────────
// Big centred lyrics over the whole window (and the OS window goes full-screen too).
// Reads the same state as the side panel (lyricsMode / syncLines / activeSyncIdx), so it stays
// in step with fetching, song changes and the synced highlight without extra wiring.
let lyricsFsOpen = false, lyricsFsTimer = null, lyricsFsSig = "", lyricsFsIdx = -2, lyricsFsIdleTimer = null, lyricsFsSeeking = false;

function lyricsFsEl() { return document.getElementById("lyrics-fs"); }

function toggleLyricsFullscreen() { lyricsFsOpen ? closeLyricsFullscreen() : openLyricsFullscreen(); }

function openLyricsFullscreen() {
  if (lyricsFsOpen || miniMode) return;
  lyricsFsOpen = true;

  const el = document.createElement("div");
  el.id = "lyrics-fs";
  el.innerHTML = `
    <canvas class="lfs-viz"></canvas>
    <div class="lfs-top">
      <div class="lfs-who"><img class="lfs-cover" alt=""><div class="lfs-text"><div class="lfs-title"></div><div class="lfs-sub"></div></div></div>
      <button class="lfs-close" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <div class="lfs-scroll"><div class="lfs-lines"></div></div>
    <div class="lfs-bar">
      <div class="lfs-time"><span id="lfsLeft">0:00</span><span id="lfsRight">0:00</span></div>
      <input type="range" id="lfsSeek" min="0" max="100" step="0.1" value="0">
      <div class="lfs-ctl">
        <button class="btn-icon" id="lfsPrev" title="Previous"></button>
        <button class="btn-icon btn-play" id="lfsPlay" title="Play/Pause"></button>
        <button class="btn-icon" id="lfsNext" title="Next"></button>
      </div>
    </div>`;
  document.body.appendChild(el);

  const prevSvg = document.querySelector('.controls button[onclick="prev()"]').innerHTML;
  const nextSvg = document.querySelector('.controls button[onclick="next()"]').innerHTML;
  el.querySelector("#lfsPrev").innerHTML = prevSvg;
  el.querySelector("#lfsNext").innerHTML = nextSvg;
  el.querySelector(".lfs-close").onclick = closeLyricsFullscreen;
  el.querySelector("#lfsPrev").onclick = () => prev();
  el.querySelector("#lfsNext").onclick = () => next();
  el.querySelector("#lfsPlay").onclick = () => togglePlay();

  const seek = el.querySelector("#lfsSeek");
  seek.addEventListener("input",  () => { lyricsFsSeeking = true; });
  seek.addEventListener("change", () => {
    lyricsFsSeeking = false;
    if (sound && sound.duration()) sound.seek(seek.value / 100 * sound.duration());
  });

  // Controls fade away when the mouse is idle
  const wake = () => {
    el.classList.remove("idle");
    clearTimeout(lyricsFsIdleTimer);
    lyricsFsIdleTimer = setTimeout(() => el.classList.add("idle"), 3000);
  };
  el.addEventListener("mousemove", wake);
  wake();

  lyricsFsSig = ""; lyricsFsIdx = -2;
  lyricsFsTick();
  lyricsFsTimer = setInterval(lyricsFsTick, 250);
  requestAnimationFrame(() => el.classList.add("show"));
  if (typeof vizStart === "function") vizStart();
  const ipc = (typeof require !== 'undefined' ? require("electron").ipcRenderer : null) || window.electronShim.ipcRenderer;
  ipc.invoke("set-fullscreen", true).catch(() => {});
}

function closeLyricsFullscreen() {
  if (!lyricsFsOpen) return;
  lyricsFsOpen = false;
  clearInterval(lyricsFsTimer); clearTimeout(lyricsFsIdleTimer);
  const el = lyricsFsEl();
  if (el) { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }
  const ipc = (typeof require !== 'undefined' ? require("electron").ipcRenderer : null) || window.electronShim.ipcRenderer;
  ipc.invoke("set-fullscreen", false).catch(() => {});
}

function lyricsFsBuild(el) {
  const box = el.querySelector(".lfs-lines");
  box.innerHTML = "";
  box.className = "lfs-lines";
  const synced = lyricsMode === "sync" && syncLines.length;
  const plain  = document.getElementById("lyricsPanel").value.trim();

  if (synced) {
    syncLines.forEach((line, i) => {
      const d = document.createElement("div");
      d.className = "lfs-line"; d.textContent = line.text;
      d.onclick = () => { if (sound) sound.seek(line.time); };
      box.appendChild(d);
    });
  } else if (plain) {
    box.classList.add("plain");
    plain.split(/\n/).forEach(t => {
      const d = document.createElement("div");
      d.className = "lfs-line static"; d.textContent = t || " ";
      box.appendChild(d);
    });
  } else {
    box.classList.add("empty");
    box.innerHTML = `<div class="lfs-empty">No lyrics for this song yet.
      <button id="lfsFetch">Fetch lyrics</button></div>`;
    box.querySelector("#lfsFetch").onclick = () => onFetchLyrics();
  }
  lyricsFsIdx = -2;
  el.querySelector(".lfs-scroll").scrollTop = 0;
}

function lyricsFsTick() {
  const el = lyricsFsEl();
  if (!el) return;

  el.querySelector(".lfs-title").textContent = currentTitle || "";
  el.querySelector(".lfs-sub").textContent = currentMeta ? [currentMeta.artist, currentMeta.album].filter(Boolean).join(" · ") : "";
  const lc = el.querySelector(".lfs-cover");
  if ((coverUrl || "") !== (lc.dataset.src || "")) {
    lc.dataset.src = coverUrl || "";
    if (coverUrl) { lc.src = coverUrl; lc.style.display = "block"; } else { lc.removeAttribute("src"); lc.style.display = "none"; }
  }

  // Rebuild when the song or lyrics changed
  const panel = document.getElementById("lyricsPanel");
  const sig = [currentSongPath, lyricsMode, syncLines.length, panel.value.length].join("|");
  if (sig !== lyricsFsSig) { lyricsFsSig = sig; lyricsFsBuild(el); }

  // Active line + distance fade
  if (lyricsMode === "sync" && syncLines.length && activeSyncIdx !== lyricsFsIdx) {
    lyricsFsIdx = activeSyncIdx;
    const lines = el.querySelectorAll(".lfs-line");
    lines.forEach((d, i) => {
      d.style.setProperty("--d", Math.abs(i - lyricsFsIdx));
      d.classList.toggle("active", i === lyricsFsIdx);
    });
    const a = el.querySelector(".lfs-line.active");
    if (a) a.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Transport
  const playing = !!(sound && sound.playing());
  const pb = el.querySelector("#lfsPlay");
  const want = playing ? ICON_PAUSE : ICON_PLAY;
  if (pb.dataset.state !== (playing ? "p" : "s")) { pb.innerHTML = want; pb.dataset.state = playing ? "p" : "s"; }
  if (sound && !lyricsFsSeeking) {
    const d = sound.duration(), c = currentPosition();
    if (d) {
      const seek = el.querySelector("#lfsSeek");
      seek.value = (c / d) * 100;
      seek.style.setProperty("--progress", (c / d) * 100 + "%");
      el.querySelector("#lfsLeft").textContent  = formatTime(c);
      el.querySelector("#lfsRight").textContent = formatTime(d);
    }
  }
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Escape" && lyricsFsOpen) { e.preventDefault(); closeLyricsFullscreen(); }
  else if ((e.key === "l" || e.key === "L") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleLyricsFullscreen(); }
});


// ── SHUFFLE ──────────────────────────────────────────────────
// Library/favorites shuffle (playlists keep their own shuffle mode). Plays every song once in
// random order before reshuffling; "previous" walks back through what actually played.
let shuffleOn = false;
try { shuffleOn = localStorage.getItem("shuffleOn") === "1"; } catch {}
let shuffleBag = [], shuffleBagKey = "", shuffleTrail = [], shuffleGoingBack = false;
const SHUFFLE_TRAIL_MAX = 200;

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  try { localStorage.setItem("shuffleOn", shuffleOn ? "1" : "0"); } catch {}
  shuffleBag = []; shuffleBagKey = "";
  updateShuffleBtn();
  toast(shuffleOn ? "Shuffle on" : "Shuffle off");
}
function updateShuffleBtn() {
  const b = document.getElementById("shuffleBtn");
  if (b) b.classList.toggle("active", shuffleOn);
  const bm = document.getElementById("shuffleBtnMobile");
  if (bm) bm.classList.toggle("active", shuffleOn);
}

// What we shuffle: the favorites list if you're looking at it, otherwise the (language-filtered) library
function shufflePool() {
  if (currentSection === "favorites") {
    return { key: "fav|" + [...langFilter].join(","),
             songs: loadFavorites().filter(f => songVisible(f.path)).map(f => ({ name: f.name, path: f.path })) };
  }
  return { key: "lib|" + [...langFilter].join(","),
           songs: allSongElements.map(li => ({ name: li.dataset.songName, path: li.dataset.path })) };
}

function refillShuffleBag(pool) {
  const songs = pool.songs.filter(s => s.path !== currentSongPath);   // never repeat the song just played
  for (let i = songs.length - 1; i > 0; i--) {                         // Fisher–Yates
    const j = Math.floor(Math.random() * (i + 1));
    [songs[i], songs[j]] = [songs[j], songs[i]];
  }
  shuffleBag = songs;
  shuffleBagKey = pool.key;
}

function playShuffled(song) {
  const el = allSongElements.find(li => li.dataset.path === song.path);
  playlistMode = false; activePlaylistId = null; updatePlaylistBadge();
  playSongFromTree({ name: path.basename(song.path), path: song.path }, el && document.contains(el) ? el : null);
}

// wrap=false: stop when everything has played once (Repeat off). Returns false if nothing was played.
function shufflePlayNext(wrap) {
  const pool = shufflePool();
  if (!pool.songs.length) return false;
  if (pool.key !== shuffleBagKey) refillShuffleBag(pool);
  // Drop songs that vanished from the pool (e.g. folder removed)
  const known = new Set(pool.songs.map(s => s.path));
  shuffleBag = shuffleBag.filter(s => known.has(s.path));
  if (!shuffleBag.length) {
    if (!wrap) { shuffleBagKey = ""; return false; }
    refillShuffleBag(pool);
    if (!shuffleBag.length) { playShuffled(pool.songs[0]); return true; }   // single-song pool
  }
  playShuffled(shuffleBag.shift());
  return true;
}

function shufflePlayPrev() {
  if (shuffleTrail.length > 1) {
    shuffleTrail.pop();                                // the song playing now
    const back = shuffleTrail[shuffleTrail.length - 1];
    shuffleGoingBack = true;
    playShuffled(back);
    shuffleGoingBack = false;
  } else if (sound) {
    sound.seek(0);                                     // nothing earlier: restart this one
  }
}

// Hook from onSongStarted: keep the trail and bag in step, however the song was started
function shuffleNoteStarted(song) {
  if (!shuffleGoingBack) {
    if (shuffleTrail[shuffleTrail.length - 1]?.path !== song.path) {
      shuffleTrail.push({ name: song.name, path: song.path });
      if (shuffleTrail.length > SHUFFLE_TRAIL_MAX) shuffleTrail.shift();
    }
  }
  shuffleBag = shuffleBag.filter(s => s.path !== song.path);
}

// Ctrl+S toggles shuffle
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); toggleShuffle(); }
});

// ── INIT ─────────────────────────────────────────────────────
window.afterLibraryReload = afterLibraryReload;
window.toast = toast;
updateShuffleBtn();
renderLangChips();
saveQueue();   // paints the badge


// ── PLAYER MENU: Equalizer + accent colour ───────────────────
const ACCENT_PRESETS = ["#7c5cfc", "#22c55e", "#ef4444", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6", "#f97316"];

function showPlayerMenu(anchor) {
  const old = document.getElementById("player-menu");
  if (old) { old.remove(); return; }
  const menu = document.createElement("div");
  menu.id = "player-menu";
  menu.className = "pl-popup";

  const eqRow = document.createElement("div");
  eqRow.className = "pl-popup-row";
  eqRow.innerHTML = '<span>Equalizer</span><small>' + (eqActive() ? "On" : "Off") + '</small>';
  eqRow.onclick = () => { menu.remove(); showEqPanel(anchor); };
  menu.appendChild(eqRow);

  // Additional options (especially useful for clean mobile UI)
  const sleepRow = document.createElement("div");
  sleepRow.className = "pl-popup-row";
  sleepRow.innerHTML = '<span>Sleep Timer</span>';
  sleepRow.onclick = () => { menu.remove(); if (typeof showSleepTimer === 'function') showSleepTimer(); };
  menu.appendChild(sleepRow);

  const vizRow = document.createElement("div");
  vizRow.className = "pl-popup-row";
  vizRow.innerHTML = '<span>Visualizer</span>';
  vizRow.onclick = () => { menu.remove(); if (typeof cycleViz === 'function') cycleViz(); };
  menu.appendChild(vizRow);

  const plRow = document.createElement("div");
  plRow.className = "pl-popup-row";
  plRow.innerHTML = '<span>Add to Playlist</span>';
  plRow.onclick = () => { menu.remove(); if (typeof showAddToPlaylistPopup === 'function') showAddToPlaylistPopup(); };
  menu.appendChild(plRow);

  const ringRow = document.createElement("div");
  ringRow.className = "pl-popup-row";
  ringRow.innerHTML = '<span>Make Ringtone</span>';
  ringRow.onclick = () => { menu.remove(); if (typeof openRingtoneMakerForCurrent === 'function') openRingtoneMakerForCurrent(); };
  menu.appendChild(ringRow);

  const label = document.createElement("div");
  label.className = "pm-label";
  label.textContent = "Accent colour";
  menu.appendChild(label);

  const sw = document.createElement("div");
  sw.className = "pm-swatches";
  let current = "";
  try { current = (localStorage.getItem("accent") || "#7c5cfc").toLowerCase(); } catch {}
  const mark = c => sw.querySelectorAll(".pm-swatch").forEach(b => b.classList.toggle("sel", b.dataset.c === c.toLowerCase()));
  ACCENT_PRESETS.forEach(c => {
    const b = document.createElement("button");
    b.className = "pm-swatch"; b.dataset.c = c; b.style.background = c; b.setAttribute("aria-label", c);
    b.onclick = () => { changeTheme(c); mark(c); };
    sw.appendChild(b);
  });
  const custom = document.createElement("input");
  custom.type = "color"; custom.value = current; custom.title = "Custom colour";
  custom.oninput = () => { changeTheme(custom.value); mark(custom.value); };
  sw.appendChild(custom);
  menu.appendChild(sw);
  mark(current);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
  setTimeout(() => document.addEventListener("mousedown", function h(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", h); }
  }), 0);
}
window.showPlayerMenu = showPlayerMenu;


// ── FADE OUT WHEN SKIPPING ───────────────────────────────────
// Next / Previous (buttons, swipe, notification, headset) ease the current song out before switching.
const SKIP_FADE_MS = 350;
let skipTimer = null, skipPending = [];

function skipWithFade(fn) {
  skipPending.push(fn);
  if (skipTimer) return;                                  // already fading: this skip runs right after the fade
  const s = sound;
  if (!s || !s.playing()) { const q = skipPending; skipPending = []; q.forEach(f => f()); return; }
  const vol = s.volume();
  s.fade(vol, 0, SKIP_FADE_MS);
  skipTimer = setTimeout(() => {
    skipTimer = null;
    const q = skipPending; skipPending = [];
    q.forEach(f => f());
    if (sound === s && s.playing()) s.volume(vol);        // nothing replaced it (e.g. end of list): bring the sound back
  }, SKIP_FADE_MS + 30);
}

const nextNoFade = next, prevNoFade = prev;
next = function () { skipWithFade(nextNoFade); };
prev = function () { skipWithFade(prevNoFade); };
window.next = next; window.prev = prev;


// ── SKIP SILENCE + GAPLESS HAND-OVER ─────────────────────────
// Each song is decoded once at a low sample rate to find the silence at its start and end. The start is jumped
// over, and the song hands over to the next one as soon as the music itself ends (or ~0.1 s early when there is
// no silence, to cover the time the next file needs to open).
const SMOOTH_KEY = "mp_skip_silence";
const SMOOTH_THRESHOLD = 0.01;          // ≈ -40 dB
const SMOOTH_MAX_BYTES = 40 * 1024 * 1024;
const smoothCache = new Map();          // path → Promise<{lead, trail} | null>
let smoothCur = null, smoothHandled = false;

function smoothEnabled() { try { return localStorage.getItem(SMOOTH_KEY) !== "0"; } catch { return true; } }
function setSmoothEnabled(on) { try { localStorage.setItem(SMOOTH_KEY, on ? "1" : "0"); } catch {} }

function smoothAnalyze(rawPath) {
  if (smoothCache.has(rawPath)) return smoothCache.get(rawPath);
  const job = (async () => {
    try {
      const src = window.getPlayableAudioSrc ? window.getPlayableAudioSrc(rawPath) : rawPath;
      const res = await fetch(src);
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length")) || 0;
      if (len > SMOOTH_MAX_BYTES) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > SMOOTH_MAX_BYTES) return null;
      const rate = 8000;
      const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buf);
      const d = audio.getChannelData(0);
      let first = 0, last = d.length - 1;
      while (first < d.length && Math.abs(d[first]) < SMOOTH_THRESHOLD) first++;
      if (first >= d.length) return null;           // all silent: leave it alone
      while (last > first && Math.abs(d[last]) < SMOOTH_THRESHOLD) last--;
      return { lead: first / rate, trail: (d.length - 1 - last) / rate };
    } catch { return null; }
  })();
  smoothCache.set(rawPath, job);
  if (smoothCache.size > 200) smoothCache.delete(smoothCache.keys().next().value);
  return job;
}

function smoothSongStarted(song) {
  smoothCur = null; smoothHandled = false;
  if (!smoothEnabled()) return;
  const raw = song.contentUri || song.path;
  const s = sound;
  smoothAnalyze(raw).then(info => {
    if (!info || sound !== s || (currentSongPath !== raw)) return;
    smoothCur = info;
    const pos = Number(s.seek()) || 0;
    if (info.lead > 0.4 && pos < info.lead - 0.1 && loopA === null) s.seek(Math.max(0, info.lead - 0.1));
  });
  // get the next song's analysis ready so its own start is skipped without a delay
  try {
    const items = Array.from(document.querySelectorAll(".song-item"));
    const i = items.findIndex(li => li === currentElement);
    const nxt = i >= 0 ? items[(i + 1) % items.length] : null;
    if (nxt && nxt.dataset.path) smoothAnalyze(nxt.dataset.path);
  } catch {}
}

setInterval(() => {
  if (!smoothCur || smoothHandled || !sound || !smoothEnabled() || loopA !== null) return;
  if (!sound.playing()) return;
  const dur = sound.duration(), pos = Number(sound.seek());
  if (!dur || !isFinite(pos)) return;
  const endAt = smoothCur.trail > 0.5 ? dur - smoothCur.trail + 0.15 : dur - 0.1;
  if (pos < endAt || endAt < 1) return;
  smoothHandled = true;
  const s = sound;
  s.stop();                       // we are the ones ending it; skip Howler's own "end"
  handleSongEnd();
}, 150);


// ── "More" options button in the player ──────────────────────
function toggleMoreControls(force) {
  const g = document.getElementById("moreGroup"), b = document.getElementById("moreBtn");
  if (!g || !b) return;
  const open = typeof force === "boolean" ? force : !g.classList.contains("open");
  g.classList.toggle("open", open);
  b.classList.toggle("open", open);
  b.textContent = open ? "More ▴" : "More ▾";
  b.setAttribute("aria-expanded", open);
  try { localStorage.setItem("mp_more_open", open ? "1" : "0"); } catch {}
}
try { if (localStorage.getItem("mp_more_open") === "1") toggleMoreControls(true); } catch {}
