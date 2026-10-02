// art.example.com — общий холст с регистрацией.
//
// КАМЕРА. Операции лежат в мировых координатах на холсте WORLD. Экран показывает
// окно этого мира: V.x/V.y — смещение мира относительно экрана (всегда ≤ 0),
// V.k — масштаб. Раньше координаты были экранными, поэтому при переносе или
// зуме рисунок уезжал и разные участники видели разное.
//
// ПРОИЗВОДИТЕЛЬНОСТЬ. Рисунок не перерисовывается на каждый кадр: он живёт в
// offscreen-канвасе и перестраивается только когда изменился список операций.
// Панорама и зум просто блитят готовую картинку с трансформом, поэтому мышь не
// лагает даже на тысяче штрихов.

const WORLD = { w: 2400, h: 1600 };
// ширина миникарты. на узком экране ужимается, иначе она закрывает
// почти половину холста вместе с панелью инструментов
function miniWidth() {
  if (W < 560) return 132;
  if (W < 900) return 220;
  return 360;
}
const MINI_H = Math.round((360 * WORLD.h) / WORLD.w);
const ZOOM_MAX = 8;
// минимальный зум не фиксирован: ниже предела, при котором весь холст
// помещается в окно, отдалять бессмысленно — и именно там ломалось.
// при k меньше этого окно шире мира, clampView центрирует камеру,
// и она перестаёт двигаться вообще.
function minZoom() {
  return Math.min(ZOOM_MAX, Math.max(W / WORLD.w, H / WORLD.h));
}

const PALETTE = ["#ff2e9a", "#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#fb7185",
  "#a3e635", "#60a5fa", "#f472b6", "#facc15", "#2dd4bf", "#c084fc",
  "#ffffff", "#0a0a0c", "#94a3b8", "#e2e8f0"];

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
  size: 5,        // процент от максимальной толщины
  textSize: 6,    // процент от ширины экрана
  smooth: true,   // плавные кривые вместо отрезков
  recent: [],     // недавно выбранные цвета
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
const mcv = $("#mcv");
const mctx = mcv.getContext("2d");

// offscreen: готовый рисунок мира, перестраивается только при смене ops
const buf = document.createElement("canvas");
const bctx = buf.getContext("2d");
let bufDirty = true;
let drawnCount = 0;

// offscreen миникарты. объявляем ЗДЕСЬ, а не рядом с функцией рисования:
// resize() зовётся из boot() раньше, чем дошли бы до нижнего let, и
// обращение к mbufDirty давало "Cannot access 'mbufDirty' before initialization".
const mbuf = document.createElement("canvas");
const mbctx = mbuf.getContext("2d");
let mbufDirty = true;
// камеру ставим по центру только один раз, при первой загрузке доски:
// при обновлениях (reload) она не должна прыгать обратно
let firstBoard = true;

// фон панели миникарты: им же закрашивается стёртое
const MINI_BG = "#0e0e13";

let dpr = 1;
let W = 0;
let H = 0;

// ── камера ──────────────────────────────────────────────────────────────────
function viewW() { return W / V.k; }
function viewH() { return H / V.k; }

// V.x ≤ 0: 0 — левый край мира, (vw - WORLD.w) — правый край.
// Если окно шире мира, камера центрируется.
// V.x/V.y — сдвиг мира относительно экрана В ЭКРАННЫХ пикселях:
// он идёт прямо в трансформ setTransform(..., dpr*V.x, dpr*V.y).
// поэтому границы панорамы считаются через W - WORLD.w * V.k, а НЕ через
// viewW() = W / V.k: это величина в мировых пикселях, и сравнение с V.x
// смешивало единицы. Из-за этого на зуме 2x правый край холста был виден
// только до 1497 из 2400, а на 4x — до 823, то есть 38% и 66% холста
// были недостижимы.
// V.x может быть положительным — это когда мир уже меньше окна.
function clampView() {
  const loX = W - WORLD.w * V.k;
  const loY = H - WORLD.h * V.k;
  V.x = loX > 0 ? loX / 2 : Math.min(0, Math.max(loX, V.x));
  V.y = loY > 0 ? loY / 2 : Math.min(0, Math.max(loY, V.y));
}

