// Library tools: Backup & restore · Duplicate finder
// Loaded after extras.js (shares its top-level state and helpers).

const nodeCrypto = require("crypto");
const { ipcRenderer, shell } = require("electron");

const readJsonFile  = (file, def) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; } };
const writeJsonFile = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const dataPath      = name => path.join(__dirname, name);

// ═════════════════════════════════════════════════════════════
// BACKUP & RESTORE
// ═════════════════════════════════════════════════════════════
const BACKUP_APP = "serien-music-player-backup";
const SETTINGS_KEYS = ["queue", "lastPlayed", "langFilter", "shuffleOn", "fadeOn",
                       "sidebarCollapsed", "lyricsCollapsed", "accent", "theme", "dupIgnored", "eq", "eqPresets", "vizMode"];

function buildBackup() {
  const settings = {};
  SETTINGS_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) settings[k] = v; } catch {} });
  return {
    app: BACKUP_APP, version: 1, createdAt: new Date().toISOString(),
    data: {
      favorites:          loadFavorites(),
      favoriteCategories: readJsonFile(favCatsFile, []),
      playlists:          loadPlaylists(),
      lyrics:             readJsonFile(lyricsFile, {}),
      history:            playHistory,
      folders:            loadFolders() || []
    },
    settings
  };
}

function validateBackup(b) {
  if (!b || (b.app !== BACKUP_APP && b.app !== "music-player-backup") || !b.data) return "This isn't a Serien Music Player backup file.";
  if (b.version > 1) return "This backup was made by a newer version of the app.";
  return null;
}

function summarizeBackup(b) {
  const d = b.data;
  return {
    favorites: (d.favorites || []).length,
    categories: (d.favoriteCategories || []).length,
    playlists: (d.playlists || []).length,
    lyrics: Object.keys(d.lyrics || {}).length,
    recent: ((d.history || {}).recent || []).length,
    folders: (d.folders || []).length
  };
}

// ── path remapping (backup made elsewhere → music lives somewhere else now) ──
const normSlash = p => String(p).replace(/\\/g, "/");

function backupPaths(b) {
  const d = b.data, out = [];
  (d.favorites || []).forEach(f => out.push(f.path));
  (d.playlists || []).forEach(pl => (pl.songs || []).forEach(s => out.push(s.path)));
  Object.keys(d.lyrics || {}).forEach(k => out.push(k));
  ((d.history || {}).recent || []).forEach(r => out.push(r.path));
  Object.keys((d.history || {}).plays || {}).forEach(k => out.push(k));
  (d.folders || []).forEach(f => out.push(f));
  return out.filter(Boolean);
}

// Deepest directory that contains every path
function commonDirPrefix(paths) {
  if (!paths.length) return "";
  const split = paths.map(p => normSlash(p).split("/"));
  const first = split[0]; let n = first.length - 1;               // never include the file name itself
  for (const s of split) { let i = 0; while (i < n && i < s.length - 1 && s[i].toLowerCase() === first[i].toLowerCase()) i++; n = i; }
  return first.slice(0, n).join("/");
}

// Where the backup's music lived: the common parent of its library folders (else of all its songs)
function detectMusicPrefix(b) {
  const roots = (b.data.folders || []).filter(Boolean);
  return commonDirPrefix(roots.length ? roots : backupPaths(b));
}

