// art.example.com — общий холст с регистрацией.
//
// СИСТЕМА КООРДИНАТ. Операции хранятся в МИРОВЫХ координатах (большой холст
// WORLD), экран — это «камера» с отступом V.x/V.y и масштабом V.k. Раньше
// координаты были экранными, поэтому при переносе или зуме рисунок уезжал и
// разные участники видели разное.

const WORLD = { w: 6000, h: 4000 };
const MINI_W = 168;

const COLORS = ["#ff2e9a", "#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#fb7185",
  "#a3e635", "#60a5fa", "#f472b6", "#facc15", "#2dd4bf", "#c084fc",
  "#ffffff", "#0a0a0c"];

const TOOLS = {
  brush: { label: "кисть", icon: "brush" },
  eraser: { label: "ластик", icon: "eraser" },
  text: { label: "текст", icon: "type" },
  hand: { label: "перенос", icon: "hand" },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  tool: "brush",
  color: "#ff2e9a",
  size: 6,
  user: null,
  me: null,
  admin: false,
  ops: [],
  online: [],
  ws: null,
  queue: [],
  cursors: new Map(),
};

const V = { x: 0, y: 0, k: 1 };

const cv = $("#cv");
const ctx = cv.getContext("2d");
const cvs = $("#cur");
const gcur = cvs.getContext("2d");
const mcv = $("#mcv");
const mctx = mcv.getContext("2d");

let dpr = 1;
let W = 0;
let H = 0;

// ── экран ⇄ мир ─────────────────────────────────────────────────────────────
const s2w = (x, y) => [(x - V.x) / V.k, (y - V.y) / V.k];

function viewW() { return W / V.k; }
function viewH() { return H / V.k; }

// не даём уехать за пределы холста; если окно больше мира — центрируем
function clampView() {
  const vw = viewW();
  const vh = viewH();
  // V.x это сдвиг МИРА относительно экрана, поэтому он отрицательный:
  // 0 — левый край мира, (vw - WORLD.w) — правый.
  // Раньше тут стояло Math.max(WORLD.w - vw, ...) — это положительное число,
  // и внешний Math.min(0, ...) срезал V.x в ноль при ЛЮБОМ переносе.
  V.x = Math.min(0, Math.max(vw - WORLD.w, V.x));
  V.y = Math.min(0, Math.max(vh - WORLD.h, V.y));
}

function setZoom(k, ax, ay) {
  const nk = Math.max(0.2, Math.min(6, k));
  const wx = (ax - V.x) / V.k;
  const wy = (ay - V.y) / V.k;
  V.k = nk;
  V.x = ax - wx * nk;
  V.y = ay - wy * nk;
  clampView();
  render();
}

function zoomStep(f, ax, ay) {
  setZoom(V.k * f, ax, ay);
}

function resetView() {
  V.k = 1;
  V.x = 0;
  V.y = 0;
  clampView();
  render();
}

function fitAll() {
  const k = Math.min(W / WORLD.w, H / WORLD.h);
  V.k = Math.max(0.2, Math.min(6, k));
  V.x = (W - WORLD.w * V.k) / 2;
  V.y = (H - WORLD.h * V.k) / 2;
  clampView();
  render();
}

// ── размеры ─────────────────────────────────────────────────────────────────
function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = Math.max(320, Math.floor(r.width));
  H = Math.max(320, Math.floor(r.height));
  for (const c of [cv, cvs]) {
    c.width = Math.floor(W * dpr);
    c.height = Math.floor(H * dpr);
    c.style.width = W + "px";
    c.style.height = H + "px";
  }
  const mh = Math.round(MINI_W * WORLD.h / WORLD.w);
  mcv.width = Math.floor(MINI_W * dpr);
  mcv.height = Math.floor(mh * dpr);
  mcv.style.width = MINI_W + "px";
  mcv.style.height = mh + "px";
  clampView();
  render();
}