function setZoom(k, ax, ay) {
  const nk = Math.max(minZoom(), Math.min(ZOOM_MAX, k));
  // держим точку под курсором на месте
  const wx = (ax - V.x) / V.k;
  const wy = (ay - V.y) / V.k;
  V.k = nk;
  V.x = ax - wx * nk;
  V.y = ay - wy * nk;
  clampView();
  present();
}

function zoomStep(f, ax, ay) {
  setZoom(V.k * f, ax, ay);
}

// стартовый вид: 100% и по центру холста. раньше камера стояла в левом
// верхнем углу (V.x = V.y = 0), и первые же движения вправо/вверх упирались
// в границу мира — выглядело как «камера не едет».
function startView() {
  V.k = Math.max(1, minZoom());
  centerOn(WORLD.w / 2, WORLD.h / 2);
}

function centerOn(wx, wy) {
  V.x = W / 2 - wx * V.k;
  V.y = H / 2 - wy * V.k;
  clampView();
  present();
}



// ── размеры ─────────────────────────────────────────────────────────────────
function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = Math.max(320, Math.floor(r.width));
  H = Math.max(320, Math.floor(r.height));
  cv.width = Math.floor(W * dpr);
  cv.height = Math.floor(H * dpr);
  cv.style.width = W + "px";
  cv.style.height = H + "px";
  const mw = miniWidth();
  const mh = Math.round((mw * WORLD.h) / WORLD.w);
  mcv.width = Math.floor(mw * dpr);
  mcv.height = Math.floor(mh * dpr);
  // без явного css-размера на dpr=2 канвас занимает внутренний размер
  // экранными пикселями, и клик по миникарте попадает не туда
  mcv.style.width = mw + "px";
  mcv.style.height = mh + "px";
  buf.width = WORLD.w;
  buf.height = WORLD.h;
  bufDirty = true;
  mbuf.width = mcv.width;
  mbuf.height = mcv.height;
  mbufDirty = true;
  // если окно выросло, старый зум мог оказаться ниже нового минимума.
  // без этого clampView центрирует обе оси и камера перестаёт двигаться,
  // а зум-аут перестаёт работать — молча.
  V.k = Math.max(minZoom(), Math.min(ZOOM_MAX, V.k));
  clampView();
  present();
}

// ── рисование операций ──────────────────────────────────────────────────────
// ТОЛЩИНА. В операции лежит ПРОЦЕНТ от максимальной толщины, а не мировые
// пиксели. Мировая толщина считается здесь, при отрисовке:
//   size_мира = (pct / 100) * THICK_MAX_FRAC * W / k
// тогда на экране получится size_мира * k = (pct / 100) * THICK_MAX_FRAC * W —
// одна и та же величина при ЛЮБОМ зуме. Раньше толщина писалась в базу как
// S.size / V.k, и нарисованное при зуме 1 при отдалении до 0.5 становилось
// вдвое тоньше.
// 100% ползунка — десятая доля ширины экрана. было 0.25 (четверть),
// это давало 291px на широком мониторе — кисть выглядела веслом.
const THICK_MAX_FRAC = 0.10;

function widthOf(g, pct) {
  return (pct / 100) * THICK_MAX_FRAC * W / V.k;
}

// СГЛАЖИВАНИЕ. Через середины соседних точек идут квадратичные кривые:
// так штрих идёт плавной дугой, без углов в местах, где мышь дёрнулась.
// отключается переключателем S.smooth для тех, кому нужен ровный отрезок.
function pathThrough(g, pts) {
  if (S.smooth && pts.length > 2) {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  } else {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  }
}

function strokeOn(g, o) {
  const p = o.pts;
  if (!p || !p.length) return;
  const w = widthOf(g, o.size);
  g.strokeStyle = o.color;
  g.fillStyle = o.color;
  g.lineWidth = w;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (p.length === 1) {
    g.beginPath();
    g.arc(p[0][0], p[0][1], w / 2, 0, 7);
    g.fill();
    return;
  }
  g.beginPath();
  pathThrough(g, p);
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
  const w = widthOf(g, o.size);
  g.lineWidth = w;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (p.length === 1) {
    g.beginPath();
    g.arc(p[0][0], p[0][1], w / 2, 0, 7);
    g.fill();
  } else {
    g.beginPath();
    pathThrough(g, p);
    g.stroke();
  }
  g.restore();
}

function textOn(g, o) {
  g.fillStyle = o.color;
  g.font = `600 ${widthOf(g, o.size)}px Manrope, system-ui, sans-serif`;
  g.textBaseline = "top";
  g.fillText(o.text, o.x, o.y);
}

