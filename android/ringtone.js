// Ringtone maker: pick a part of a song on a waveform, preview it, save it as a ringtone / notification / alarm
// (Android app only; the cutting itself happens natively in AudioCutter.java)

const RT_MAX_SECONDS = 180;
const RT_DEFAULT_SECONDS = 30;
const RT_FADE_SECONDS = 2;

function ringtoneAvailable() {
  return !!(window.AndroidBridge && !window.isElectron && AndroidBridge.plugin && AndroidBridge.plugin.cutAudio);
}

// song: { path / contentUri, title / name, duration }
function openRingtoneMaker(song) {
  if (!ringtoneAvailable()) { toast("Ringtone maker is only in the Android app"); return; }
  const uri = song.contentUri || song.path;
  if (!uri || !String(uri).startsWith("content://")) { toast("This song can't be cut (not in the phone's library)"); return; }
  document.getElementById("rt-overlay")?.remove();

  const known = (AndroidBridge.allDeviceSongs || []).find(s => (s.contentUri || s.path) === uri) || {};
  const title = song.title || known.title || stripExt(song.name || known.name || "Ringtone");
  let duration = Number(song.duration || known.duration) || 0;

  const wasPlaying = sound && sound.playing();
  if (wasPlaying) togglePlay();

  const ov = document.createElement("div");
  ov.id = "rt-overlay";
  ov.innerHTML = `
    <div class="rt-box">
      <div class="rt-head"><span>Ringtone maker</span><button class="rt-x" id="rtClose" aria-label="Close">✕</button></div>
      <div class="rt-song"></div>
      <div class="rt-wave" id="rtWave">
        <canvas id="rtCanvas"></canvas>
        <div class="rt-shade" id="rtShadeL"></div><div class="rt-shade" id="rtShadeR"></div>
        <div class="rt-handle" id="rtH0"><i></i></div><div class="rt-handle" id="rtH1"><i></i></div>
        <div class="rt-head-line" id="rtPlayhead"></div>
      </div>
      <div class="rt-times"><span id="rtT0">0:00.0</span><span id="rtLen"></span><span id="rtT1">0:00.0</span></div>
      <div class="rt-nudge">
        <div><span>Start</span><button data-n="0,-0.1">−</button><button data-n="0,0.1">+</button></div>
        <div><span>End</span><button data-n="1,-0.1">−</button><button data-n="1,0.1">+</button></div>
      </div>
      <div class="rt-row">
        <button class="rt-btn rt-primary" id="rtPlay">▶ Play selection</button>
      </div>
      <label class="rt-check"><input type="checkbox" id="rtFadeIn"> Fade in (${RT_FADE_SECONDS}s)</label>
      <label class="rt-check"><input type="checkbox" id="rtFadeOut"> Fade out (${RT_FADE_SECONDS}s)</label>
      <input class="rt-name" id="rtName" type="text" placeholder="File name">
      <div class="rt-kinds" id="rtKinds">
        <button data-k="ringtone" class="on">Ringtone</button><button data-k="notification">Notification</button><button data-k="alarm">Alarm</button>
      </div>
      <button class="rt-btn rt-save" id="rtSave">Save</button>
      <div class="rt-done" id="rtDone" style="display:none">
        <div id="rtDoneMsg"></div>
        <button class="rt-btn rt-primary" id="rtSet">Set as <span id="rtSetKind">ringtone</span></button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector(".rt-song").textContent = title;
  const $ = id => ov.querySelector("#" + id);
  $("rtName").value = title.replace(/\s*[-–]\s*.*$/, "").slice(0, 40) + " (ringtone)";

  let t0 = 0, t1 = 0, kind = "ringtone", savedUri = null, savedKind = null;
  let peaks = null;
  const audio = new Audio();
  audio.src = window.getPlayableAudioSrc ? window.getPlayableAudioSrc(uri) : uri;
  audio.preload = "auto";
  let previewTimer = null;

  const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); };
  const wave = $("rtWave"), canvas = $("rtCanvas");

  function clampSel() {
    t0 = Math.max(0, Math.min(t0, duration - 0.5));
    t1 = Math.max(t0 + 0.5, Math.min(t1, duration));
    if (t1 - t0 > RT_MAX_SECONDS) { if (document.activeElement && document.activeElement.id === "rtH0") t0 = t1 - RT_MAX_SECONDS; else t1 = t0 + RT_MAX_SECONDS; }
  }
  function layout() {
    if (!duration) return;
    const w = wave.clientWidth;
    const x0 = t0 / duration * w, x1 = t1 / duration * w;
    $("rtH0").style.left = x0 + "px"; $("rtH1").style.left = x1 + "px";
    $("rtShadeL").style.width = x0 + "px"; $("rtShadeR").style.left = x1 + "px"; $("rtShadeR").style.width = (w - x1) + "px";
    $("rtT0").textContent = fmt(t0); $("rtT1").textContent = fmt(t1);
    $("rtLen").textContent = (t1 - t0).toFixed(1) + " s";
  }
  function draw() {
    const w = wave.clientWidth, h = wave.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    const c = canvas.getContext("2d"); c.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement);
    c.fillStyle = cs.getPropertyValue("--accent2").trim() || "#c084fc";
    const n = Math.floor(w / 3);
    for (let i = 0; i < n; i++) {
      const p = peaks ? peaks[Math.floor(i / n * peaks.length)] : 0.12;
      const bh = Math.max(2, p * (h - 8));
      c.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  }
  function setDuration(d) {
    duration = d;
    if (!t1) { t0 = 0; t1 = Math.min(d, RT_DEFAULT_SECONDS); }
    clampSel(); layout(); draw();
  }

  // waveform: decode a low-rate copy of the song
  (async () => {
    try {
      const res = await fetch(audio.src);
      const len = Number(res.headers.get("content-length")) || 0;
      if (len > 60 * 1024 * 1024) throw new Error("big");
      const buf = await res.arrayBuffer();
      const dec = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(buf);
      const d = dec.getChannelData(0), bins = 400, per = Math.floor(d.length / bins) || 1;
      const pk = new Float32Array(bins); let mx = 0.0001;
      for (let b = 0; b < bins; b++) { let m = 0; for (let i = b * per; i < (b + 1) * per && i < d.length; i++) m = Math.max(m, Math.abs(d[i])); pk[b] = m; mx = Math.max(mx, m); }
      peaks = pk.map(v => Math.pow(v / mx, 0.7));
      if (!duration) duration = dec.duration;
      setDuration(duration);
    } catch { if (duration) setDuration(duration); }
  })();
  if (duration) setDuration(duration);
  audio.addEventListener("loadedmetadata", () => { if (!duration && isFinite(audio.duration)) setDuration(audio.duration); });
  setTimeout(() => { layout(); draw(); }, 50);

  // dragging the handles
  function dragHandle(el, which) {
    el.addEventListener("pointerdown", e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.focus && el.focus();
      stopPreview();
      const move = ev => {
        const r = wave.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * duration;
        if (which === 0) t0 = Math.min(t, t1 - 0.5); else t1 = Math.max(t, t0 + 0.5);
        if (t1 - t0 > RT_MAX_SECONDS) { if (which === 0) t0 = t1 - RT_MAX_SECONDS; else t1 = t0 + RT_MAX_SECONDS; }
        layout();
      };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }
  dragHandle($("rtH0"), 0); dragHandle($("rtH1"), 1);
  ov.querySelectorAll(".rt-nudge button").forEach(b => b.onclick = () => {
    const [w, d] = b.dataset.n.split(",").map(Number);
    stopPreview();
    if (w === 0) t0 = Math.max(0, Math.min(t0 + d, t1 - 0.5)); else t1 = Math.max(t0 + 0.5, Math.min(t1 + d, duration));
    layout();
  });

  // preview
  function stopPreview() {
    clearInterval(previewTimer); previewTimer = null;
    audio.pause(); $("rtPlay").textContent = "▶ Play selection"; $("rtPlayhead").style.display = "none";
  }
  $("rtPlay").onclick = () => {
    if (previewTimer) { stopPreview(); return; }
    audio.currentTime = t0; audio.play().catch(() => toast("Couldn't play this song"));
    $("rtPlay").textContent = "■ Stop"; $("rtPlayhead").style.display = "block";
    previewTimer = setInterval(() => {
      if (audio.currentTime >= t1) { stopPreview(); return; }
      $("rtPlayhead").style.left = (audio.currentTime / duration * wave.clientWidth) + "px";
    }, 40);
  };

  ov.querySelectorAll("#rtKinds button").forEach(b => b.onclick = () => {
    kind = b.dataset.k;
    ov.querySelectorAll("#rtKinds button").forEach(x => x.classList.toggle("on", x === b));
    $("rtDone").style.display = "none";
  });

  // save
  $("rtSave").onclick = async () => {
    stopPreview();
    const btn = $("rtSave"); btn.disabled = true; btn.textContent = "Saving…";
    try {
      const r = await AndroidBridge.plugin.cutAudio({
        uri, start: t0, end: t1, name: $("rtName").value.trim() || "Ringtone", kind,
        fadeIn: $("rtFadeIn").checked ? RT_FADE_SECONDS : 0, fadeOut: $("rtFadeOut").checked ? RT_FADE_SECONDS : 0
      });
      savedUri = r.uri; savedKind = kind;
      $("rtDoneMsg").textContent = "Saved to " + ({ ringtone: "Ringtones", notification: "Notifications", alarm: "Alarms" })[kind] + " (" + (t1 - t0).toFixed(1) + " s)";
      $("rtSetKind").textContent = kind;
      $("rtDone").style.display = "";
      if (AndroidBridge.refreshSongs) AndroidBridge.refreshSongs(true);
    } catch (e) {
      toast("Couldn't save: " + (e.message || e));
    }
    btn.disabled = false; btn.textContent = "Save";
  };
  $("rtSet").onclick = async () => {
    try {
      await AndroidBridge.plugin.setSystemSound({ uri: savedUri, kind: savedKind });
      toast("Set as your " + savedKind);
    } catch (e) {
      if (/NEED_PERMISSION/.test(e.message || e)) toast("Allow “Modify system settings” for Serein, then tap again");
      else toast(e.message || String(e));
    }
  };

  function close() {
    stopPreview(); audio.src = ""; ov.remove();
    window.removeEventListener("resize", onResize);
    if (wasPlaying && sound) togglePlay();
  }
  const onResize = () => { layout(); draw(); };
  window.addEventListener("resize", onResize);
  $("rtClose").onclick = close;
}

function openRingtoneMakerForCurrent() {
  if (!currentSongPath) { toast("Play or select a song first"); return; }
  const known = (window.AndroidBridge && AndroidBridge.allDeviceSongs || []).find(s => (s.contentUri || s.path) === currentSongPath);
  openRingtoneMaker(known || { path: currentSongPath, name: currentTitle });
}
