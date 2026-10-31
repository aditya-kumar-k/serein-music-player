// Audio visualizer: Bars · Wave · Ring (cycle with the Viz button or the V key)
// The playing <audio> element is tapped with captureStream() into an AnalyserNode, so playback
// itself is not rerouted — volume and mute keep working exactly as before.

const VIZ_MODES  = ["off", "bars", "wave", "ring"];
const VIZ_LABELS = { off: "Viz", bars: "Viz · Bars", wave: "Viz · Wave", ring: "Viz · Ring" };
const VIZ_BANDS  = 64;

let vizMode = "bars";
try { const m = localStorage.getItem("vizMode"); if (VIZ_MODES.includes(m)) vizMode = m; } catch {}

let vizCtx = null, vizAnalyser = null, vizSink = null, vizSrcNode = null, vizTrack = null, vizEl = null, vizSongPath = "", vizViaEQ = false;
let vizFreq = null, vizTime = new Uint8Array(2048).fill(128), vizRanges = [];
let vizRAF = 0, vizAttachTries = 0;
const vizBands = new Float32Array(VIZ_BANDS);
const vizColorProbe = document.createElement("canvas").getContext("2d");
let vizColor = [124, 92, 252], vizColorFrame = 0;

// ── canvases ─────────────────────────────────────────────────
const vizMain = document.createElement("canvas");
vizMain.id = "vizCanvas";
document.querySelector(".main").prepend(vizMain);

// ── audio tap ────────────────────────────────────────────────
function vizEnsureContext() {
  if (vizCtx) return;
  vizCtx = sharedAudio();                         // one audio context shared with the equalizer
  vizAnalyser = vizCtx.createAnalyser();
  vizAnalyser.fftSize = 2048;
  vizAnalyser.smoothingTimeConstant = 0.7;
  vizSink = vizCtx.createGain();                 // silent sink so the analyser is always pulled
  vizSink.gain.value = 0;
  vizAnalyser.connect(vizSink); vizSink.connect(vizCtx.destination);
  vizFreq = new Uint8Array(vizAnalyser.frequencyBinCount);
  vizTime = new Uint8Array(vizAnalyser.fftSize);

  // log-spaced bands from 45 Hz to 14 kHz
  const hzPerBin = vizCtx.sampleRate / vizAnalyser.fftSize, f0 = 45, f1 = 14000;
  vizRanges = [];
  for (let i = 0; i < VIZ_BANDS; i++) {
    const lo = f0 * Math.pow(f1 / f0, i / VIZ_BANDS), hi = f0 * Math.pow(f1 / f0, (i + 1) / VIZ_BANDS);
    const a = Math.max(1, Math.floor(lo / hzPerBin)), b = Math.max(a, Math.ceil(hi / hzPerBin));
    vizRanges.push([a, b]);
  }
}

function vizDetach() {
  try { if (vizSrcNode) vizSrcNode.disconnect(); } catch {}
  vizSrcNode = null; vizTrack = null; vizEl = null; vizViaEQ = false;
}

function vizAttach() {
  if (vizMode === "off") return;
  const el = currentAudioEl();
  if (!el) return;

  // The equalizer has taken over this element's output: read the analyser from its output instead
  if (eqWrapped(el)) {
    if (vizViaEQ && vizEl === el) { vizStart(); return; }
    vizDetach();
    vizEnsureContext();
    eqBuild().out.connect(vizAnalyser);
    vizViaEQ = true; vizEl = el; vizSongPath = currentSongPath;
    vizStart();
    return;
  }
  if (!el.captureStream) return;

  // Already tapping this song's live stream (e.g. resuming after a pause)
  if (vizSrcNode && vizTrack && vizTrack.readyState === "live" && vizEl === el && vizSongPath === currentSongPath) { vizStart(); return; }

  vizDetach();
  try {
    vizEnsureContext();
    if (vizCtx.state === "suspended") vizCtx.resume();
    const tracks = el.captureStream().getAudioTracks();
    if (!tracks.length) {                         // the stream can lag a moment behind "play"
      if (vizAttachTries++ < 8) setTimeout(vizAttach, 250);
      return;
    }
    vizAttachTries = 0;
    vizTrack = tracks[0];
    vizSrcNode = vizCtx.createMediaStreamSource(new MediaStream([vizTrack]));
    vizSrcNode.connect(vizAnalyser);
    vizEl = el; vizSongPath = currentSongPath;
  } catch {}
  vizStart();
}

// ── mode button ──────────────────────────────────────────────
function cycleViz() {
  vizMode = VIZ_MODES[(VIZ_MODES.indexOf(vizMode) + 1) % VIZ_MODES.length];
  try { localStorage.setItem("vizMode", vizMode); } catch {}
  updateVizBtn();
  if (vizMode === "off") { vizClearAll(); vizDetach(); }
  else { vizAttach(); }
}
function updateVizBtn() {
  const b = document.getElementById("vizBtn");
  if (!b) return;
  b.textContent = VIZ_LABELS[vizMode];
  b.classList.toggle("active", vizMode !== "off");
}

// ── drawing ──────────────────────────────────────────────────
function vizRefreshColor() {
  if (vizColorFrame++ % 20) return;
  const css = getComputedStyle(document.documentElement).getPropertyValue("--glow").trim() || "#7c5cfc";
  vizColorProbe.fillStyle = "#7c5cfc";
  vizColorProbe.fillStyle = css;                  // normalises hsl()/hex to #rrggbb
  const hex = vizColorProbe.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(hex)) vizColor = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