function drawOp(g, o) {
  if (o.op === "stroke") strokeOn(g, o);
  else if (o.op === "text") textOn(g, o);
  else if (o.op === "erase") eraseOn(g, o);
}

// полная перестройка offscreen: только при загрузке доски и отмене
function rebuild() {
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.clearRect(0, 0, buf.width, buf.height);
  for (const o of S.ops) drawOp(bctx, o);
  drawnCount = S.ops.length;
  bufDirty = false;
}

// дорисовка новых операций на уже готовый буфер. раньше на КАЖДОЕ новое
// действие буфер перерисовывался целиком, и при нескольких сотнях штрихов
// это давало лаг на каждом кадре — штрих «пропадал» и проявлялся позже.
function appendToBuf(op) {
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  drawOp(bctx, op);
  drawnCount = S.ops.length;
  bufDirty = false;
}

let live = null;

// экран = трансформ + блит готового рисунка
function present() {
  // при большом расхождении догоняем полной перестройкой, иначе дорисовываем
  if (bufDirty) {
    if (S.ops.length - drawnCount > 24) rebuild();
    else for (let i = drawnCount; i < S.ops.length; i++) appendToBuf(S.ops[i]);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  // рамка мира, чтобы границы холста было видно
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1 / V.k;
  ctx.strokeRect(0, 0, WORLD.w, WORLD.h);
  ctx.drawImage(buf, 0, 0);
  if (live) drawOp(ctx, live);
  ctx.restore();

  drawMini();
  drawCursors();
}

// ── миникарта ───────────────────────────────────────────────────────────────
// размеры считаем от размера канваса, а не от css: иначе на dpr=2 рамка уезжает
function miniMetrics() {
  const pad = 3 * dpr;
  const iw = mcv.width - pad * 2;
  const ih = mcv.height - pad * 2;
  const s = Math.min(iw / WORLD.w, ih / WORLD.h);
  return {
    s,
    ox: pad + (iw - WORLD.w * s) / 2,
    oy: pad + (ih - WORLD.h * s) / 2,
  };
}

// стирание на миникарте — это заливка фоном, а не destination-out:
// destination-out на карте вырезал бы дыру, и на тёмной подложке
// результат выглядел бы как ничего не стёртое.
function drawMiniOp(g, o) {
  if (o.op !== "erase") return drawOp(g, o);
  const p = o.pts;
  if (!p || !p.length) return;
  g.save();
  g.strokeStyle = MINI_BG;
  g.fillStyle = MINI_BG;
  const w = widthOf(g, o.size);
  g.lineWidth = w;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (p.length === 1) {
    g.beginPath();
    g.arc(p[0][0], p[0][1], w / 2, 0, 7);
    g.fill();
  } else {
    g.beginPath();
    pathThrough(g, p);
    g.stroke();
  }
  g.restore();
}

function rebuildMini() {
  const g = mbctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, mbuf.width, mbuf.height);
  const { s, ox, oy } = miniMetrics();
  // подложка: без неё миникарта прозрачная и стёртое «просвечивает»
  g.fillStyle = MINI_BG;
  g.fillRect(ox, oy, WORLD.w * s, WORLD.h * s);
  g.save();
  g.beginPath();
  g.rect(ox, oy, WORLD.w * s, WORLD.h * s);
  g.clip();
  g.translate(ox, oy);
  g.scale(s, s);
  for (const o of S.ops) drawMiniOp(g, o);
  g.restore();
  mbufDirty = false;
}

function drawMini() {
  if (mbufDirty) rebuildMini();
  const { s, ox, oy } = miniMetrics();
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mcv.width, mcv.height);
  mctx.drawImage(mbuf, 0, 0);

  // граница мира
  mctx.save();
  mctx.strokeStyle = "rgba(255,255,255,.28)";
  mctx.lineWidth = dpr;
  mctx.strokeRect(ox, oy, WORLD.w * s, WORLD.h * s);
  mctx.restore();

  // рамка текущего обзора: заливка + рамка, обрезана по миру
  // Левый край обзора в мире это -V.x / V.k, потому что V.x задан в
  // экранных пикселях. Делить на k обязательно: без этого на зуме 4x рамка
  // уезжала на 468px при ширине карты 360 и её не было видно совсем.
  const vx = ox - (V.x / V.k) * s;
  const vy = oy - (V.y / V.k) * s;
  const vw = viewW() * s;
  const vh = viewH() * s;
  mctx.save();
  mctx.beginPath();
  mctx.rect(ox, oy, WORLD.w * s, WORLD.h * s);
  mctx.clip();
  mctx.fillStyle = "rgba(255,46,154,.12)";
  mctx.fillRect(vx, vy, vw, vh);
  mctx.strokeStyle = "#ff2e9a";
  mctx.lineWidth = 2 * dpr;
  mctx.strokeRect(vx, vy, vw, vh);
  mctx.restore();
}

