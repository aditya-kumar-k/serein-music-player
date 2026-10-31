// 5-band equalizer (one global setting)
// Audio is routed  <audio> → source → preamp → 5 filters → limiter → out → speakers
// only while the EQ is actually changing the sound. With the EQ off or flat nothing is rerouted
// until it's first needed, and afterwards the chain is simply bypassed.

const EQ_BANDS = [
  { f: 80,    type: "lowshelf",  label: "80 Hz"  },
  { f: 250,   type: "peaking",   label: "250 Hz" },
  { f: 1000,  type: "peaking",   label: "1 kHz"  },
  { f: 4000,  type: "peaking",   label: "4 kHz"  },
  { f: 10000, type: "highshelf", label: "10 kHz" }
];
const EQ_RANGE = 12;                                   // ±dB
const EQ_PRESETS = {
  "Flat":         [0, 0, 0, 0, 0],
  "Bass boost":   [6, 4, 0, 0, 0],
  "Treble boost": [0, 0, 0, 3, 6],
  "Vocal":        [-2, -1, 3, 3, 0],
  "Rock":         [4, 2, -1, 2, 4],
  "Pop":          [-1, 2, 4, 2, -1],
  "Classical":    [3, 2, 0, 2, 3],
  "Loudness":     [5, 2, 0, 2, 5]
};

// ── state (persisted) ────────────────────────────────────────
let eqOn = true, eqGains = [0, 0, 0, 0, 0], eqCustom = {}, eqBass = 0;   // eqBass: 0–100 %, a separate bass-boost stage
try {
  const s = JSON.parse(localStorage.getItem("eq"));
  if (s) { eqOn = s.on !== false; if (Array.isArray(s.gains) && s.gains.length === 5) eqGains = s.gains.map(Number); eqBass = Math.max(0, Math.min(100, Number(s.bass) || 0)); }
  eqCustom = JSON.parse(localStorage.getItem("eqPresets")) || {};
} catch {}
function eqSave() {
  try { localStorage.setItem("eq", JSON.stringify({ on: eqOn, gains: eqGains, bass: eqBass })); localStorage.setItem("eqPresets", JSON.stringify(eqCustom)); } catch {}
}
const eqActive = () => eqOn && (eqGains.some(g => g !== 0) || eqBass > 0);
const EQ_BASS_MAX_DB = 10;
const eqBassDb = () => eqBass / 100 * EQ_BASS_MAX_DB;

// ── shared audio context + helpers (the visualizer uses these too) ──
let sharedCtx = null;
function sharedAudio() { if (!sharedCtx) sharedCtx = new AudioContext(); return sharedCtx; }
function currentAudioEl() {
  try { return (sound && sound._sounds && sound._sounds[0] && sound._sounds[0]._node) || null; } catch { return null; }
}

// ── audio graph ──────────────────────────────────────────────
let eqNodes = null;
const eqSources = new WeakMap();                       // <audio> → its MediaElementSource (can only be made once)
let eqCurrentSrc = null;
const eqWrapped = el => !!el && eqSources.has(el);

function eqBuild() {
  if (eqNodes) return eqNodes;
  const ctx = sharedAudio();
  const pre = ctx.createGain();
  const filters = EQ_BANDS.map(b => {
    const f = ctx.createBiquadFilter();
    f.type = b.type; f.frequency.value = b.f; f.Q.value = 0.9; f.gain.value = 0;
    return f;
  });
  const bass = ctx.createBiquadFilter();               // bass boost: wide low shelf plus a little punch
  bass.type = "lowshelf"; bass.frequency.value = 110; bass.gain.value = 0;
  filters.push(bass);
  const limiter = ctx.createDynamicsCompressor();      // catches peaks so boosts don't crackle
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.003; limiter.release.value = 0.12;
  // Chromium's compressor adds a fixed +1.14 dB of automatic makeup gain; cancel it so that
  // switching the EQ on never changes the loudness by itself.
  const comp = ctx.createGain();
  comp.gain.value = Math.pow(10, -1.14 / 20);
  const out = ctx.createGain();
  [pre, ...filters, limiter, comp, out].reduce((a, b) => (a.connect(b), b));
  out.connect(ctx.destination);
  eqNodes = { pre, filters, limiter, out };
  return eqNodes;
}

