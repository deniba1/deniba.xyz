// deniOS window manager: desktop icons, draggable windows, taskbar, start menu.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const desktop = $("desktop");
  const taskWins = $("taskWins");
  const startBtn = $("startBtn"), startMenu = $("startMenu");
  const TASKBAR = 60;
  const small = () => innerWidth < 720;

  const BUTTONS = `
    <button class="win__btn" data-act="min" type="button" aria-label="minimise"><span class="g g--min"></span></button>
    <button class="win__btn" data-act="max" type="button" aria-label="maximise"><span class="g g--max"></span></button>
    <button class="win__btn win__btn--close" data-act="close" type="button" aria-label="close"><span class="g g--close"></span></button>`;

  // Default sizes and positions as fractions of the free desktop area.
  const LAYOUT = {
    about: { w: 420, x: 0.16, y: 0.07 },
    projects: { w: 600, x: 0.52, y: 0.16 },
    system: { w: 400, x: 0.36, y: 0.24 },
  };

  const wins = {};
  let z = 10;

  document.querySelectorAll(".win").forEach((win) => {
    const id = win.dataset.win;
    const bar = document.createElement("header");
    bar.className = "win__bar";
    bar.innerHTML = `<span class="icon__img icon__img--${win.dataset.icon}"></span><span class="win__title">${win.dataset.title}</span><span class="win__btns">${BUTTONS}</span>`;
    win.prepend(bar);
    const L = LAYOUT[id] || { w: 420, x: 0.3, y: 0.2 };
    win.style.width = `${L.w}px`;
    wins[id] = { el: win, bar, placed: false, L, task: null };

    bar.addEventListener("dblclick", (e) => { if (!e.target.closest(".win__btn")) toggleMax(id); });
    bar.querySelectorAll(".win__btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      ({ min: minimise, max: toggleMax, close })[b.dataset.act](id);
    }));
    win.addEventListener("pointerdown", () => focus(id));
    drag(id);
  });

  function place(id) {
    const w = wins[id];
    if (w.placed) return;
    const W = innerWidth, H = innerHeight - TASKBAR;
    const width = Math.min(w.L.w, W - 24);
    const x = Math.round(Math.min(Math.max(96, W * w.L.x), W - width - 12));
    const y = Math.round(Math.max(12, H * w.L.y));
    w.el.style.left = `${x}px`;
    w.el.style.top = `${y}px`;
    w.placed = true;
  }

  function focus(id) {
    Object.values(wins).forEach((w) => {
      w.el.classList.toggle("is-active", w === wins[id]);
      if (w.task) w.task.classList.toggle("is-active", w === wins[id] && !w.el.hidden);
    });
    wins[id].el.style.zIndex = ++z;
  }

  function open(id) {
    if (id === "music") { openMusic(); return; }
    const w = wins[id];
    if (!w) return;
    if (small()) Object.keys(wins).forEach((k) => { if (k !== id && !wins[k].el.hidden) minimise(k); });
    place(id);
    w.el.hidden = false;
    w.el.classList.remove("is-closing");
    w.el.classList.add("is-opening");
    setTimeout(() => w.el.classList.remove("is-opening"), 250);
    if (!w.task) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "task__win";
      t.innerHTML = `<span class="icon__img icon__img--${w.el.dataset.icon}"></span><span>${w.el.dataset.title}</span>`;
      t.addEventListener("click", () => {
        if (w.el.hidden) open(id);
        else if (w.el.classList.contains("is-active")) minimise(id);
        else focus(id);
      });
      taskWins.append(t);
      w.task = t;
    }
    focus(id);
  }

  function minimise(id) {
    const w = wins[id];
    w.el.hidden = true;
    if (w.task) w.task.classList.remove("is-active");
  }

  function close(id) {
    const w = wins[id];
    w.el.hidden = true;
    w.el.classList.remove("is-max");
    if (w.task) { w.task.remove(); w.task = null; }
  }

  function toggleMax(id) {
    if (small()) return;
    wins[id].el.classList.toggle("is-max");
    focus(id);
  }

  function drag(id) {
    const { el, bar } = wins[id];
    let sx, sy, ox, oy, moving = false;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".win__btn") || el.classList.contains("is-max") || small()) return;
      moving = true;
      sx = e.clientX; sy = e.clientY;
      ox = el.offsetLeft; oy = el.offsetTop;
      bar.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
    });
    bar.addEventListener("pointermove", (e) => {
      if (!moving) return;
      const W = innerWidth, H = innerHeight - TASKBAR;
      const x = Math.min(Math.max(ox + e.clientX - sx, 80 - el.offsetWidth), W - 80);
      const y = Math.min(Math.max(oy + e.clientY - sy, 0), H - 32);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
    const end = () => { moving = false; el.classList.remove("is-dragging"); };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  // music lives in the taskbar: "opening" it expands the player panel
  function openMusic() {
    const p = $("player");
    if (!p || p.hidden) return;
    p.classList.add("is-open");
  }

  /* ---------- desktop icons: one click selects, double-click (or a tap) opens ---------- */
  const icons = document.querySelectorAll(".icon");
  icons.forEach((icon) => {
    icon.addEventListener("click", (e) => {
      const touch = matchMedia("(hover: none)").matches;
      icons.forEach((i) => i.classList.toggle("is-selected", i === icon));
      if (icon.dataset.open && (touch || e.detail >= 2)) open(icon.dataset.open);
      if (icon.tagName === "A" && !touch && e.detail < 2) e.preventDefault();   // links open on double-click
    });
    icon.addEventListener("dblclick", () => {
      if (icon.tagName === "A") window.open(icon.href, "_blank", "noopener");
    });
    icon.addEventListener("keydown", (e) => { if (e.key === "Enter" && icon.dataset.open) open(icon.dataset.open); });
  });
  desktop.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".icon")) icons.forEach((i) => i.classList.remove("is-selected"));
  });

  /* ---------- start menu ---------- */
  function setStart(openIt) {
    startMenu.hidden = !openIt;
    startBtn.classList.toggle("is-pressed", openIt);
    startBtn.setAttribute("aria-expanded", openIt);
  }
  startBtn.addEventListener("click", () => setStart(startMenu.hidden));
  startMenu.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { setStart(false); open(b.dataset.open); }));
  document.addEventListener("pointerdown", (e) => {
    if (!startMenu.hidden && !startMenu.contains(e.target) && !startBtn.contains(e.target)) setStart(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setStart(false); });

  const shutdown = $("shutdown");
  $("shutdownBtn").addEventListener("click", () => {
    setStart(false);
    shutdown.hidden = false;
    const pause = $("pPlay");
    if (document.getElementById("player").classList.contains("is-playing")) pause.click();
  });
  shutdown.addEventListener("click", () => {
    shutdown.classList.add("is-booting");
    setTimeout(() => { shutdown.hidden = true; shutdown.classList.remove("is-booting"); }, 900);
  });

  addEventListener("resize", () => {
    Object.values(wins).forEach((w) => {
      if (!w.placed) return;
      const maxX = innerWidth - 80, maxY = innerHeight - TASKBAR - 32;
      if (w.el.offsetLeft > maxX) w.el.style.left = `${Math.max(0, maxX)}px`;
      if (w.el.offsetTop > maxY) w.el.style.top = `${Math.max(0, maxY)}px`;
    });
  });

  // first boot: about.txt open (and projects too, when there is room)
  open("about");
  if (!small() && innerWidth >= 1100) open("projects");
  focus("about");
})();