// клик или протягивание по миникарте — центрирует обзор
function miniJump(e) {
  const { s, ox, oy } = miniMetrics();
  const r = mcv.getBoundingClientRect();
  const px = (e.clientX - r.left) * dpr;
  const py = (e.clientY - r.top) * dpr;
  const wx = (px - ox) / s;
  const wy = (py - oy) / s;
  centerOn(
    Math.max(0, Math.min(WORLD.w, wx)),
    Math.max(0, Math.min(WORLD.h, wy))
  );
}

// ── курсоры других ──────────────────────────────────────────────────────────
function drawCursors() {
  const now = Date.now();
  // чистим протухшие: иначе S.cursors растёт вечно и present() вызывается
  // каждую секунду даже когда всех курсоров давно нет
  for (const [login, p] of S.cursors) {
    if (now - p.at > 15000) S.cursors.delete(login);
  }
  ctx.save();
  ctx.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  for (const [login, p] of S.cursors) {
    if (now - p.at > 6000 || !S.me || login === S.me.login) continue;
    if (p.x == null || p.y == null) continue;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineWidth = 2 / V.k;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 / V.k, 0, 7);
    ctx.stroke();
    ctx.font = `600 ${11 / V.k}px Manrope, system-ui, sans-serif`;
    const w = ctx.measureText(login).width + 10 / V.k;
    ctx.fillRect(p.x + 9 / V.k, p.y - 8 / V.k, w, 16 / V.k);
    ctx.fillStyle = "#0a0a0c";
    ctx.fillText(login, p.x + 14 / V.k, p.y + 4 / V.k);
    ctx.restore();
  }
  ctx.restore();
}

// ── ввод ────────────────────────────────────────────────────────────────────
function pos(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

const s2w = (x, y) => [(x - V.x) / V.k, (y - V.y) / V.k];

let drawing = false;
let panning = null;
let spaceDown = false;
const ptrs = new Map();
let pinch = null;

function pushLive(o) {
  live = o;
  present();
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
                 color: S.color, size: S.textSize / V.k });
      commit();
    }
    drawing = false;
    return;
  }

  pushLive({
    op: S.tool === "eraser" ? "erase" : "stroke",
    pts: [[wx, wy]],
    color: S.color,
    size: S.tool === "eraser" ? Math.min(100, S.size * 4) : S.size,
  });
});

cv.addEventListener("pointermove", (e) => {
  const [ax, ay] = pos(e);

  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);

  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const nk = Math.max(minZoom(), Math.min(ZOOM_MAX, pinch.k * (dist / pinch.dist)));
    V.k = nk;
    // держим точку, которая была под серединой щипка
    V.x = pinch.mx - pinch.wx * nk;
    V.y = pinch.my - pinch.wy * nk;
    clampView();
    present();
    return;
  }

  if (panning) {
    V.x = panning.vx + (ax - panning.x);
    V.y = panning.vy + (ay - panning.y);
    clampView();
    present();
    return;
  }

  if (S.user) {
    const [wx, wy] = s2w(ax, ay);
    wsSend({ t: "cursor", x: wx, y: wy });
  }

  if (!drawing || !live) return;

  const [wx, wy] = s2w(ax, ay);
  const last = live.pts[live.pts.length - 1];
  const dx = wx - last[0];
  const dy = wy - last[1];
  const dist = Math.hypot(dx, dy);
  // между событиями мыши бывает прыжок в сотни пикселей. если просто
  // добавить конечную точку, между ними получится прямой отрезок вместо
  // дуги — отсюда «линии прямые». поэтому длинный шаг разбиваем
  // промежуточными точками с шагом около двух экранных пикселей.
  const step = 2 / V.k;
  if (dist > step) {
    const n = Math.min(400, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      live.pts.push([last[0] + (dx * i) / n, last[1] + (dy * i) / n]);
    }
    if (live.pts.length > 4000) commit();
  }
  present();
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
// если указатель отпущен вне холста (alt-tab, потеря фокуса), pointerup до
// канваса не дойдёт и штрих останется «зажатым» — продолжит рисоваться сам
window.addEventListener("pointerup", finish);
window.addEventListener("pointercancel", finish);
window.addEventListener("blur", finish);
cv.addEventListener("contextmenu", (e) => {
  if (isPanGesture(e)) e.preventDefault();
});