// Headroom: cut the overall level a little when boosting so the boosted bands don't clip
const eqHeadroomDb = () => Math.max(0, ...eqGains, eqBassDb()) * 0.6;

function eqApply() {
  if (!eqNodes) return;
  const t = sharedAudio().currentTime;
  eqGains.forEach((g, i) => eqNodes.filters[i].gain.setTargetAtTime(g, t, 0.02));
  eqNodes.filters[EQ_BANDS.length].gain.setTargetAtTime(eqBassDb(), t, 0.02);
  eqNodes.pre.gain.setTargetAtTime(Math.pow(10, -eqHeadroomDb() / 20), t, 0.02);
}

function eqRoute() {
  if (!eqCurrentSrc) return;
  const n = eqBuild();
  try { eqCurrentSrc.disconnect(); } catch {}
  eqCurrentSrc.connect(eqActive() ? n.pre : n.out);
}

// Called when a song starts and whenever the settings change
function eqAttach() {
  const el = currentAudioEl();
  if (!el) return;
  let src = eqSources.get(el);
  if (!src) {
    if (!eqActive()) return;                           // not needed yet: leave playback untouched
    try { src = sharedAudio().createMediaElementSource(el); } catch { return; }
    eqSources.set(el, src);
  }
  eqBuild();
  eqCurrentSrc = src;
  if (sharedAudio().state === "suspended") sharedAudio().resume();
  eqRoute();
  eqApply();
  if (typeof vizAttach === "function") vizAttach();    // the visualizer reads from the EQ output once rerouted
}

// ── changing settings ────────────────────────────────────────
function eqSetGain(i, v) {
  eqGains[i] = Math.max(-EQ_RANGE, Math.min(EQ_RANGE, Math.round(v * 2) / 2));
  eqChanged();
}
function eqSetAll(arr) { eqGains = arr.slice(); eqChanged(); }
function eqSetBass(v) { eqBass = Math.max(0, Math.min(100, Math.round(v))); eqChanged(); }
function eqToggle(on) { eqOn = on; eqChanged(); }
function eqChanged() {
  eqSave();
  eqAttach();
  eqApply();
  eqRoute();
  updateEqBtn();
  eqRefreshPanel();
}

function eqAllPresets() { return { ...EQ_PRESETS, ...eqCustom }; }
function eqCurrentPresetName() {
  const hit = Object.entries(eqAllPresets()).find(([, g]) => g.every((v, i) => v === eqGains[i]));
  return hit ? hit[0] : null;
}
function updateEqBtn() {
  const b = document.getElementById("eqBtn");
  if (b) b.classList.toggle("active", eqActive());
}

// ── panel ────────────────────────────────────────────────────
let eqPanel = null;