// ── отрисовка операций (в мировых координатах) ─────────────────────────────
function stroke(g, o) {
  const p = o.pts;
  if (!p || !p.length) return;
  g.strokeStyle = o.color;
  g.fillStyle = o.color;
  g.lineWidth = o.size;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (p.length === 1) {
    g.beginPath();
    g.arc(p[0][0], p[0][1], o.size / 2, 0, 7);
    g.fill();
    return;
  }
  g.beginPath();
  g.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
  g.stroke();
}

// ластик = кисть с destination-out, рисуется полилинией по pts
function eraseOn(g, o) {
  const p = o.pts;
  if (!p || !p.length) return;
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.strokeStyle = "#000";
  g.fillStyle = "#000";
  g.lineWidth = o.size;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (p.length === 1) {
    g.beginPath();
    g.arc(p[0][0], p[0][1], o.size / 2, 0, 7);
    g.fill();
  } else {
    g.beginPath();
    g.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
    g.stroke();
  }
  g.restore();
}

function textOn(g, o) {
  g.fillStyle = o.color;
  g.font = `600 ${o.size}px Manrope, system-ui, sans-serif`;
  g.textBaseline = "top";
  g.fillText(o.text, o.x, o.y);
}

function drawOp(g, o) {
  if (o.op === "stroke") stroke(g, o);
  else if (o.op === "text") textOn(g, o);
  else if (o.op === "erase") eraseOn(g, o);
}

let live = null;

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  for (const o of S.ops) drawOp(ctx, o);
  if (live) drawOp(ctx, live);
  drawMini();
  drawCursors();
}

// ── миникарта в правом нижнем углу ──────────────────────────────────────────
function drawMini() {
  const s = mcv.width / WORLD.w;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mcv.width, mctx.height);
  // рисуем со сдвигом внутрь, иначе граница мира ложилась ровно на край
  // canvas и её срезала рамка контейнера — её не было видно
  const ins = 2 * dpr;
  const bw = mcv.width - ins * 2;
  const bh = mcv.height - ins * 2;
  const ss = Math.min(bw / WORLD.w, bh / WORLD.h);
  const ox = ins + (bw - WORLD.w * ss) / 2;
  const oy = ins + (bh - WORLD.h * ss) / 2;

  // граница мира — заметная, а не 1px в углу
  mctx.save();
  mctx.strokeStyle = "rgba(255,255,255,.28)";
  mctx.lineWidth = Math.max(1, Math.round(dpr));
  mctx.strokeRect(ox, oy, WORLD.w * ss, WORLD.h * ss);
  mctx.restore();

  // рисунок в масштабе карты
  mctx.save();
  mctx.translate(ox, oy);
  mctx.scale(ss, ss);
  for (const o of S.ops) {
    if (o.op === "erase") continue;
    drawOp(mctx, o);
  }
  mctx.restore();

  // прямоугольник текущего обзора: заливка + заметная рамка
  const vx = ox + V.x * ss;
  const vy = oy + V.y * ss;
  const vw = viewW() * ss;
  const vh = viewH() * ss;
  mctx.save();
  mctx.beginPath();
  mctx.rect(ox, oy, WORLD.w * ss, WORLD.h * ss);
  mctx.clip();
  mctx.fillStyle = "rgba(255,46,154,.10)";
  mctx.fillRect(vx, vy, vw, vh);
  mctx.strokeStyle = "#ff2e9a";
  mctx.lineWidth = 2 * dpr;
  mctx.strokeRect(vx, vy, vw, vh);
  mctx.restore();

  // рамку обзора дублируем в css поверх canvas — так её видно всегда
  const box = $("#mview");
  box.style.left = (vx / dpr) + "px";
  box.style.top = (vy / dpr) + "px";
  box.style.width = (vw / dpr) + "px";
  box.style.height = (vh / dpr) + "px";
}