const vizRGBA = (a) => `rgba(${vizColor[0]},${vizColor[1]},${vizColor[2]},${a})`;

function vizSize(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { w, h, dpr, rect: r };
}
function vizClear(c) { const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height); }
function vizClearAll() { vizClear(vizMain); const f = document.querySelector(".lfs-viz"); if (f) vizClear(f); }

function drawBars(c, heightFrac, alpha) {
  const { w, h, dpr } = vizSize(c), g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const n = VIZ_BANDS, gap = 3 * dpr, usable = w;
  const bw = Math.max(2 * dpr, (usable - gap * (n - 1)) / n), x0 = (w - (bw * n + gap * (n - 1))) / 2;
  const grad = g.createLinearGradient(0, h, 0, h * (1 - heightFrac));
  grad.addColorStop(0, vizRGBA(0.55 * alpha)); grad.addColorStop(1, vizRGBA(0));
  g.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const v = vizBands[i], bh = v > 0.01 ? Math.max(3 * dpr, v * h * heightFrac) : 0;
    if (!bh) continue;
    g.beginPath(); g.roundRect(x0 + i * (bw + gap), h - bh, bw, bh, bw / 2); g.fill();
  }
}

function drawWave(c, centerFrac, alpha) {
  const { w, h, dpr } = vizSize(c), g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const pts = 160, mid = h * centerFrac, amp = h * 0.065;
  // overall energy keeps the line calm when the music is quiet
  const energy = vizBands.reduce((a, b) => a + b, 0) / VIZ_BANDS;
  const gain = Math.min(1.25, 0.35 + energy * 2.2);
  const path = new Path2D();
  for (let i = 0; i <= pts; i++) {
    const s = (vizTime[Math.floor(i / pts * (vizTime.length - 1))] - 128) / 128;
    const x = i / pts * w, y = mid + s * amp * gain;
    i ? path.lineTo(x, y) : path.moveTo(x, y);
  }
  g.lineJoin = "round"; g.lineCap = "round";
  g.shadowColor = vizRGBA(0.8 * alpha); g.shadowBlur = 22 * dpr;
  g.strokeStyle = vizRGBA(0.45 * alpha); g.lineWidth = 2 * dpr; g.stroke(path);
  g.shadowBlur = 0; g.strokeStyle = vizRGBA(0.9 * alpha); g.lineWidth = 1 * dpr; g.stroke(path);
}

function drawRing(c) {
  const { w, h, dpr, rect } = vizSize(c), g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const art = document.getElementById("albumArt").getBoundingClientRect();
  if (!art.width) return;
  const cx = (art.left + art.width / 2 - rect.left) * dpr, cy = (art.top + art.height / 2 - rect.top) * dpr;
  const scale = art.width / 220, r0 = (art.width / 2 + 16 * scale) * dpr;
  const n = VIZ_BANDS, half = n / 2;
  g.lineCap = "round"; g.lineWidth = Math.max(2, 3.2 * scale) * dpr;
  for (let i = 0; i < n; i++) {
    const v = vizBands[i < half ? i : n - 1 - i];     // mirrored so the ring is symmetric
    if (v < 0.01) continue;
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const len = (4 + v * 34) * scale * dpr;
    g.strokeStyle = vizRGBA(0.35 + v * 0.55);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    g.stroke();
  }
}

// ── loop ─────────────────────────────────────────────────────
function vizStart() { if (!vizRAF && vizMode !== "off") vizRAF = requestAnimationFrame(vizFrame); }

function vizFrame() {
  vizRAF = 0;
  if (vizMode === "off") { vizClearAll(); return; }
  const playing = !!(sound && sound.playing()) && !document.hidden && (vizSrcNode || vizViaEQ);

  if (playing) {
    vizAnalyser.getByteFrequencyData(vizFreq);
    if (vizMode === "wave" || document.querySelector(".lfs-viz")) vizAnalyser.getByteTimeDomainData(vizTime);
    for (let i = 0; i < VIZ_BANDS; i++) {
      const [a, b] = vizRanges[i];
      let m = 0; for (let k = a; k <= b && k < vizFreq.length; k++) if (vizFreq[k] > m) m = vizFreq[k];
      const v = Math.min(1, Math.pow(m / 255, 2.1) * (1 + i / VIZ_BANDS * 0.5));    // curve keeps loud bass from maxing every bar; lift quiet highs
      vizBands[i] = v > vizBands[i] ? vizBands[i] + (v - vizBands[i]) * 0.65 : Math.max(v, vizBands[i] * 0.9);
    }
  } else {
    for (let i = 0; i < VIZ_BANDS; i++) vizBands[i] *= 0.88;                          // ease down when paused
    if (vizTime) vizTime.fill(128);
  }

  vizRefreshColor();
  if (vizMode === "bars") drawBars(vizMain, 0.3, 0.85);
  else if (vizMode === "wave") drawWave(vizMain, 0.4, 1);
  else if (vizMode === "ring") drawRing(vizMain);

  const fs = document.querySelector(".lfs-viz");                    // full-screen lyrics backdrop
  if (fs) { if (vizMode === "wave") drawWave(fs, 0.78, 0.7); else drawBars(fs, 0.6, 0.55); }

  const alive = playing || vizBands.some(v => v > 0.01);
  if (alive) vizRAF = requestAnimationFrame(vizFrame);
  else vizClearAll();
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); cycleViz(); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) vizStart(); });

updateVizBtn();