// колесо: сдвиг по осям, ctrl/⌘ — масштаб к курсору
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [ax, ay] = pos(e);
  if (e.ctrlKey || e.metaKey) {
    zoomStep(e.deltaY < 0 ? 1.15 : 1 / 1.15, ax, ay);
    return;
  }
  V.x -= e.deltaX;
  V.y -= e.deltaY;
  clampView();
  present();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSide();
    return;
  }
  if (e.key === "Escape" && $("#palWrap").classList.contains("open")) {
    togglePalette();
    return;
  }
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
      startView();
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
function wsSend(o) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(o));
    return true;
  }
  return false;
}
function send(o) {
  if (wsSend(o)) return;
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
      // эхо может прийти повторно: при переподключении или ретрансляции одна
      // операция попадала в список дважды и штрих ложился вдвое плотнее.
      // сверяемся по серверному id, а не доверяем порядку сообщений.
      const known = new Set(S.ops.map((o) => o.id));
      for (const o of m.ops) {
        if (o.id != null && known.has(o.id)) continue;
        if (o.id != null) known.add(o.id);
        S.ops.push(o);
      }
      bufDirty = true;
      mbufDirty = true;
      present();
    } else if (m.t === "undo") {
      S.ops = S.ops.filter((x) => x.id !== m.id);
      bufDirty = true;
      drawnCount = -1;   // помечаем, что проще перерисовать целиком
      mbufDirty = true;
      present();
    } else if (m.t === "reload") {
      loadBoard();
    } else if (m.t === "presence") {
      S.online = m.online || [];
      renderOnline();
    } else if (m.t === "cursor") {
      S.cursors.set(m.login, { x: m.x, y: m.y, color: m.color, at: Date.now() });
      present();
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
  bufDirty = true;
      mbufDirty = true;
  present();
  renderOnline();
  if (firstBoard) { startView(); firstBoard = false; }
}

// счётчик штрихов убран по требованию владельца: он считал в том числе
// стёртые операции и вводил в заблуждение


// ── интерфейс ───────────────────────────────────────────────────────────────
// состояние вида и палитры живёт в localStorage: переживает перезагрузку
const LS = "art_prefs";
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || "{}");
    if (typeof p.smooth === "boolean") S.smooth = p.smooth;
    if (Array.isArray(p.recent)) S.recent = p.recent.filter(isHex).slice(0, 12);
    if (isHex(p.color)) S.color = p.color;
    if (p.side === "collapsed") document.querySelector(".wrap").classList.add("side-collapsed");
  } catch {}
}
function savePrefs() {
  try {
    const collapsed = document.querySelector(".wrap").classList.contains("side-collapsed");
    localStorage.setItem(LS, JSON.stringify({
      smooth: S.smooth, recent: S.recent, color: S.color, side: collapsed ? "collapsed" : "open",
    }));
  } catch {}
}

// проверка hex-цвета: ровно #rgb или #rrggbb, без мусора
function isHex(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(v);
}

function rememberColor(c) {
  S.recent = [c, ...S.recent.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 12);
}