function miniJump(e) {
  const r = mcv.getBoundingClientRect();
  const mx = (e.clientX - r.left) / r.width;
  const my = (e.clientY - r.top) / r.height;
  V.x = mx * WORLD.w - viewW() / 2;
  V.y = my * WORLD.h - viewH() / 2;
  clampView();
  render();
}

// ── курсоры других ──────────────────────────────────────────────────────────
function drawCursors() {
  gcur.setTransform(dpr, 0, 0, dpr, 0, 0);
  gcur.clearRect(0, 0, W, H);
  gcur.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  const now = Date.now();
  for (const [login, p] of S.cursors) {
    if (now - p.at > 6000 || !S.me || login === S.me.login) continue;
    if (p.x == null || p.y == null) continue;
    gcur.save();
    gcur.strokeStyle = p.color;
    gcur.fillStyle = p.color;
    gcur.lineWidth = 2 / V.k;
    gcur.beginPath();
    gcur.arc(p.x, p.y, 5 / V.k, 0, 7);
    gcur.stroke();
    gcur.font = `600 ${11 / V.k}px Manrope, system-ui, sans-serif`;
    const w = gcur.measureText(login).width + 10 / V.k;
    gcur.fillRect(p.x + 9 / V.k, p.y - 8 / V.k, w, 16 / V.k);
    gcur.fillStyle = "#0a0a0c";
    gcur.fillText(login, p.x + 14 / V.k, p.y + 4 / V.k);
    gcur.restore();
  }
}

// ── ввод ────────────────────────────────────────────────────────────────────
function pos(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

let drawing = false;
let panning = null;
let spaceDown = false;
const ptrs = new Map();
let pinch = null;

function pushLive(o) {
  live = o;
  render();
}

function commit() {
  if (!live || live._sent) return;
  live._sent = true;
  const o = live;
  live = null;
  send({ t: "ops", ops: [o] });
  // локально не добавляем: эхо сервера придёт по websocket
}

function isPanGesture(e) {
  return S.tool === "hand" || spaceDown || e.button === 1 || e.button === 2;
}

cv.addEventListener("pointerdown", (e) => {
  if (!S.user) return openGate();
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);

  // два пальца — масштаб и перенос
  if (ptrs.size === 2) {
    drawing = false;
    live = null;
    const [a, b] = [...ptrs.values()];
    const r = cv.getBoundingClientRect();
    const mx = (a[0] + b[0]) / 2 - r.left;
    const my = (a[1] + b[1]) / 2 - r.top;
    pinch = {
      dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
      wx: (mx - V.x) / V.k,
      wy: (my - V.y) / V.k,
      mx,
      my,
      k: V.k,
    };
    return;
  }
  if (pinch) return;

  const [ax, ay] = pos(e);

  if (isPanGesture(e)) {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    panning = { x: ax, y: ay, vx: V.x, vy: V.y };
    return;
  }

  try { cv.setPointerCapture(e.pointerId); } catch {}
  drawing = true;
  const [wx, wy] = s2w(ax, ay);

  if (S.tool === "text") {
    const t = prompt("текст");
    if (t && t.trim()) {
      pushLive({ op: "text", x: wx, y: wy, text: t.trim(),
                 color: S.color, size: (S.size < 10 ? 24 : S.size) / V.k });
      commit();
    }
    drawing = false;
    return;
  }

  pushLive({
    op: S.tool === "eraser" ? "erase" : "stroke",
    pts: [[wx, wy]],
    color: S.color,
    // толщина задаётся в экранных px, поэтому переводим в мировые
    size: (S.tool === "eraser" ? Math.max(14, S.size * 4) : S.size) / V.k,
  });
});