function showEqPanel(anchor) {
  if (eqPanel) { closeEqPanel(); return; }
  const p = document.createElement("div");
  p.id = "eq-panel"; p.className = "pl-popup";
  p.innerHTML = `
    <div class="eq-head">
      <span class="eq-title">Equalizer</span>
      <label class="eq-switch" title="Turn the equalizer on or off"><input type="checkbox" id="eqOnBox"><span></span></label>
    </div>
    <div class="eq-presets">
      <select id="eqPreset"></select>
      <button class="eq-link" id="eqSavePreset">Save</button>
      <button class="eq-link eq-del" id="eqDelPreset" style="display:none">Delete</button>
    </div>
    <div class="eq-sliders">
      ${EQ_BANDS.map((b, i) => `
        <div class="eq-band">
          <div class="eq-db" id="eqDb${i}">0</div>
          <div class="eq-track"><input type="range" class="eq-slider" id="eqS${i}" min="${-EQ_RANGE}" max="${EQ_RANGE}" step="0.5" value="0" title="Double-click to reset"></div>
          <div class="eq-freq">${b.label}</div>
        </div>`).join("")}
    </div>
    <div class="eq-bass">
      <span>Bass boost</span>
      <input type="range" id="eqBass" min="0" max="100" step="5" value="0" title="Double-click to reset">
      <span id="eqBassVal">0%</span>
    </div>
    <div class="eq-foot"><button class="eq-link" id="eqReset">Reset to flat</button></div>`;
  document.body.appendChild(p);
  eqPanel = p;

  p.querySelector("#eqOnBox").onchange = e => eqToggle(e.target.checked);
  p.querySelector("#eqPreset").onchange = e => { const g = eqAllPresets()[e.target.value]; if (g) eqSetAll(g); };
  p.querySelector("#eqReset").onclick = () => { eqBass = 0; eqSetAll([0, 0, 0, 0, 0]); };
  const bassEl = p.querySelector("#eqBass");
  bassEl.oninput = () => eqSetBass(parseFloat(bassEl.value));
  bassEl.ondblclick = () => eqSetBass(0);
  EQ_BANDS.forEach((_, i) => {
    const s = p.querySelector("#eqS" + i);
    s.oninput = () => eqSetGain(i, parseFloat(s.value));
    s.ondblclick = () => eqSetGain(i, 0);
  });
  p.querySelector("#eqSavePreset").onclick = () => {
    promptText("Save preset", "Preset name…", "", name => {
      if (EQ_PRESETS[name] || eqCustom[name]) return false;
      eqCustom[name] = eqGains.slice();
      eqSave(); eqRefreshPanel();
    });
  };
  p.querySelector("#eqDelPreset").onclick = () => {
    const name = eqCurrentPresetName();
    if (name && eqCustom[name] && window.confirm(`Delete the preset "${name}"?`)) { delete eqCustom[name]; eqSave(); eqRefreshPanel(); }
  };

  // position next to the button, kept on screen: below it if it sits in the top half, above otherwise
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left + r.width / 2 - p.offsetWidth / 2, window.innerWidth - p.offsetWidth - 8)) + "px";
  if (r.top < window.innerHeight / 2) p.style.top = (r.bottom + 8) + "px";
  else p.style.bottom = (window.innerHeight - r.top + 8) + "px";
  eqRefreshPanel();

  setTimeout(() => {
    eqOutside = e => { if (eqPanel && !eqPanel.contains(e.target) && !anchor.contains(e.target) && !document.querySelector(".dlg-overlay")) closeEqPanel(); };
    document.addEventListener("mousedown", eqOutside);
    document.addEventListener("keydown", eqEsc);
  }, 0);
}
let eqOutside = null;
const eqEsc = e => { if (e.key === "Escape" && !document.querySelector(".dlg-overlay")) closeEqPanel(); };

function closeEqPanel() {
  if (eqPanel) eqPanel.remove();
  eqPanel = null;
  document.removeEventListener("mousedown", eqOutside);
  document.removeEventListener("keydown", eqEsc);
}

function eqRefreshPanel() {
  if (!eqPanel) return;
  eqPanel.classList.toggle("eq-off", !eqOn);
  eqPanel.querySelector("#eqOnBox").checked = eqOn;
  eqGains.forEach((g, i) => {
    const s = eqPanel.querySelector("#eqS" + i);
    if (parseFloat(s.value) !== g) s.value = g;
    eqPanel.querySelector("#eqDb" + i).textContent = (g > 0 ? "+" : "") + g;
  });
  const bs = eqPanel.querySelector("#eqBass");
  if (parseFloat(bs.value) !== eqBass) bs.value = eqBass;
  eqPanel.querySelector("#eqBassVal").textContent = eqBass + "%";
  const sel = eqPanel.querySelector("#eqPreset"), cur = eqCurrentPresetName();
  const opt = (n, label) => `<option value="${n.replace(/"/g, "&quot;")}"${n === cur ? " selected" : ""}>${label || n}</option>`;
  sel.innerHTML = (cur ? "" : `<option selected disabled>Custom</option>`)
    + Object.keys(EQ_PRESETS).map(n => opt(n)).join("")
    + (Object.keys(eqCustom).length ? `<optgroup label="Your presets">${Object.keys(eqCustom).map(n => opt(n)).join("")}</optgroup>` : "");
  eqPanel.querySelector("#eqDelPreset").style.display = cur && eqCustom[cur] ? "" : "none";
  eqPanel.querySelector("#eqSavePreset").style.display = cur ? "none" : "";
}

updateEqBtn();
