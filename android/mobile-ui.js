/**
 * Mobile UI Controller
 * Manages tab switching, mobile navigation, mini-player synchronization,
 * and touch interactions for Android and mobile screens.
 */
(function() {
  let activeTab = "library";

  // renderer.js keeps its state in top-level `let`s, which are not window properties. Expose
  // read-only views so the mini-player (and anything else using window.*) can see them.
  const expose = (name, read) => {
    if (Object.getOwnPropertyDescriptor(window, name)) return;
    Object.defineProperty(window, name, { get: read, configurable: true });
  };
  expose("currentTitle",    () => (typeof currentTitle    !== "undefined" ? currentTitle    : ""));
  expose("currentSongPath", () => (typeof currentSongPath !== "undefined" ? currentSongPath : ""));
  expose("sound",           () => (typeof sound           !== "undefined" ? sound           : null));
  expose("currentMeta",     () => (typeof currentMeta     !== "undefined" ? currentMeta     : null));
  expose("coverUrl",        () => (typeof coverUrl        !== "undefined" ? coverUrl        : null));

  function isMobileView() {
    return window.innerWidth <= 768;
  }

  function switchMobileTab(tab) {
    activeTab = tab;
    // a hidden tab loses its scroll position, so the library always comes back at the top with its tools shown
    if (tab === "library" && typeof window.showLibTools === "function") window.showLibTools();
    document.body.setAttribute("data-tab", tab);

    // Update bottom nav buttons
    document.querySelectorAll(".mob-nav-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });

    // Handle view visibility on mobile
    if (isMobileView()) {
      const sidebar = document.querySelector(".sidebar");
      const main = document.querySelector(".main");
      const lyrics = document.querySelector(".lyrics");
      const miniPlayer = document.getElementById("mobileMiniPlayer");

      if (sidebar) sidebar.style.display = (tab === "library") ? "flex" : "none";
      if (main) main.style.display = (tab === "player") ? "flex" : "none";
      if (lyrics) lyrics.style.display = (tab === "lyrics") ? "flex" : "none";

      // Show/hide floating mini player: only visible when NOT on the full player screen
      if (miniPlayer) {
        const npEl = document.getElementById("nowPlaying");
        const npText = npEl ? npEl.textContent.trim() : "";
        const hasSong = (npText && npText !== "No song selected") || !!window.currentTitle || !!window.currentSongPath;
        miniPlayer.style.display = (hasSong && tab !== "player") ? "flex" : "none";
        document.body.classList.toggle("has-mini", hasSong && tab !== "player");
        if (hasSong && tab !== "player") updateMobileMiniPlayer();
      }

      const mobMenuBtn = document.getElementById("mobMenuBtn");
      if (mobMenuBtn) mobMenuBtn.style.display = (tab === "player") ? "none" : "";

      // Trigger resize for visualizer canvas when switching to player tab
      if (tab === "player" && typeof window.vizResize === 'function') {
        setTimeout(window.vizResize, 100);
      }
    } else {
      // Desktop: restore layout
      const sidebar = document.querySelector(".sidebar");
      const main = document.querySelector(".main");
      const lyrics = document.querySelector(".lyrics");
      const miniPlayer = document.getElementById("mobileMiniPlayer");
      if (sidebar) sidebar.style.display = "";
      if (main) main.style.display = "";
      if (lyrics) lyrics.style.display = "";
      if (miniPlayer) miniPlayer.style.display = "none";
      document.body.classList.remove("has-mini");
    }
  }

  window.switchMobileTab = switchMobileTab;

  function updateMobileMiniPlayer() {
    const mini = document.getElementById("mobileMiniPlayer");
    if (!mini) return;

    const npEl = document.getElementById("nowPlaying");
    const npText = npEl ? npEl.textContent.trim() : "";
    const hasSong = (npText && npText !== "No song selected") || !!window.currentTitle || !!window.currentSongPath;

    if (!isMobileView() || activeTab === "player" || !hasSong) {
      mini.style.display = "none";
      document.body.classList.remove("has-mini");
      return;
    }

    mini.style.display = "flex";
    document.body.classList.add("has-mini");

    const titleEl = document.getElementById("mobMiniTitle");
    const artistEl = document.getElementById("mobMiniArtist");
    const playBtn = document.getElementById("mobMiniPlayBtn");
    const artEl = document.getElementById("mobMiniArt");

    const displayTitle = window.currentTitle || (npText !== "No song selected" ? npText : "No song");
    if (titleEl) titleEl.textContent = displayTitle;

    if (artistEl) {
      const metaEl = document.getElementById("songMeta");
      const metaText = metaEl ? metaEl.textContent.trim() : "";
      const sub = window.currentMeta ? [window.currentMeta.artist, window.currentMeta.album].filter(Boolean).join(" · ") : "";
      artistEl.textContent = sub || (metaText && metaText !== "—" ? metaText : "Serein Music Player");
    }

    const coverImg = document.getElementById("coverImg");
    const artSrc = (coverImg && coverImg.src && coverImg.complete && coverImg.naturalWidth > 0) ? coverImg.src : (window.coverUrl || null);

    if (artEl) {
      if (artSrc) {
        artEl.style.backgroundImage = `url("${artSrc}")`;
        artEl.innerHTML = "";
      } else {
        artEl.style.backgroundImage = "";
        artEl.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
      }
    }

    if (playBtn) {
      const isPlaying = (window.sound && typeof window.sound.playing === "function" && window.sound.playing());
      playBtn.innerHTML = isPlaying
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
    }
  }

  window.updateMobileMiniPlayer = updateMobileMiniPlayer;

  // Listen for window resize
  window.addEventListener("resize", () => {
    switchMobileTab(activeTab);
  });

  // ── Smooth View Transitions & Gestures ──
  function openPlayerSmooth() {
    const mini = document.getElementById("mobileMiniPlayer");
    const main = document.querySelector(".main");
    if (mini) {
      mini.style.transition = "transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s ease";
      mini.style.transform = "translateY(-24px)";
      mini.style.opacity = "0";
    }
    setTimeout(() => {
      switchMobileTab("player");
      if (mini) {
        mini.style.transition = "";
        mini.style.transform = "";
        mini.style.opacity = "";
      }
      if (main) {
        main.style.transition = "none";
        main.style.transform = "translateY(60px)";
        main.style.opacity = "0.2";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            main.style.transition = "transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.28s ease";
            main.style.transform = "translateY(0)";
            main.style.opacity = "1";
          });
        });
      }
    }, 120);
  }
  window.openPlayerSmooth = openPlayerSmooth;

  function closePlayerSmooth() {
    const main = document.querySelector(".main");
    if (!main || !isMobileView()) { switchMobileTab("library"); return; }
    main.style.transition = "transform 0.26s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.22s ease";
    main.style.transform = "translateY(80px)";
    main.style.opacity = "0";
    setTimeout(() => {
      switchMobileTab("library");
      main.style.transition = "";
      main.style.transform = "";
      main.style.opacity = "";
    }, 220);
  }
  window.closePlayerSmooth = closePlayerSmooth;

  // 1. Mini-player gestures (Swipe Up or Tap to Player)
  (function initMiniGestures() {
    const mini = document.getElementById("mobileMiniPlayer");
    if (!mini) return;
    let startY = 0, startX = 0, tracking = false, moved = false;

    mini.addEventListener("touchstart", (e) => {
      if (e.target.closest("button")) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      tracking = true;
      moved = false;
      mini.style.transition = "none";
    }, { passive: true });

    mini.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (Math.abs(dy) > 5) moved = true;
      if (dy < 0) {
        mini.style.transform = `translateY(${Math.max(dy * 0.5, -40)}px)`;
      }
    }, { passive: true });

    mini.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const dy = e.changedTouches[0].clientY - startY;
      const dx = e.changedTouches[0].clientX - startX;
      if (dy < -20 && Math.abs(dy) > Math.abs(dx) * 0.5) {
        // Swiped UP smoothly
        openPlayerSmooth();
      } else if (!moved || (Math.abs(dx) < 15 && Math.abs(dy) < 15)) {
        // Tap
        openPlayerSmooth();
      } else {
        mini.style.transition = "transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)";
        mini.style.transform = "";
        setTimeout(() => { if (mini) mini.style.transition = ""; }, 220);
      }
    }, { passive: true });
  })();

  // 2. Full Player gestures:
  // - Swipe DOWN -> smoothly return to Library
  // - Swipe LEFT/RIGHT -> smoothly transition to next / previous song
  // - Tap on album art -> open Lyrics
  (function initPlayerGestures() {
    const main = document.querySelector(".main");
    if (!main) return;
    let startY = 0, startX = 0, tracking = false, isInteractive = false, onArt = false;
    let isSwipeDown = false, isSwipeH = false;

    main.addEventListener("touchstart", (e) => {
      const target = e.target;
      if (target.closest("input, button, .player-top-btn, .pl-popup, #player-menu")) {
        isInteractive = true;
        return;
      }
      isInteractive = false;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      tracking = true;
      onArt = !!target.closest("#albumArt");
      isSwipeDown = false;
      isSwipeH = false;
    }, { passive: true });

    main.addEventListener("touchmove", (e) => {
      if (!tracking || isInteractive) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;

      if (!isSwipeDown && !isSwipeH) {
        if (dy > 8 && dy > Math.abs(dx) * 1.1) {
          isSwipeDown = true;
        } else if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.1) {
          isSwipeH = true;
        }
      }

      if (isSwipeDown && dy > 0) {
        main.style.transition = "none";
        main.style.transform = `translateY(${Math.min(dy * 0.6, 120)}px)`;
        main.style.opacity = `${Math.max(0.4, 1 - (dy / 300))}`;
      } else if (isSwipeH) {
        const art = document.getElementById("albumArt");
        if (art) {
          art.style.transition = "none";
          art.style.transform = `translateX(${dx * 0.4}px) scale(${Math.max(0.92, 1 - Math.abs(dx) / 800)})`;
          art.style.opacity = `${Math.max(0.5, 1 - Math.abs(dx) / 300)}`;
        }
      }
    }, { passive: true });

    main.addEventListener("touchend", (e) => {
      if (!tracking || isInteractive) return;
      tracking = false;
      const dy = e.changedTouches[0].clientY - startY;
      const dx = e.changedTouches[0].clientX - startX;
      const art = document.getElementById("albumArt");

      // A. Swipe DOWN to Library
      if (isSwipeDown || (dy > 40 && dy > Math.abs(dx) * 1.0)) {
        closePlayerSmooth();
        return;
      } else if (main.style.transform) {
        main.style.transition = "transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s ease";
        main.style.transform = "";
        main.style.opacity = "";
        setTimeout(() => { if (main) main.style.transition = ""; }, 240);
      }

      // B. Swipe LEFT or RIGHT to change songs
      if (isSwipeH || (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.0)) {
        if (dx < 0) {
          // Swipe LEFT -> Next song
          if (art) {
            art.style.transition = "transform 0.2s ease-in, opacity 0.18s ease-in";
            art.style.transform = "translateX(-120px) scale(0.88)";
            art.style.opacity = "0";
          }
          setTimeout(() => {
            if (typeof window.next === "function") window.next();
            if (art) {
              art.style.transition = "none";
              art.style.transform = "translateX(100px) scale(0.9)";
              art.style.opacity = "0";
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  art.style.transition = "transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.28s ease";
                  art.style.transform = "translateX(0) scale(1)";
                  art.style.opacity = "1";
                });
              });
            }
          }, 180);
        } else {
          // Swipe RIGHT -> Previous song
          if (art) {
            art.style.transition = "transform 0.2s ease-in, opacity 0.18s ease-in";
            art.style.transform = "translateX(120px) scale(0.88)";
            art.style.opacity = "0";
          }
          setTimeout(() => {
            if (typeof window.playSongDelta === "function") window.playSongDelta(-1);
            else if (typeof window.prev === "function") window.prev();
            if (art) {
              art.style.transition = "none";
              art.style.transform = "translateX(-100px) scale(0.9)";
              art.style.opacity = "0";
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  art.style.transition = "transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.28s ease";
                  art.style.transform = "translateX(0) scale(1)";
                  art.style.opacity = "1";
                });
              });
            }
          }, 180);
        }
        return;
      } else if (art && art.style.transform) {
        art.style.transition = "transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.24s ease";
        art.style.transform = "";
        art.style.opacity = "";
        setTimeout(() => { if (art) art.style.transition = ""; }, 240);
      }

      // C. Tap on album art -> open Lyrics
      if (onArt && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        if (e.cancelable) e.preventDefault();
        swallowClicksUntil = Date.now() + 500;
        switchMobileTab("lyrics");
      }
    }, { passive: false });
  })();

  let swallowClicksUntil = 0;
  document.addEventListener("click", (e) => {
    if (Date.now() < swallowClicksUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // Safety net: never let the document itself scroll (it would shift the title bar and open a gap)
  window.addEventListener("scroll", () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  }, { passive: true });

  // Library: hide the filter chips / search / scan row while scrolling down the list,
  // bring it back when the list is scrolled to the very top again.
  (function () {
    const sidebar = document.querySelector(".sidebar");
    const tools = document.getElementById("libTools");
    if (!sidebar || !tools) return;
    let hidden = false;
    const setHidden = (h) => { hidden = h; sidebar.classList.toggle("tools-hidden", h); };

    sidebar.addEventListener("scroll", (e) => {
      if (!isMobileView()) return;
      const el = e.target;
      if (!el || el.id === "libTools") return;
      const top = el.scrollTop;
      if (!hidden) {
        // only collapse when the list stays scrollable after it grows by the height of the tools
        const spare = el.scrollHeight - el.clientHeight - tools.offsetHeight;
        if (top > 60 && spare > 120) setHidden(true);
      } else if (top <= 2) {
        setHidden(false);
      }
    }, true);

    window.showLibTools = () => setHidden(false);

    // New section / tab / search: always start with the tools visible
    document.querySelectorAll(".nav-btn").forEach(b => b.addEventListener("click", () => setHidden(false)));
    document.addEventListener("focusin", (e) => { if (e.target && e.target.id === "searchInput") setHidden(false); });
  })();

  // Search box: clear (×) button, visible only while there is text
  (function () {
    const input = document.getElementById("searchInput");
    const clear = document.getElementById("searchClear");
    if (!input || !clear) return;
    const box = input.parentElement;
    const refresh = () => box.classList.toggle("has-text", input.value.length > 0);
    input.addEventListener("input", refresh);
    input.addEventListener("focus", refresh);
    clear.addEventListener("click", () => {
      input.value = "";
      refresh();
      if (typeof window.filterSongs === "function") window.filterSongs("");
      input.focus();
    });
  })();

  // Library screen: swipe left/right to move between Library · Favorites · Playlists · History · Queue
  (function () {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    const ORDER = ["library", "favorites", "playlists", "history", "queue"];
    let sx = 0, sy = 0, tracking = false;
    sidebar.addEventListener("touchstart", (e) => {
      tracking = e.touches.length === 1 && !(e.target.closest && e.target.closest("input, .pl-popup, .dlg-overlay"));
      if (tracking) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
    }, { passive: true });
    sidebar.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      if (!isMobileView() || activeTab !== "library" || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;   // must be a clear sideways swipe
      const cur = ORDER.indexOf(typeof currentSection !== "undefined" ? currentSection : "library");
      const next = cur + (dx < 0 ? 1 : -1);
      if (cur < 0 || next < 0 || next >= ORDER.length) return;
      if (typeof window.showSection === "function") {
        window.showSection(ORDER[next]);
        if (typeof window.showLibTools === "function") window.showLibTools();
      }
    }, { passive: true });
  })();

  // Initial tab setup on load
  document.addEventListener("DOMContentLoaded", () => {
    if (isMobileView()) {
      switchMobileTab("library");
    }
  });

})();