cv.addEventListener("pointermove", (e) => {
  const [ax, ay] = pos(e);

  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);

  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const nk = Math.max(0.2, Math.min(6, pinch.k * (dist / pinch.dist)));
    V.k = nk;
    // держим точку, которая была под серединой щипка
    V.x = pinch.mx - pinch.wx * nk;
    V.y = pinch.my - pinch.wy * nk;
    clampView();
    render();
    return;
  }

  if (panning) {
    V.x = panning.vx + (ax - panning.x);
    V.y = panning.vy + (ay - panning.y);
    clampView();
    render();
    return;
  }

  if (S.user) {
    const [wx, wy] = s2w(ax, ay);
    wsSend({ t: "cursor", x: wx, y: wy });
  }

  if (!drawing || !live) return;

  const [wx, wy] = s2w(ax, ay);
  const last = live.pts[live.pts.length - 1];
  if (Math.hypot(wx - last[0], wy - last[1]) > 1.2 / V.k) {
    live.pts.push([wx, wy]);
    if (live.pts.length > 1200) commit();
  }
  render();
});

const finish = () => {
  ptrs.clear();
  pinch = null;
  if (panning) {
    panning = null;
    return;
  }
  if (!drawing) return;
  drawing = false;
  commit();
};

cv.addEventListener("pointerup", finish);
cv.addEventListener("pointercancel", finish);
cv.addEventListener("pointerleave", finish);
cv.addEventListener("contextmenu", (e) => {
  if (isPanGesture(e) || S.tool === "hand") e.preventDefault();
});

// колесо: сдвиг по осям, ctrl/⌘ — масштаб
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [ax, ay] = pos(e);
  if (e.ctrlKey || e.metaKey) {
    zoomStep(e.deltaY < 0 ? 1.12 : 1 / 1.12, ax, ay);
    return;
  }
  V.x -= e.deltaX;
  V.y -= e.deltaY;
  clampView();
  render();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && e.target === document.body) {
    spaceDown = true;
    cv.style.cursor = "grab";
  }
  if (!S.user) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      zoomStep(1.2, W / 2, H / 2);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomStep(1 / 1.2, W / 2, H / 2);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      resetView();
      return;
    }
  }
  const map = { b: "brush", e: "eraser", t: "text", h: "hand" };
  const k = map[e.key.toLowerCase()];
  if (k && e.target === document.body) setTool(k);
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceDown = false;
    cv.style.cursor = S.tool === "hand" ? "grab" : "crosshair";
  }
});

// ── сеть ────────────────────────────────────────────────────────────────────
// wsSend ВОЗВРАЩАЕТ true, когда реально отправил. Раньше возвращал undefined,
// и send() после успешной отправки всё равно клал сообщение в очередь —
// flushQueue() слал его вторым разом. каждая операция дублировалась в базе.
function wsSend(o) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(o));
    return true;
  }
  return false;
}
function send(o) {
  if (wsSend(o)) return;
  // нет связи — кладём в очередь, она уйдёт при переподключении
  S.queue.push(o);
}
function flushQueue() {
  while (S.queue.length && S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(S.queue.shift()));
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  S.ws = ws;
  ws.onopen = () => {
    setNet(true);
    flushQueue();
  };
  ws.onclose = () => {
    setNet(false);
    setTimeout(connect, 2500);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "ops") {
      // операции приходят уже с серверным id и автором — просто добавляем
      for (const o of m.ops) S.ops.push(o);
      render();
      bumpCount();
    } else if (m.t === "undo") {
      S.ops = S.ops.filter((x) => x.id !== m.id);
      render();
      bumpCount();
    } else if (m.t === "reload") {
      loadBoard();
    } else if (m.t === "presence") {
      S.online = m.online || [];
      renderOnline();
    } else if (m.t === "cursor") {
      S.cursors.set(m.login, { x: m.x, y: m.y, color: m.color, at: Date.now() });
    } else if (m.t === "err") {
      toast(m.error || "ошибка");
    }
  };
}

function setNet(ok) {
  const el = $("#net");
  el.textContent = ok ? "на связи" : "переподключение";
  el.className = ok ? "net ok" : "net bad";
}

async function loadBoard() {
  const r = await fetch("/api/board", { credentials: "same-origin" });
  if (!r.ok) return;
  const d = await r.json();
  S.ops = d.ops || [];
  S.online = d.online || [];
  render();
  renderOnline();
  bumpCount(d.count);
}