function setTool(t) {
  S.tool = t;
  $$(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  cv.style.cursor = t === "hand" ? "grab" : "crosshair";
  // при переносе толщина и размер текста не нужны
  $("#tszgrp").hidden = t !== "text";
  $("#sz").closest(".grp").hidden = t === "hand";
}

function syncColor() {
  $("#colorDot").style.background = S.color;
  $("#sizeval").textContent = S.size + "%";
  $("#sz").value = S.size;
  $("#textsizeval").textContent = S.textSize + "%";
  $("#tsz").value = S.textSize;
}

function pickColor(c) {
  if (!isHex(c)) return;
  S.color = c.toLowerCase();
  if (S.tool === "eraser") setTool("brush");
  rememberColor(S.color);
  syncColor();
  renderSwatches();
  renderRecent();
  savePrefs();
}

function renderSwatches() {
  const sw = $("#swatches");
  sw.innerHTML = "";
  for (const c of PALETTE) {
    const b = document.createElement("button");
    b.className = "sw";
    b.style.background = c;
    b.title = c;
    b.classList.toggle("on", c.toLowerCase() === S.color);
    b.onclick = () => pickColor(c);
    sw.appendChild(b);
  }
}

function renderRecent() {
  const box = $("#recent");
  const row = $("#recentRow");
  if (!S.recent.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  row.innerHTML = "";
  for (const c of S.recent) {
    const b = document.createElement("button");
    b.className = "sw";
    b.style.background = c;
    b.title = c;
    b.classList.toggle("on", c.toLowerCase() === S.color);
    b.onclick = () => pickColor(c);
    row.appendChild(b);
  }
}

function applyHex() {
  const inp = $("#hexInput");
  const err = $("#hexErr");
  let v = inp.value.trim();
  if (v && !v.startsWith("#")) v = "#" + v;
  if (!isHex(v)) {
    err.textContent = "нужен цвет вида #ff2e9a";
    return;
  }
  err.textContent = "";
  pickColor(v);
  inp.value = "";
}

function togglePalette() {
  const w = $("#palWrap");
  const open = w.classList.contains("open");
  w.classList.toggle("open", !open);
  if (!open) {
    $("#hexInput").value = "";
    $("#hexErr").textContent = "";
    $("#nativeColor").value = S.color;
  }
}

function toggleSide() {
  document.querySelector(".wrap").classList.toggle("side-collapsed");
  savePrefs();
  resize();
}

function buildTools() {
  const wrap = $("#toolsGrid");
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
  setTool("brush");
  syncColor();
  renderSwatches();
  renderRecent();
  const sm = $("#smoothBtn");
  sm.setAttribute("aria-pressed", S.smooth ? "true" : "false");
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
  // в разметке стоит атрибут hidden, а не класс: переключать класс .hide
  // тут бесполезно, атрибут всегда сильнее и кнопка оставалась скрыта навсегда
  $("#logout").hidden = false;
  $("#adminbtn").hidden = !S.admin;
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
  // ResizeObserver, а не только window.resize: панель инструментов на узком
  // экране сворачивается и сцена меняет ширину без события resize окна.
  // из-за этого W расходился с реальным размером канваса и рисунок ехал.
  try {
    new ResizeObserver(() => resize()).observe(cv.parentElement);
  } catch {}
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
  loadPrefs();
  $("#sz").addEventListener("input", (e) => {
    S.size = Number(e.target.value);
    syncColor();
  });
  $("#sideToggle").onclick = toggleSide;
  $("#colorBtn").onclick = togglePalette;
  $("#palClose").onclick = togglePalette;
  // нативный выбор цвета как на led: меняем значение и сразу применяем
  const nc = $("#nativeColor");
  nc.value = S.color;
  nc.addEventListener("input", (e) => pickColor(e.target.value));
  $("#hexOk").onclick = applyHex;
  $("#hexInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyHex();
  });
  $("#palWrap").addEventListener("pointerdown", (e) => {
    // клик по затемнению закрывает, клик по самой панели — нет
    if (e.target === $("#palWrap")) togglePalette();
  });
  $("#smoothBtn").onclick = () => {
    S.smooth = !S.smooth;
    $("#smoothBtn").setAttribute("aria-pressed", S.smooth ? "true" : "false");
    savePrefs();
    present();
  };
  $("#tsz").addEventListener("input", (e) => {
    S.textSize = Number(e.target.value);
    syncColor();
  });
  $("#zin").onclick = () => zoomStep(1.25, W / 2, H / 2);
  $("#zout").onclick = () => zoomStep(1 / 1.25, W / 2, H / 2);

  // миникарта: клик и протягивание
  let miniDrag = false;
  mcv.addEventListener("pointerdown", (e) => {
    miniDrag = true;
    try { mcv.setPointerCapture(e.pointerId); } catch {}
    miniJump(e);
    e.preventDefault();
  });
  mcv.addEventListener("pointermove", (e) => {
    if (miniDrag) miniJump(e);
  });
  mcv.addEventListener("pointerup", () => { miniDrag = false; });
  mcv.addEventListener("pointercancel", () => { miniDrag = false; });

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
  setInterval(() => {
    if (S.cursors.size) present();
  }, 1000);
}

boot();