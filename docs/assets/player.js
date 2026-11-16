// Music dock: shuffled playback of the Spotify playlist in assets/playlist.json.
// Full songs play through YouTube's embedded player (the GitHub Action matches
// each track to a YouTube upload); if a track has no match, or none of its
// videos allow embedding, it falls back to Spotify's 30-second preview.
(() => {
  "use strict";
  const P = window.PROFILE || {};
  if (!P.spotifyPlaylist) return;

  const $ = (id) => document.getElementById(id);
  const root = $("player");
  const ui = {
    prev: $("pPrev"), next: $("pNext"), play: $("pPlay"), now: $("pNow"),
    cover: $("pCover"), title: $("pTitle"), titleLg: $("pTitleLg"), artist: $("pArtist"),
    explicit: $("pExplicit"), cur: $("pCur"), dur: $("pDur"), seek: $("pSeek"),
    line: $("pLine"), shuffle: $("pShuffle"), repeat: $("pRepeat"), mute: $("pMute"),
    vol: $("pVol"), open: $("pOpen"), queue: $("pQueue"), playlist: $("pPlaylist"),
  };

  const store = {
    get: (k, d) => { try { const v = localStorage.getItem("player." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem("player." + k, JSON.stringify(v)); } catch {} },
  };

  let tracks = [];          // playable tracks from playlist.json
  let order = [];           // track ids in play order
  let pos = 0;              // index into order
  let shuffle = store.get("shuffle", true);
  let repeat = false;
  let volume = store.get("volume", 60);
  let muted = store.get("muted", false);
  let playing = false;
  let wantPlay = false;     // the visitor pressed play; keep playing across track changes
  let seeking = false;

  const current = () => tracks.find((t) => t.id === order[pos]);
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function shuffled(ids) {
    const a = ids.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------- engines: YouTube (full songs) and <audio> (previews) ---------- */
  const audio = new Audio();
  audio.preload = "none";
  let yt = null, ytReady = false, ytFailed = false;
  let engine = "audio";
  let candidate = 0;        // which of the track's YouTube ids is loaded
  let loadToken = 0;

  function loadYouTubeApi() {
    const holder = document.createElement("div");
    holder.className = "player__yt";
    holder.innerHTML = '<div id="pYT"></div>';
    document.body.append(holder);
    window.onYouTubeIframeAPIReady = () => {
      yt = new YT.Player("pYT", {
        width: 200, height: 200,
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { ytReady = true; applyVolume(); load(wantPlay); },
          onStateChange: (e) => {
            if (engine !== "yt") return;
            if (e.data === YT.PlayerState.PLAYING) setPlaying(true);
            else if (e.data === YT.PlayerState.PAUSED) setPlaying(false);
            else if (e.data === YT.PlayerState.ENDED) ended();
          },
          onError: () => { if (engine === "yt") nextCandidate(); },   // embedding disabled, removed, etc.
        },
      });
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { ytFailed = true; load(wantPlay); };
    document.head.append(s);
    setTimeout(() => { if (!ytReady && !ytFailed) { ytFailed = true; load(wantPlay); } }, 8000);
  }

  function stopAll() {
    audio.pause();
    if (ytReady) try { yt.stopVideo(); } catch {}
  }

  function load(autoplay) {
    const t = current();
    if (!t) return;
    const token = ++loadToken;
    candidate = 0;
    render();
    stopAll();
    const ids = t.youtube || [];
    if (ids.length && ytReady) {
      engine = "yt";
      autoplay ? yt.loadVideoById(ids[0]) : yt.cueVideoById(ids[0]);
    } else if (ids.length && !ytReady && !ytFailed) {
      engine = "yt";        // the API is still loading; onReady calls load() again
    } else {
      usePreview(autoplay, token);
    }
  }

  function nextCandidate() {
    const t = current();
    candidate++;
    if (t && t.youtube && candidate < t.youtube.length) {
      wantPlay ? yt.loadVideoById(t.youtube[candidate]) : yt.cueVideoById(t.youtube[candidate]);
    } else {
      usePreview(wantPlay, loadToken);
    }
  }

  function usePreview(autoplay, token) {
    const t = current();
    engine = "audio";
    renderSource();
    if (!t || !t.preview) { if (wantPlay) skip(1); return; }
    audio.src = t.preview;
    if (autoplay && token === loadToken) audio.play().catch(() => setPlaying(false));
  }

  audio.addEventListener("playing", () => engine === "audio" && setPlaying(true));
  audio.addEventListener("pause", () => engine === "audio" && setPlaying(false));
  audio.addEventListener("ended", () => engine === "audio" && ended());
  audio.addEventListener("error", () => { if (engine === "audio" && wantPlay && audio.src) skip(1); });

  const time = () => engine === "yt" && ytReady ? (yt.getCurrentTime() || 0) : audio.currentTime || 0;
  const length = () => {
    if (engine === "yt" && ytReady) return yt.getDuration() || (current() ? current().duration / 1000 : 0);
    return isFinite(audio.duration) && audio.duration ? audio.duration : 30;
  };

  function play() {
    wantPlay = true;
    if (engine === "yt" && ytReady) yt.playVideo();
    else if (engine === "audio") audio.play().catch(() => setPlaying(false));
  }
  function pause() {
    wantPlay = false;
    if (engine === "yt" && ytReady) yt.pauseVideo();
    else audio.pause();
  }
  function seekTo(frac) {
    const s = frac * length();
    if (engine === "yt" && ytReady) yt.seekTo(s, true);
    else audio.currentTime = s;
  }
  function applyVolume() {
    const v = muted ? 0 : volume;
    audio.volume = v / 100;
    if (ytReady) { yt.setVolume(v); muted || v === 0 ? yt.mute() : yt.unMute(); }
    ui.vol.value = v;
    ui.vol.style.setProperty("--fill", `${v}%`);
    root.classList.toggle("is-muted", v === 0);
    ui.mute.setAttribute("aria-label", v === 0 ? "unmute" : "mute");
  }

  function ended() {
    if (repeat) { seekTo(0); play(); return; }
    skip(1);
  }

  function skip(dir) {
    if (!order.length) return;
    if (dir < 0 && time() > 3) { seekTo(0); return; }
    pos += dir;
    if (pos >= order.length) {
      // end of the list: reshuffle, without repeating the song that just played
      const last = order[order.length - 1];
      order = shuffle ? shuffled(order) : order;
      if (shuffle && order[0] === last && order.length > 1) order.push(order.shift());
      pos = 0;
    }
    if (pos < 0) pos = order.length - 1;
    load(wantPlay);
  }

  function setPlaying(v) {
    playing = v;
    if (v) root.classList.remove("is-waiting");
    root.classList.toggle("is-playing", v);
    ui.play.setAttribute("aria-label", v ? "pause" : "play");
    ui.play.title = v ? "pause" : "play";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = v ? "playing" : "paused";
  }

  /* ---------- rendering ---------- */
  function renderSource() {
    root.classList.toggle("is-preview", engine === "audio");
  }

  function render() {
    const t = current();
    if (!t) return;
    ui.cover.src = t.cover || "";
    ui.title.textContent = t.title;
    ui.titleLg.textContent = t.title;
    ui.titleLg.href = `https://open.spotify.com/track/${t.id}`;
    ui.open.href = `https://open.spotify.com/track/${t.id}`;
    ui.artist.textContent = t.artist;
    ui.explicit.hidden = !t.explicit;
    ui.cur.textContent = "0:00";
    ui.dur.textContent = fmt(t.youtube && t.youtube.length ? t.duration / 1000 : 30);
    ui.line.style.width = "0";
    ui.seek.value = 0;
    ui.seek.style.setProperty("--fill", "0%");
    renderSource();
    marquee();
    renderQueue();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist,
        artwork: t.cover ? [{ src: t.cover, sizes: "300x300", type: "image/jpeg" }] : [],
      });
    }
  }

  function marquee() {
    const box = ui.title.parentElement;
    ui.title.classList.remove("is-scrolling");
    ui.title.style.removeProperty("--shift");
    requestAnimationFrame(() => {
      const over = ui.title.scrollWidth - box.clientWidth;
      if (over > 4) {
        ui.title.style.setProperty("--shift", `-${over + 12}px`);
        ui.title.style.setProperty("--dur", `${Math.max(6, over / 18)}s`);
        ui.title.classList.add("is-scrolling");
      }
    });
  }

  function renderQueue() {
    ui.queue.textContent = "";
    const upcoming = order.slice(pos + 1).concat(order.slice(0, pos));
    upcoming.forEach((id) => {
      const t = tracks.find((x) => x.id === id);
      if (!t) return;
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const img = document.createElement("img");
      img.src = t.cover || ""; img.alt = ""; img.loading = "lazy";
      const txt = document.createElement("span");
      const tt = document.createElement("b"); tt.textContent = t.title;
      const ta = document.createElement("i"); ta.textContent = t.artist;
      txt.append(tt, ta);
      b.append(img, txt);
      b.addEventListener("click", () => {
        pos = order.indexOf(id);
        wantPlay = true;
        load(true);
      });
      li.append(b);
      ui.queue.append(li);
    });
  }

  setInterval(() => {
    if (seeking || !current()) return;
    const len = length(), now = time();
    const frac = len ? Math.min(1, now / len) : 0;
    ui.cur.textContent = fmt(now);
    ui.dur.textContent = fmt(len);
    ui.line.style.width = `${frac * 100}%`;
    ui.seek.value = Math.round(frac * 1000);
    ui.seek.style.setProperty("--fill", `${frac * 100}%`);
  }, 250);

  /* ---------- controls ---------- */
  ui.play.addEventListener("click", () => (playing ? pause() : play()));

  /* ---------- autoplay ----------
     Browsers refuse to start sound before the visitor has interacted with the
     page (Chrome and Edge make an exception for sites someone plays media on
     often). So: ask to play as soon as the first song is ready, and if that is
     refused, start on the first click, tap or key press anywhere. Presses on
     the dock itself are left to its own buttons. */
  const GESTURES = ["click", "keydown", "touchend"];
  function onFirstGesture(e) {
    GESTURES.forEach((g) => document.removeEventListener(g, onFirstGesture, true));
    if (root.contains(e.target) || playing || !wantPlay) return;
    play();
  }
  GESTURES.forEach((g) => document.addEventListener(g, onFirstGesture, true));
  setTimeout(() => { if (wantPlay && !playing) root.classList.add("is-waiting"); }, 3500);
  ui.next.addEventListener("click", () => skip(1));
  ui.prev.addEventListener("click", () => skip(-1));
  ui.now.addEventListener("click", () => root.classList.toggle("is-open"));
  document.addEventListener("pointerdown", (e) => { if (!root.contains(e.target)) root.classList.remove("is-open"); });

  ui.seek.addEventListener("input", () => {
    seeking = true;
    const f = ui.seek.value / 1000;
    ui.seek.style.setProperty("--fill", `${f * 100}%`);
    ui.cur.textContent = fmt(f * length());
  });
  ui.seek.addEventListener("change", () => { seekTo(ui.seek.value / 1000); seeking = false; });

  ui.vol.addEventListener("input", () => {
    volume = +ui.vol.value;
    muted = volume === 0;
    store.set("volume", volume); store.set("muted", muted);
    applyVolume();
  });
  ui.mute.addEventListener("click", () => {
    if (volume === 0) volume = 60;
    muted = !muted;
    store.set("muted", muted); store.set("volume", volume);
    applyVolume();
  });

  function renderToggles() {
    ui.shuffle.setAttribute("aria-pressed", shuffle);
    ui.repeat.setAttribute("aria-pressed", repeat);
  }
  ui.shuffle.addEventListener("click", () => {
    shuffle = !shuffle;
    store.set("shuffle", shuffle);
    const id = order[pos];
    const ids = tracks.map((t) => t.id);
    order = shuffle ? [id, ...shuffled(ids.filter((x) => x !== id))] : ids;
    pos = order.indexOf(id);
    renderToggles();
    renderQueue();
  });
  ui.repeat.addEventListener("click", () => { repeat = !repeat; renderToggles(); });

  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", play);
    ms.setActionHandler("pause", pause);
    ms.setActionHandler("nexttrack", () => skip(1));
    ms.setActionHandler("previoustrack", () => skip(-1));
  }

  /* ---------- playlist loading and live updates ---------- */
  function applyPlaylist(data) {
    const fresh = (data.tracks || []).filter((t) => (t.youtube && t.youtube.length) || t.preview);
    if (!fresh.length) return;
    if (data.url) { ui.playlist.href = data.url; ui.playlist.textContent = `${data.name || "playlist"} ↗`; }

    const first = !tracks.length;
    const oldIds = new Set(tracks.map((t) => t.id));
    tracks = fresh;
    const ids = fresh.map((t) => t.id);
    const idSet = new Set(ids);

    if (first) {
      order = shuffle ? shuffled(ids) : ids;
      pos = 0;
      root.hidden = false;
      renderToggles();
      applyVolume();
      wantPlay = true;      // autoplay; see the autoplay block above
      load(true);
      return;
    }
    // Songs added or removed since the page opened: keep the current song,
    // drop removed ones from the queue and slot new ones in at random.
    const cur = order[pos];
    const added = ids.filter((id) => !oldIds.has(id));
    let next = order.filter((id) => idSet.has(id));
    added.forEach((id) => {
      const at = shuffle ? pos + 1 + Math.floor(Math.random() * (next.length - pos)) : next.length;
      next.splice(Math.min(at, next.length), 0, id);
    });
    if (!shuffle) next = ids;
    order = next;
    if (idSet.has(cur)) {
      pos = order.indexOf(cur);
      renderQueue();
    } else {
      pos = Math.min(pos, order.length - 1);
      load(wantPlay);
    }
  }

  function fetchPlaylist() {
    return fetch(`assets/playlist.json?t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(applyPlaylist)
      .catch(() => {});
  }

  fetchPlaylist();
  setInterval(fetchPlaylist, 5 * 60 * 1000);
  loadYouTubeApi();
})();