function bumpCount(n) {
  $("#cnt").textContent = n != null ? n : S.ops.length;
}

// ── интерфейс ───────────────────────────────────────────────────────────────
function setTool(t) {
  S.tool = t;
  $$(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  cv.style.cursor = t === "hand" ? "grab" : "crosshair";
}

function syncColor() {
  $$(".sw").forEach((b) => b.classList.toggle("on", b.dataset.c === S.color));
  $("#sizeval").textContent = S.size + "px";
  $("#sz").value = S.size;
}

function buildTools() {
  const wrap = $("#tools");
  wrap.innerHTML = "";
  for (const [key, t] of Object.entries(TOOLS)) {
    const b = document.createElement("button");
    b.className = "tool";
    b.dataset.tool = key;
    b.title = t.label;
    b.innerHTML = `<i data-lucide="${t.icon}"></i><span>${t.label}</span>`;
    b.onclick = () => setTool(key);
    wrap.appendChild(b);
  }
  const sw = $("#swatches");
  sw.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "sw";
    b.dataset.c = c;
    b.style.background = c;
    b.title = c;
    b.onclick = () => {
      S.color = c;
      if (S.tool === "eraser") setTool("brush");
      syncColor();
    };
    sw.appendChild(b);
  }
  setTool("brush");
  syncColor();
  if (window.lucide) lucide.createIcons();
}

async function doUndo() {
  if (!S.user) return openGate();
  const r = await fetch("/api/undo", { method: "POST", credentials: "same-origin" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    toast(d.error || "нечего отменять");
  }
}

function renderOnline() {
  const w = $("#online");
  w.innerHTML = "";
  const list = S.online.slice(0, 12);
  for (const p of list) {
    const s = document.createElement("span");
    s.className = "who";
    s.innerHTML = `<b style="background:${p.color}"></b>${escapeHtml(p.login)}`;
    w.appendChild(s);
  }
  $("#oncnt").textContent = list.length;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── вход ────────────────────────────────────────────────────────────────────
function openGate() { $("#gate").classList.add("open"); $("#glogin").focus(); }
function closeGate() { $("#gate").classList.remove("open"); }

async function afterAuth() {
  const r = await fetch("/api/me", { credentials: "same-origin" });
  const d = await r.json();
  S.user = d.user;
  S.me = d.user;
  S.admin = d.user?.role === "admin";
  if (!S.user) {
    openGate();
    return;
  }
  $("#who").textContent = S.user.login;
  $("#wdot").style.background = S.user.color;
  $("#logout").classList.remove("hide");
  $("#adminbtn").classList.toggle("hide", !S.admin);
  closeGate();
  await loadBoard();
  connect();
}

let mode = "login";

async function submitAuth() {
  const login = $("#glogin").value.trim();
  const pw = $("#gpw").value;
  const err = $("#gerr");
  err.textContent = "";
  if (!login || !pw) {
    err.textContent = "заполни оба поля";
    return;
  }
  const r = await fetch(mode === "reg" ? "/api/register" : "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ login, password: pw }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    err.textContent = d.error || "не получилось";
    return;
  }
  $("#gpw").value = "";
  await afterAuth();
}

// ── админка ─────────────────────────────────────────────────────────────────
async function openAdmin() {
  if (!S.admin) return;
  $("#panel").classList.add("open");
  loadUsers();
  loadHistory();
}

async function loadUsers() {
  const r = await fetch("/api/users", { credentials: "same-origin" });
  const d = await r.json();
  const w = $("#ulist");
  w.innerHTML = "";
  for (const u of d.users || []) {
    const row = document.createElement("div");
    row.className = "urow";
    const isMe = u.id === S.user?.id;
    row.innerHTML = `<b style="background:${u.color}"></b>
      <span class="ul">${escapeHtml(u.login)}${u.role === "admin" ? " <em>админ</em>" : ""}</span>
      <span class="mut">${u.ops} штр.</span>
      ${isMe ? "" : `<button class="mini" data-a="wipe" data-l="${escapeHtml(u.login)}">стереть</button>`}`;
    w.appendChild(row);
  }
  $$("#ulist .mini").forEach((b) => {
    b.onclick = async () => {
      await fetch("/api/admin/user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: b.dataset.a, login: b.dataset.l }),
      });
      loadUsers();
      loadBoard();
    };
  });
}

async function loadHistory() {
  const r = await fetch("/api/history?n=140", { credentials: "same-origin" });
  const d = await r.json();
  const w = $("#hlist");
  w.innerHTML = "";
  for (const h of d.history || []) {
    const row = document.createElement("div");
    row.className = "hrow";
    const when = new Date(h.at * 1000).toLocaleString("ru-RU", { hour12: false });
    let what = h.op;
    if (h.op === "stroke") what = "штрих" + (h.pts_count ? ` (${h.pts_count} т.)` : "");
    else if (h.op === "text") what = "текст «" + h.text.slice(0, 18) + "»";
    else if (h.op === "erase") what = "стёр" + (h.pts_count ? ` (${h.pts_count} т.)` : "");
    row.innerHTML = `<span class="ht">${when}</span>
      <b style="background:${h.ucolor}"></b>
      <span class="ul">${escapeHtml(h.by)}</span>
      <span class="mut">${what}</span>
      ${S.admin ? `<button class="mini" data-id="${h.id}">убрать</button>` : ""}`;
    w.appendChild(row);
  }
  $$("#hlist .mini").forEach((b) => {
    b.onclick = async () => {
      await fetch("/api/admin/undo_by", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id: Number(b.dataset.id) }),
      });
      loadHistory();
      loadBoard();
    };
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("on"), 2200);
}