function mapPathPrefix(p, from, to) {
  if (!from || typeof p !== "string") return p;
  const n = normSlash(p), f = normSlash(from).replace(/\/$/, "");
  if (n.toLowerCase() === f.toLowerCase()) return to;
  if (!n.toLowerCase().startsWith(f.toLowerCase() + "/")) return p;
  let out = normSlash(to).replace(/\/$/, "") + n.slice(f.length);
  return path.sep === "\\" ? out.replace(/\//g, "\\") : out;
}

// Rewrite every path inside a backup object (returns a copy)
function rewriteBackupPaths(b, fn) {
  const c = JSON.parse(JSON.stringify(b)), d = c.data;
  d.favorites = (d.favorites || []).map(f => ({ ...f, path: fn(f.path) }));
  d.playlists = (d.playlists || []).map(pl => ({ ...pl, songs: (pl.songs || []).map(s => ({ ...s, path: fn(s.path) })) }));
  d.lyrics = Object.fromEntries(Object.entries(d.lyrics || {}).map(([k, v]) => [fn(k), v]));
  const h = d.history || { recent: [], plays: {} };
  h.recent = (h.recent || []).map(r => ({ ...r, path: fn(r.path) }));
  h.plays  = Object.fromEntries(Object.entries(h.plays || {}).map(([k, v]) => [fn(k), v]));
  d.history = h;
  d.folders = (d.folders || []).map(fn);
  const s = c.settings || {};
  try { if (s.queue)      s.queue      = JSON.stringify(JSON.parse(s.queue).map(q => ({ ...q, path: fn(q.path) }))); } catch {}
  try { if (s.lastPlayed) { const lp = JSON.parse(s.lastPlayed); lp.path = fn(lp.path); s.lastPlayed = JSON.stringify(lp); } } catch {}
  return c;
}

// ── merge: keep what's here, add what the backup has that's missing ──
function mergeBackups(cur, inc) {
  const a = cur.data, b = inc.data;
  const out = JSON.parse(JSON.stringify(cur));
  const d = out.data;

  const favPaths = new Set((a.favorites || []).map(f => f.path));
  d.favorites = [...(a.favorites || []), ...(b.favorites || []).filter(f => !favPaths.has(f.path))];
  d.favoriteCategories = [...new Set([...(a.favoriteCategories || []), ...(b.favoriteCategories || [])])];

  const byId = new Map((a.playlists || []).map(pl => [pl.id, pl]));
  (b.playlists || []).forEach(pl => {
    const mine = byId.get(pl.id);
    if (!mine) { byId.set(pl.id, pl); return; }
    const have = new Set((mine.songs || []).map(s => s.path));
    mine.songs = [...(mine.songs || []), ...(pl.songs || []).filter(s => !have.has(s.path))];
  });
  d.playlists = [...byId.values()];

  d.lyrics = { ...(b.lyrics || {}), ...(a.lyrics || {}) };           // existing lyrics win

  const ha = a.history || { recent: [], plays: {} }, hb = b.history || { recent: [], plays: {} };
  const recent = new Map();
  [...(ha.recent || []), ...(hb.recent || [])].forEach(r => { const o = recent.get(r.path); if (!o || r.at > o.at) recent.set(r.path, r); });
  const plays = { ...(hb.plays || {}) };
  Object.entries(ha.plays || {}).forEach(([k, v]) => { plays[k] = plays[k] ? { ...v, count: Math.max(v.count, plays[k].count), last: Math.max(v.last || 0, plays[k].last || 0) } : v; });
  d.history = { recent: [...recent.values()].sort((x, y) => y.at - x.at).slice(0, HISTORY_MAX), plays };

  d.folders = [...new Set([...(a.folders || []), ...(b.folders || [])])];
  // settings stay as they are here (a merge shouldn't change how the app looks/behaves)
  return out;
}

function applyBackup(b) {
  const d = b.data;
  writeJsonFile(favoritesFile, d.favorites || []);
  writeJsonFile(favCatsFile,   d.favoriteCategories || []);
  writeJsonFile(playlistsFile, d.playlists || []);
  writeJsonFile(lyricsFile,    d.lyrics || {});
  writeJsonFile(historyFile,   d.history || { recent: [], plays: {} });
  writeJsonFile(FOLDERS_FILE,  d.folders || []);
  SETTINGS_KEYS.forEach(k => {
    try {
      if (b.settings && k in b.settings) localStorage.setItem(k, b.settings[k]); else localStorage.removeItem(k);
    } catch {}
  });
}

function writeSafetyCopy() {
  const dir = dataPath("backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `before-import-${stamp}.json`);
  writeJsonFile(file, buildBackup());
  return file;
}

// ── modal helper ─────────────────────────────────────────────
function openModal(title, wide = false) {
  const overlay = document.createElement("div");
  overlay.className = "dlg-overlay";
  const box = document.createElement("div");
  box.className = "dlg-box" + (wide ? " wide" : "");
  const head = document.createElement("div");
  head.className = "dlg-head";
  head.innerHTML = `<div class="dlg-title"></div><button class="dlg-x" title="Close">✕</button>`;
  head.querySelector(".dlg-title").textContent = title;
  const body = document.createElement("div");
  body.className = "dlg-body";
  box.append(head, body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  head.querySelector(".dlg-x").onclick = close;
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
  const esc = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc, true); e.stopPropagation(); } };
  document.addEventListener("keydown", esc, true);
  return { box, body, close };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function showBackupDialog() {
  const { body, close } = openModal("Backup & restore");

  // — export —
  const ex = el("div", "dlg-section");
  ex.append(el("div", "dlg-h", "Export"),
            el("div", "dlg-p", "Saves your favorites, playlists, lyrics, history, folders and settings to one file. Your music files are not included."));
  const exBtn = el("button", "dlg-btn dlg-btn-primary", "Export backup…");
  exBtn.onclick = async () => {
    const name = `serien-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = await ipcRenderer.invoke("save-file-dialog", { name, filters: [{ name: "Backup", extensions: ["json"] }] });
    if (!file) return;
    try { writeJsonFile(file, buildBackup()); toast("Backup saved"); } catch (e) { toast("Couldn't save: " + e.message); }
  };
  ex.append(exBtn);

  // — import —
  const im = el("div", "dlg-section");
  im.append(el("div", "dlg-h", "Import"),
            el("div", "dlg-p", "Restore from a backup file. A safety copy of your current data is saved first."));
  const imBtn = el("button", "dlg-btn", "Choose backup file…");
  const area = el("div", "dlg-import");
  imBtn.onclick = async () => {
    const file = await ipcRenderer.invoke("open-file-dialog", { filters: [{ name: "Backup", extensions: ["json"] }] });
    if (!file) return;
    let b;
    try { b = JSON.parse(fs.readFileSync(file, "utf8")); } catch { area.replaceChildren(el("div", "dlg-err", "That file couldn't be read as a backup.")); return; }
    const err = validateBackup(b);
    if (err) { area.replaceChildren(el("div", "dlg-err", err)); return; }
    renderImportOptions(area, b, close);
  };
  im.append(imBtn, area);

  body.append(ex, im);
}

function renderImportOptions(area, backup, closeDialog) {
  const sum = summarizeBackup(backup);
  const when = backup.createdAt ? new Date(backup.createdAt).toLocaleString() : "unknown date";
  area.replaceChildren();
  area.append(el("div", "dlg-sum",
    `Backup from ${when}\n${sum.favorites} favorites in ${sum.categories} categories · ${sum.playlists} playlists · ${sum.lyrics} lyrics · ${sum.recent} recent plays · ${sum.folders} folders`));

  // Music folder mapping — only if the backup's music isn't where it says it is
  const oldPrefix = detectMusicPrefix(backup);
  const missing = oldPrefix && !fs.existsSync(oldPrefix);
  let newPrefix = "";
  if (missing) {
    const row = el("div", "dlg-map");
    row.append(el("div", "dlg-p", `This backup's music was in "${oldPrefix}", which doesn't exist here. Where is that folder now?`));
    const pick = el("button", "dlg-btn", "Choose folder…");
    const shown = el("span", "dlg-picked", "(keep paths as they are)");
    pick.onclick = async () => {
      const f = await ipcRenderer.invoke("open-folder-dialog");
      if (f) { newPrefix = f; shown.textContent = f; }
    };
    row.append(pick, shown);
    area.append(row);
  }

  const mode = el("div", "dlg-mode");
  mode.innerHTML = `
    <label><input type="radio" name="impmode" value="merge" checked> <b>Merge</b> — keep what I have, add what's missing</label>
    <label><input type="radio" name="impmode" value="replace"> <b>Replace</b> — make everything match the backup</label>`;
  area.append(mode);

  const go = el("button", "dlg-btn dlg-btn-primary", "Restore");
  go.onclick = () => {
    const replace = mode.querySelector("input:checked").value === "replace";
    if (replace && !window.confirm("Replace your current favorites, playlists, lyrics and history with this backup?")) return;
    try {
      const safety = writeSafetyCopy();
      let incoming = backup;
      if (missing && newPrefix) incoming = rewriteBackupPaths(backup, p => mapPathPrefix(p, oldPrefix, newPrefix));
      const final = replace ? incoming : mergeBackups(buildBackup(), incoming);
      applyBackup(final);
      closeDialog();
      toast("Restored — reloading…");
      console.log("Safety copy:", safety);
      setTimeout(() => location.reload(), 600);
    } catch (e) { area.append(el("div", "dlg-err", "Restore failed: " + e.message)); }
  };
  area.append(go);
}

// ═════════════════════════════════════════════════════════════
// DUPLICATE FINDER
// ═════════════════════════════════════════════════════════════
const AUDIO_FILE = /\.(mp3|wav|m4a|flac|ogg|aac)$/i;
const DUP_DURATION_TOLERANCE = 3;      // seconds
const tickUI = () => new Promise(r => setTimeout(r, 0));   // let the dialog repaint between files

function listAudioFiles(roots) {
  const out = [], seen = new Set();
  roots.forEach(r => { if (fs.existsSync(r)) (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO_FILE.test(e.name) && !seen.has(p)) {
        seen.add(p);
        try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtime: st.mtimeMs }); } catch {}
      }
    }
  })(r); });
  return out;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = nodeCrypto.createHash("sha1");
    fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

const techCache = new Map();
async function getTech(file) {
  if (!techCache.has(file)) {
    techCache.set(file, mm.parseFile(file, { duration: true }).then(m => ({
      duration: m.format.duration || 0, bitrate: m.format.bitrate || 0,
      lossless: !!m.format.lossless, codec: m.format.codec || ""
    })).catch(() => ({ duration: 0, bitrate: 0, lossless: false, codec: "" })));
  }
  return techCache.get(file);
}

// "Song (feat. X) [Official Video]" → "song"
function normKey(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
    .replace(/\b(feat|ft|featuring)\b.*$/, " ")
    .replace(/\b(official|lyrical|lyrics?|video|audio|hd|4k|full song|music video)\b/g, " ")
    .replace(/[^a-z0-9ऀ-෿]+/g, " ").trim();
}
const GENERIC_KEYS = new Set(["", "track", "audio", "untitled", "unknown", "song", "intro"]);
const usableKey = k => k && !GENERIC_KEYS.has(k) && k.length >= 3 && !/^\d+$/.test(k);

function songKeys(file, meta) {
  const keys = new Set();
  const name = normKey(stripExt(path.basename(file)));
  if (usableKey(name)) keys.add(name);
  if (meta && meta.title) {
    const t = normKey(meta.title), a = normKey((meta.artist || "").split(/,|&|;/)[0]);
    if (usableKey(t) && a) { keys.add(t + "|" + a); keys.add(t + " " + a); keys.add(a + " " + t); }
  }
  return keys;
}

// Union–find over file indexes
class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

const dupSignature = files => files.map(f => f.path).sort().join("\n");
function loadDupIgnored() { try { return new Set(JSON.parse(localStorage.getItem("dupIgnored")) || []); } catch { return new Set(); } }
function saveDupIgnored(set) { try { localStorage.setItem("dupIgnored", JSON.stringify([...set])); } catch {} }

async function scanDuplicates(onProgress) {
  const roots = loadFolders() || [];
  const files = listAudioFiles(roots);
  onProgress(`Found ${files.length} songs. Comparing file sizes…`);
  const dsu = new DSU(files.length);
  const hash = new Array(files.length).fill(null);

  // 1 ── identical bytes: same size, then same SHA-1
  const bySize = new Map();
  files.forEach((f, i) => { if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(i); });
  const sameSize = [...bySize.values()].filter(g => g.length > 1);
  let done = 0, toHash = sameSize.reduce((n, g) => n + g.length, 0);
  for (const g of sameSize) {
    const byHash = new Map();
    for (const i of g) {
      try { hash[i] = await hashFile(files[i].path); } catch { continue; }
      if (!byHash.has(hash[i])) byHash.set(hash[i], []);
      byHash.get(hash[i]).push(i);
      onProgress(`Checking for identical files… ${++done}/${toHash}`);
      if (done % 4 === 0) await tickUI();
    }
    byHash.forEach(idx => idx.slice(1).forEach(i => dsu.union(idx[0], i)));
  }

  // 2 ── same song: matching name or tags
  onProgress("Reading song tags…");
  const metas = [];
  for (let i = 0; i < files.length; i++) {
    metas[i] = await getMeta(files[i].path);
    if (i % 10 === 0) { onProgress(`Reading song tags… ${i + 1}/${files.length}`); await tickUI(); }
  }
  const byKey = new Map();
  files.forEach((f, i) => songKeys(f.path, metas[i]).forEach(k => {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }));
  byKey.forEach(idx => idx.slice(1).forEach(i => dsu.union(idx[0], i)));

  // clusters of 2+
  const clusters = new Map();
  files.forEach((f, i) => { const r = dsu.find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(i); });
  const candidates = [...clusters.values()].filter(c => c.length > 1);

  // 3 ── length check splits look-alikes (live vs studio, different songs with the same title)
  const groups = [];
  let n = 0;
  for (const c of candidates) {
    onProgress(`Checking song lengths… ${++n}/${candidates.length}`);
    const tech = await Promise.all(c.map(i => getTech(files[i].path)));
    if (n % 5 === 0) await tickUI();
    // identical-hash members must stay together regardless of tech
    const items = c.map((i, k) => ({ i, t: tech[k] })).sort((x, y) => x.t.duration - y.t.duration);
    const sub = [];
    items.forEach(it => {
      const last = sub[sub.length - 1];
      const prev = last && last[last.length - 1];
      const sameHash = last && last.some(o => hash[o.i] && hash[o.i] === hash[it.i]);
      if (last && (sameHash || !it.t.duration || !prev.t.duration || Math.abs(it.t.duration - prev.t.duration) <= DUP_DURATION_TOLERANCE)) last.push(it);
      else sub.push([it]);
    });
    sub.filter(s => s.length > 1).forEach(s => {
      const members = s.map(({ i, t }) => ({
        path: files[i].path, size: files[i].size, mtime: files[i].mtime, hash: hash[i],
        duration: t.duration, bitrate: t.bitrate, lossless: t.lossless,
        hasArt: !!(metas[i] && metas[i].picture), hasTags: !!(metas[i] && metas[i].title && metas[i].artist),
        title: metas[i] && metas[i].title, artist: metas[i] && metas[i].artist
      }));
      const exact = members.every(m => m.hash && m.hash === members[0].hash);
      groups.push({ exact, files: members, keep: suggestKeep(members, exact),
                    name: (members.find(m => m.title) || {}).title || stripExt(path.basename(members[0].path)) });
    });
  }
  const ignored = loadDupIgnored();
  return groups.filter(g => !ignored.has(dupSignature(g.files)))
               .sort((a, b) => (b.exact - a.exact) || (b.files.length - a.files.length));
}

// The copy worth keeping: best quality, then tags/art, then the oldest file
function suggestKeep(members, exact) {
  const score = m => (m.lossless ? 200 : 0) + (m.bitrate || 0) / 1000 + (m.hasArt ? 40 : 0) + (m.hasTags ? 30 : 0) + m.size / 1e7;
  const ranked = [...members].sort((a, b) => exact ? (a.mtime - b.mtime) || (a.path.length - b.path.length) : score(b) - score(a));
  return ranked[0].path;
}

// ── repoint references from removed files to the kept file ──
function repointPaths(map) {
  const fix = p => (map.has(p) ? map.get(p) : p);
  const nameOf = p => stripExt(path.basename(p));

  // favorites: switch path (and name); if the kept file is already a favorite, drop the extra entry
  const favs = [], seen = new Set();
  loadFavorites().forEach(f => {
    const np = fix(f.path);
    if (seen.has(np)) return;
    seen.add(np);
    favs.push(np === f.path ? f : { ...f, path: np, name: nameOf(np) });
  });
  saveFavorites(favs);

  // playlists
  savePlaylists(loadPlaylists().map(pl => {
    const s2 = new Set();
    return { ...pl, songs: (pl.songs || []).map(s => { const np = fix(s.path); return np === s.path ? s : { ...s, path: np, name: nameOf(np) }; })
                                           .filter(s => !s2.has(s.path) && s2.add(s.path)) };
  }));

  // lyrics: move saved lyrics over unless the kept file already has its own
  const lyr = readJsonFile(lyricsFile, {});
  Object.keys(lyr).forEach(k => { const np = fix(k); if (np !== k) { if (!lyr[np]) lyr[np] = lyr[k]; delete lyr[k]; } });
  writeJsonFile(lyricsFile, lyr);

  // history (file + in-memory copy)
  const recent = new Map();
  playHistory.recent.forEach(r => { const np = fix(r.path); const o = recent.get(np); if (!o || r.at > o.at) recent.set(np, np === r.path ? r : { ...r, path: np, name: nameOf(np) }); });
  playHistory.recent = [...recent.values()].sort((a, b) => b.at - a.at);
  const plays = {};
  Object.entries(playHistory.plays).forEach(([k, v]) => {
    const np = fix(k);
    plays[np] = plays[np] ? { name: plays[np].name, count: plays[np].count + v.count, last: Math.max(plays[np].last || 0, v.last || 0) } : (np === k ? v : { ...v, name: nameOf(np) });
  });
  playHistory.plays = plays;
  saveHistory();

  // queue, last played, current song, shuffle state, caches
  queue = queue.map(q => (map.has(q.path) ? { name: nameOf(map.get(q.path)), path: map.get(q.path) } : q));
  saveQueue();
  try {
    const lp = JSON.parse(localStorage.getItem(LAST_PLAYED_KEY));
    if (lp && map.has(lp.path)) { lp.path = map.get(lp.path); lp.name = nameOf(lp.path); localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(lp)); }
  } catch {}
  if (map.has(currentSongPath)) { currentSongPath = map.get(currentSongPath); currentTitle = nameOf(currentSongPath); updateNowPlaying(); }
  shuffleBag = []; shuffleBagKey = ""; shuffleTrail = shuffleTrail.filter(t => !map.has(t.path));
  map.forEach((_, k) => { metaCache.delete(k); techCache.delete(k); });
}

// Move the extra copies to the system Trash and point everything at the kept one
async function cleanupGroup(group, keepPath) {
  const remove = group.files.filter(f => f.path !== keepPath);
  const map = new Map(), failed = [];
  for (const f of remove) {
    if (f.path === currentSongPath && sound) { sound.stop(); sound.unload(); sound = null; updatePlayButton(false); }
    try { await shell.trashItem(f.path); map.set(f.path, keepPath); }
    catch (e) { failed.push(`${path.basename(f.path)}: ${e.message}`); }
  }
  if (map.size) repointPaths(map);
  return { removed: map.size, failed, bytes: remove.filter(f => map.has(f.path)).reduce((n, f) => n + f.size, 0) };
}

const fmtMB = b => (b / 1048576).toFixed(1) + " MB";
const fmtDur = s => s ? Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") : "—";

function showDuplicateFinder() {
  const { body, close } = openModal("Duplicate finder", true);
  const status = el("div", "dlg-p", "Starting…");
  const list = el("div", "dup-list");
  body.append(status, list);
  let running = false;

  async function run() {
    if (running) return;
    running = true; list.replaceChildren();
    let groups;
    try { groups = await scanDuplicates(msg => { status.textContent = msg; }); }
    catch (e) { status.textContent = "Scan failed: " + e.message; running = false; return; }
    running = false;
    render(groups);
  }

  function render(groups) {
    list.replaceChildren();
    if (!groups.length) { status.textContent = "No duplicates found."; return; }
    const extra = groups.reduce((n, g) => n + g.files.length - 1, 0);
    status.textContent = `${groups.length} group${groups.length === 1 ? "" : "s"} · ${extra} extra file${extra === 1 ? "" : "s"}. Pick the copy to keep in each group — the others go to the Trash.`;
    groups.forEach(g => list.append(groupCard(g, groups)));
  }

  function groupCard(g, groups) {
    const card = el("div", "dup-card");
    const head = el("div", "dup-head");
    head.append(el("div", "dup-name", g.name), el("span", "dup-badge" + (g.exact ? " exact" : ""), g.exact ? "Exact copy" : "Same song"));
    card.append(head);

    let keep = g.keep;
    const rows = el("div", "dup-rows");
    const refresh = () => rows.querySelectorAll(".dup-row").forEach(r => r.classList.toggle("is-keep", r.dataset.path === keep));
    g.files.forEach(f => {
      const row = el("label", "dup-row");
      row.dataset.path = f.path;
      const radio = document.createElement("input");
      radio.type = "radio"; radio.name = "keep-" + g.files[0].path; radio.checked = f.path === keep;
      radio.onchange = () => { keep = f.path; refresh(); };
      const info = el("div", "dup-info");
      const rel = (loadFolders() || []).find(r => f.path.startsWith(r + path.sep));
      info.append(el("div", "dup-file", path.basename(f.path)),
                  el("div", "dup-where", (rel ? path.basename(rel) + path.sep : "") + path.relative(rel || "", path.dirname(f.path)).replace(/^\.$/, "")));
      const tech = el("div", "dup-tech",
        [fmtMB(f.size), f.bitrate ? Math.round(f.bitrate / 1000) + " kbps" : "", fmtDur(f.duration),
         f.hasTags ? "tags" : "no tags", f.hasArt ? "cover" : "no cover"].filter(Boolean).join(" · "));
      const open = el("button", "dup-open", "Show");
      open.title = "Show in file manager"; open.onclick = e => { e.preventDefault(); shell.showItemInFolder(f.path); };
      const tag = el("span", "dup-keep-tag", "KEEP");
      row.append(radio, info, tech, open, tag);
      rows.append(row);
    });
    refresh();
    card.append(rows);

    const act = el("div", "dup-actions");
    const clean = el("button", "dlg-btn dlg-btn-primary", "Move extras to Trash");
    const ignore = el("button", "dlg-btn", "Not duplicates");
    clean.onclick = async () => {
      const n = g.files.length - 1;
      const bytes = g.files.filter(f => f.path !== keep).reduce((s, f) => s + f.size, 0);
      if (!window.confirm(`Move ${n} file${n === 1 ? "" : "s"} (${fmtMB(bytes)}) to the Trash?\n\nKeeping: ${path.basename(keep)}\nYour favorites, playlists and history will point to the kept file.`)) return;
      clean.disabled = true;
      const res = await cleanupGroup(g, keep);
      if (res.failed.length) { window.alert("Some files couldn't be moved to the Trash:\n\n" + res.failed.join("\n")); clean.disabled = false; }
      if (res.removed) {
        card.remove(); groups.splice(groups.indexOf(g), 1);
        toast(`Moved ${res.removed} file${res.removed === 1 ? "" : "s"} to the Trash (${fmtMB(res.bytes)} freed)`);
        reloadLibrary(); refreshActiveSection();
        render(groups);
      }
    };
    ignore.onclick = () => {
      const s = loadDupIgnored(); s.add(dupSignature(g.files)); saveDupIgnored(s);
      card.remove(); groups.splice(groups.indexOf(g), 1); render(groups);
    };
    act.append(ignore, clean);
    card.append(act);
    return card;
  }

  run();
}

// ═════════════════════════════════════════════════════════════
// TOOLS MENU (sidebar header) + startup
// ═════════════════════════════════════════════════════════════
function showToolsMenu(anchor) {
  const old = document.getElementById("tools-menu");
  if (old) { old.remove(); return; }
  const menu = el("div", "pl-popup");
  menu.id = "tools-menu";
  const item = (label, fn) => { const r = el("div", "pl-popup-row", label); r.onclick = () => { menu.remove(); fn(); }; menu.append(r); };
  item("Backup & restore…", showBackupDialog);
  item("Find duplicates…", showDuplicateFinder);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
  setTimeout(() => document.addEventListener("mousedown", function h(e) {
    if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", h); }
  }), 0);
}

// Restore the saved accent colour
try {
  const accent = localStorage.getItem("accent");
  if (accent) {
    document.documentElement.style.setProperty("--accent", accent);
    const picker = document.querySelector("input[type=color]");
    if (picker) picker.value = accent;
  }
} catch {}
