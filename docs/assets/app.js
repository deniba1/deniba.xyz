(() => {
  "use strict";
  const P = window.PROFILE || {};
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ICONS = {
    github: '<path fill="currentColor" d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.1-.75.08-.73.08-.73 1.21.09 1.85 1.25 1.85 1.25 1.08 1.84 2.83 1.31 3.52 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.19.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.82 1.1.82 2.22v3.29c0 .32.21.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z"/>',
    discord: '<path fill="currentColor" d="M20.32 4.37A19.8 19.8 0 0 0 16.56 3c-.2.36-.43.85-.59 1.23a18.3 18.3 0 0 0-5.94 0A12.6 12.6 0 0 0 9.44 3a19.7 19.7 0 0 0-3.76 1.37C1.98 9.05 1.13 13.58 1.5 18.06A19.9 19.9 0 0 0 7.5 21c.41-.55.77-1.14 1.08-1.76-.6-.22-1.16-.49-1.7-.81l.42-.33a13.9 13.9 0 0 0 11.4 0l.42.33c-.54.32-1.11.59-1.7.81.31.62.67 1.2 1.08 1.76a19.9 19.9 0 0 0 6-2.94c.44-5.2-.75-9.69-3.68-13.69ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.41s.95-2.41 2.15-2.41 2.17 1.09 2.15 2.41c0 1.33-.95 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41s.95-2.41 2.15-2.41 2.17 1.09 2.15 2.41c0 1.33-.94 2.41-2.15 2.41Z"/>',
    youtube: '<path fill="currentColor" d="M23.5 6.2a3 3 0 0 0-2.11-2.12C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.39.58A3 3 0 0 0 .5 6.2 31.3 31.3 0 0 0 0 12a31.3 31.3 0 0 0 .5 5.8 3 3 0 0 0 2.11 2.12c1.89.58 9.39.58 9.39.58s7.5 0 9.39-.58a3 3 0 0 0 2.11-2.12A31.3 31.3 0 0 0 24 12a31.3 31.3 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"/>',
    x: '<path fill="currentColor" d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z"/>',
    twitch: '<path fill="currentColor" d="M2.15 0 .5 4.2v17.1h5.85V24h3.3l2.7-2.7h4.35L22.5 15.6V0H2.15Zm18.3 14.55-3.3 3.3h-5.4l-2.7 2.7v-2.7H4.65V2.1h15.8v12.45ZM17.1 6.3v6.3h-2.1V6.3h2.1Zm-5.7 0v6.3H9.3V6.3h2.1Z"/>',
    tiktok: '<path fill="currentColor" d="M16.6 0h-3.95v16.2a3.45 3.45 0 1 1-2.45-3.3V8.85a7.4 7.4 0 1 0 6.4 7.35V8.1a9.3 9.3 0 0 0 5.4 1.75V5.9A5.45 5.45 0 0 1 16.6 0Z"/>',
    roblox: '<path fill="currentColor" d="M5.16 0 0 18.83 18.84 24 24 5.17 5.16 0Zm8.1 15.04-4.3-1.15 1.16-4.3 4.3 1.15-1.16 4.3Z"/>',
    email: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 5h18v14H3zM3 6l9 7 9-7"/>',
    link: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.link}</svg>`;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const toastEl = $("toast");
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 1800);
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); toast(`copied ${label}`); }
    catch { toast(text); }
  }

  /* ---------- profile basics ---------- */
  const name = P.name || "deni";
  $("name").textContent = name;
  $("avatarMono").textContent = name.charAt(0).toLowerCase();
  $("handle").textContent = "@" + (P.handle || P.github || name);
  $("bio").textContent = P.bio || "";
  $("location").textContent = P.location || "earth";
  $("year").textContent = new Date().getFullYear();

  function setAvatar(src) {
    const img = $("avatarImg");
    img.onerror = () => { img.hidden = true; };
    img.onload = () => { img.hidden = false; };
    img.src = src;
  }
  if (P.avatar) setAvatar(P.avatar);

  /* ---------- clock ---------- */
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: P.timezone || undefined });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  }
  const tick = () => { $("clock").textContent = fmt.format(new Date()).toLowerCase(); };
  tick();
  setInterval(tick, 10_000);

  /* ---------- socials ---------- */
  const socials = $("socials");
  const links = [];
  if (P.github) links.push({ label: "GitHub", icon: "github", url: `https://github.com/${P.github}` });
  if (P.discordId) links.push({ label: "Discord", icon: "discord", url: `https://discord.com/users/${P.discordId}`, copy: P.discordUsername });
  (P.links || []).forEach((l) => { if (l && l.url) links.push(l); });
  if (P.email) links.push({ label: "Email", icon: "email", email: P.email });

  links.forEach((l, i) => {
    let n;
    if (l.email) {
      n = el("button", "social");
      n.type = "button";
      n.title = "click to copy";
      n.addEventListener("click", () => copy(l.email, "email"));
    } else {
      n = el("a", "social");
      n.href = l.url;
      n.target = "_blank";
      n.rel = "noopener";
    }
    n.style.setProperty("--i", i);
    n.innerHTML = svg(l.icon);
    n.append(el("span", "social__label", l.email ? l.email : l.label), el("span", "social__arrow", l.email ? "⧉" : "↗"));
    socials.append(n);
  });

  /* ---------- projects ---------- */
  function spotlight(card) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--px", `${e.clientX - r.left}px`);
      card.style.setProperty("--py", `${e.clientY - r.top}px`);
    });
  }

  const projects = $("projects");
  (P.projects || []).forEach((p, i) => {
    const a = el("a", "project glass");
    a.href = p.url;
    if (/^https?:/.test(p.url)) { a.target = "_blank"; a.rel = "noopener"; }
    a.style.setProperty("--i", i);
    const top = el("div", "project__top");
    top.append(el("span", "project__name", p.name));
    if (p.status) top.append(el("span", `project__status project__status--${p.status}`, p.status));
    a.append(top, el("p", "project__desc", p.desc || ""));
    if (p.tags && p.tags.length) {
      const tags = el("div", "project__tags");
      p.tags.forEach((t) => tags.append(el("span", null, t)));
      a.append(tags);
    }
    const link = el("span", "project__link", p.linkText || p.url.replace(/^https?:\/\//, ""));
    link.append(el("span", "project__arrow", "↗"));
    a.append(link);
    spotlight(a);
    projects.append(a);
  });

  /* ---------- stack ---------- */
  const stack = $("stack");
  (P.stack || []).forEach((s, i) => {
    const li = el("li", null, s);
    li.style.setProperty("--i", i);
    stack.append(li);
  });

  /* ---------- github ---------- */
  if (P.github) {
    const shown = new Set((P.projects || []).map((p) => (p.url || "").toLowerCase()));
    fetch(`https://api.github.com/users/${P.github}/repos?per_page=100&sort=pushed`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((repos) => {
        $("repoCount").textContent = repos.length;
        $("repoItem").hidden = false;
        const extra = repos.filter((r) => !r.fork && !r.archived &&
          ![...shown].some((u) => u.startsWith(r.html_url.toLowerCase())));
        if (!extra.length) return;
        const grid = $("repos");
        extra.slice(0, 6).forEach((r, i) => {
          const a = el("a", "project glass");
          a.href = r.html_url; a.target = "_blank"; a.rel = "noopener";
          a.style.setProperty("--i", i);
          const top = el("div", "project__top");
          top.append(el("span", "project__name", r.name));
          a.append(top);
          if (r.description) a.append(el("p", "project__desc", r.description));
          const stats = el("div", "repo__stats");
          if (r.language) stats.append(el("span", "repo__lang", r.language.toLowerCase()));
          if (r.stargazers_count) stats.append(el("span", null, `★ ${r.stargazers_count}`));
          const link = el("span", "project__link", `github.com/${P.github}/${r.name}`);
          link.append(el("span", "project__arrow", "↗"));
          a.append(stats, link);
          spotlight(a);
          grid.append(a);
        });
        $("reposBlock").hidden = false;
        $("stackNum").textContent = "03";
      })
      .catch(() => {});
  }

  /* ---------- discord presence (lanyard) ---------- */
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const elapsedText = (start) => {
    const m = Math.floor((Date.now() - start) / 60000);
    return m < 60 ? `${m}m elapsed` : `${Math.floor(m / 60)}h ${m % 60}m elapsed`;
  };
  function assetUrl(act, key) {
    const img = act.assets && act.assets[key];
    if (!img) return "";
    if (img.startsWith("mp:")) return `https://media.discordapp.net/${img.slice(3)}`;
    if (img.startsWith("spotify:")) return `https://i.scdn.co/image/${img.slice(8)}`;
    return act.application_id ? `https://cdn.discordapp.com/app-assets/${act.application_id}/${img}.png` : "";
  }

  let progressTimer;
  function renderPresence(d) {
    const status = d.discord_status || "offline";
    const labels = { online: "online", idle: "idle", dnd: "do not disturb", offline: "offline" };
    const custom = (d.activities || []).find((a) => a.type === 4);
    const presence = $("presence");
    presence.dataset.status = status;
    $("statusDot").dataset.status = status;
    $("statusDot").hidden = false;
    let text = labels[status];
    if (custom && (custom.state || custom.emoji)) {
      text = [custom.emoji && !custom.emoji.id ? custom.emoji.name : "", custom.state || ""].join(" ").trim();
    }
    $("presenceText").textContent = text;
    presence.hidden = false;

    const u = d.discord_user;
    if (!P.avatar && u && u.avatar) {
      const ext = u.avatar.startsWith("a_") ? "gif" : "webp";
      const src = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=256`;
      if ($("avatarImg").getAttribute("src") !== src) setAvatar(src);
    }

    clearInterval(progressTimer);
    const box = $("activity");
    const art = $("activityArt");
    const bar = $("activityBar"), times = $("activityTimes");

    if (d.listening_to_spotify && d.spotify) {
      const s = d.spotify;
      $("activityKind").textContent = "listening to spotify";
      $("activityTitle").textContent = s.song;
      $("activitySub").textContent = s.artist ? s.artist.replace(/;/g, ",") : "";
      art.src = s.album_art_url || "";
      bar.hidden = times.hidden = false;
      const { start, end } = s.timestamps || {};
      const step = () => {
        if (!start || !end) return;
        const total = end - start, now = Math.min(Date.now() - start, total);
        $("activityFill").style.width = `${(now / total) * 100}%`;
        $("activityElapsed").textContent = mmss(now);
        $("activityTotal").textContent = mmss(total);
      };
      step();
      progressTimer = setInterval(step, 1000);
      box.hidden = false;
      return;
    }

    const act = (d.activities || []).find((a) => a.type !== 4 && a.name !== "Spotify");
    if (!act) { box.hidden = true; return; }
    const kinds = { 0: "playing", 1: "streaming", 2: "listening to", 3: "watching", 5: "competing in" };
    $("activityKind").textContent = `${kinds[act.type] || "playing"} ${act.name}`.toLowerCase();
    $("activityTitle").textContent = act.details || act.name;
    const sub = () => {
      const bits = [act.state, act.timestamps && act.timestamps.start ? elapsedText(act.timestamps.start) : ""].filter(Boolean);
      $("activitySub").textContent = bits.join(" · ");
    };
    sub();
    progressTimer = setInterval(sub, 30_000);
    art.src = assetUrl(act, "large_image");
    bar.hidden = times.hidden = true;
    box.hidden = false;
  }

  if (P.discordId) {
    const load = () => fetch(`https://api.lanyard.rest/v1/users/${P.discordId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j.success && j.data) renderPresence(j.data); })
      .catch(() => {});
    load();
    setInterval(load, 20_000);
  }

  /* ---------- pointer effects ---------- */
  const card = $("card");
  const fine = matchMedia("(pointer: fine)").matches;
  if (fine && !reduceMotion) {
    addEventListener("pointermove", (e) => {
      document.body.style.setProperty("--mx", `${e.clientX}px`);
      document.body.style.setProperty("--my", `${e.clientY}px`);
    }, { passive: true });
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty("--ry", `${x * 8}deg`);
      card.style.setProperty("--rx", `${-y * 8}deg`);
      card.style.setProperty("--edge", `${130 + x * 90}deg`);
    });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    });
  }

  /* ---------- star field ---------- */
  const cv = $("sky");
  const ctx = cv.getContext("2d");
  let W, H, DPR, stars = [], shooting = null;
  let mx = 0, my = 0, tx = 0, ty = 0;

  function resize() {
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const count = Math.round(Math.min(260, (W * H) / 6500));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      z: Math.random() * 0.9 + 0.1,               // depth: bigger, brighter, more parallax when close
      tw: Math.random() * Math.PI * 2, ts: 0.6 + Math.random() * 1.6,
      tint: Math.random() < 0.12,
    }));
  }
  resize();
  addEventListener("resize", resize);
  if (fine) addEventListener("pointermove", (e) => { tx = e.clientX / W - 0.5; ty = e.clientY / H - 0.5; }, { passive: true });

  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
    const time = t / 1000;
    for (const s of stars) {
      if (!reduceMotion) { s.y -= s.z * 0.06; if (s.y < -4) { s.y = H + 4; s.x = Math.random() * W; } }
      const x = s.x - mx * 40 * s.z, y = s.y - my * 40 * s.z;
      const a = (0.25 + 0.75 * s.z) * (0.65 + 0.35 * Math.sin(time * s.ts + s.tw));
      ctx.fillStyle = s.tint ? `rgba(196,245,106,${a})` : `rgba(235,240,232,${a})`;
      const r = s.z * 1.35;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduceMotion) {
      if (!shooting && Math.random() < 0.0025) {
        shooting = { x: Math.random() * W * 0.7 + W * 0.3, y: Math.random() * H * 0.4, vx: -(6 + Math.random() * 4), vy: 2.2 + Math.random() * 1.5, life: 1 };
      }
      if (shooting) {
        const s = shooting;
        const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 14, s.y - s.vy * 14);
        g.addColorStop(0, `rgba(230,255,210,${s.life})`);
        g.addColorStop(1, "rgba(230,255,210,0)");
        ctx.strokeStyle = g; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 14, s.y - s.vy * 14); ctx.stroke();
        s.x += s.vx; s.y += s.vy; s.life -= 0.012;
        if (s.life <= 0 || s.x < -200 || s.y > H + 200) shooting = null;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