// ── запуск ──────────────────────────────────────────────────────────────────
async function boot() {
  buildTools();
  resize();
  window.addEventListener("resize", resize);

  $("#glogin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });
  $("#gpw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });
  $("#greg").onclick = () => {
    mode = "reg";
    $("#gtitle").textContent = "регистрация";
    $("#gsub").textContent = "придумай логин 3-20 символов и пароль от 6";
    $("#gsend").textContent = "создать";
  };
  $("#gsend").onclick = () => submitAuth();
  $("#gclose").onclick = closeGate;
  $("#logout").onclick = async () => {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    location.reload();
  };
  $("#undo").onclick = doUndo;
  $("#adminbtn").onclick = openAdmin;
  $("#pclose").onclick = () => $("#panel").classList.remove("open");
  $("#pclear").onclick = async () => {
    if (!confirm("стереть весь холст? отменить будет нельзя")) return;
    await fetch("/api/admin/clear", { method: "POST", credentials: "same-origin" });
    loadHistory();
    loadBoard();
  };
  $("#sz").addEventListener("input", (e) => {
    S.size = Number(e.target.value);
    syncColor();
  });
  $("#zin").onclick = () => zoomStep(1.25, W / 2, H / 2);
  $("#zout").onclick = () => zoomStep(1 / 1.25, W / 2, H / 2);
  $("#zreset").onclick = resetView;
  $("#zfit").onclick = fitAll;
  mcv.addEventListener("pointerdown", (e) => {
    try { mcv.setPointerCapture(e.pointerId); } catch {}
    miniJump(e);
  });
  mcv.addEventListener("pointermove", (e) => {
    if (e.buttons & 1) miniJump(e);
  });
  $("#ptabs").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      $("#ptabs").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      $("#ulist").hidden = b.dataset.t !== "users";
      $("#hlist").hidden = b.dataset.t !== "hist";
    };
  });

  await afterAuth();
  // историю подтягиваем ТОЛЬКО для админа и только когда панель открыта
  setInterval(() => {
    if (S.admin && $("#panel").classList.contains("open")) loadHistory();
  }, 15000);
  setInterval(drawCursors, 1000);
}

boot();