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
  size: 4,        // толщина на экране в пикселях
  textSize: 28,   // кегль текста на экране в пикселях
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
  // ширина ластика на миникарте считается в мировых единицах как size/V.k,
  // поэтому при смене зума её содержимое устаревает
  mbufDirty = true;
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
  // Раньше тут стоял Math.max(320, ...): на узком экране сцена уже была
  // 296px, а канвас получал 320 и ВЫЛЕЗАЛ за правый край на 24px. Нижняя
  // граница нужна только чтобы не делить на ноль при высоте 0.
  W = Math.max(1, Math.floor(r.width));
  H = Math.max(1, Math.floor(r.height));
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
  mbuf.width = mcv.width;
  mbuf.height = mcv.height;
  mbufDirty = true;
  // экранный буфер для приближённого вида имеет размер экрана в
  // физических пикселях, иначе на dpr=2 блит был бы в два раза мельче
  sbuf.width = cv.width;
  sbuf.height = cv.height;
  // если окно выросло, старый зум мог оказаться ниже нового минимума.
  // без этого clampView центрирует обе оси и камера перестаёт двигаться,
  // а зум-аут перестаёт работать — молча.
  V.k = Math.max(minZoom(), Math.min(ZOOM_MAX, V.k));
  clampView();
  present();
}

// ── рисование операций ──────────────────────────────────────────────────────
// ТОЛЩИНА В МИРЕ ХОЛСТА ПОСТОЯННА. Это требование владельца, смысл такой:
// зум — чистое увеличение, ничего не пересчитывая. Штрих 20px занимает на
// холсте ровно 20 мировых пикселей при любом зуме, как в иллюстраторе.
// На экране толщина тогда растёт вместе с зумом: size * k.
//
// Раньше было наоборот, толщина считалась в экранных пикселях (widthOf
// делил size на V.k), и это давало именно то, что ругал владелец: штрис
// менял вид при зуме, потому что у растра толщина запекалась в момент
// отрисовки и потом тянулась вместе с картинкой. Замер ползунка 20:
// на экране 10px при зуме 0.5 и 80px при зуме 4, при этом в мире холста
// должно было быть 20 всегда.
//
// Поэтому здесь НЕ делим на зум. size — это мировые пиксели холста.
const THICK_MAX = 40;

// функция оставлена по инерции: вызывающие места читались как «ширина».
// теперь она ничего не делит, потому что толщина не зависит от зума.
function widthOf(g, size) {
  return size;
}

// СГЛАЖИВАНИЕ — сплайн Катмулла-Рома, проходящий ПО самим точкам.
//
// Раньше здесь шли квадратичные кривые через середины соседних точек.
// Замер на зигзаге с шагом 100px: кривая отходила от точки, в которую вёл
// курсор, на 39/30/29/30/29 px — то есть срезала углы примерно на треть
// длины сегмента. Рисовалось явно не там, где вёл человек.
//
// Катмулл-Ром идёт ровно через точки (замер: отклонение 0 на всех вершинах)
// и при этом остаётся гладким — резкие изломы мыши скругляются, но штрих
// не уезжает. На концах касательная дублируется соседней точкой, иначе
// кривая уходила бы за конец штриха.
function pathThrough(g, pts) {
  const n = pts.length;
  if (S.smooth && n > 2) {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || pts[i + 1];
      g.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]
      );
    }
  } else {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
  }
}

// круглая шапка для одиночного клика: отдельная заливка, обводкой её не
// нарисовать — у линии нет длины
function isDot(o) {
  return o.pts && o.pts.length === 1;
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
  if (isDot(o)) {
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
  const w = widthOf(g, o.size);
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.strokeStyle = "#000";
  g.fillStyle = "#000";
  g.lineWidth = w;
  g.lineCap = "round";
  g.lineJoin = "round";
  if (isDot(o)) {
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

let live = null;

// максимум точек в одном штрихе. дальше не рвём штрих, а прореживаем его
const MAX_PTS = 1500;

// равномерно проредить точки штриха, оставив первый и последний
function thinStroke() {
  const p = live.pts;
  const keep = [];
  const step = Math.ceil(p.length / MAX_PTS);
  for (let i = 0; i < p.length; i += step) keep.push(p[i]);
  if (keep[keep.length - 1] !== p[p.length - 1]) keep.push(p[p.length - 1]);
  live.pts = keep;
}

// ЭКРАННЫЙ БУФЕР.
//
// Отдельный холст во весь экран (в физических пикселях), куда рисуется
// видимая часть содержимого.
//
// НИ ОТСЕВА ПО ГАБАРИТАМ, НИ КЭША ГЕОМЕТРИИ ЗДЕСЬ НЕТ, и это осознанно.
// Обе оптимизации ломали рисование:
//
// отсев по bbox кэшируется на операции, а у живого штриха pts растёт каждый
// кадр — кэш оставался от первого кадра, штрис обрезался прямо во время
// рисования, выглядел короче настоящего и распадался на куски. Хуже того,
// при приближении на холсте ПОЯВЛЯЛИСЬ штрихи, которых не было при отдалении:
// габариты считались в мировых координатах с запасом от размера кисти, а
// экранная область менялась вместе с зумом.
//
// кэш Path2D давал выигрыш в скорости, но у живого штриха кэш строился по
// первой точке, после чего на экране рисовался старый путь: штрис рос в
// памяти, а чернил не появлялось.
//
// Теперь на каждом кадре рисуется весь список операций подряд, безусловно.
// При 200 операциях это меньше миллисекунды, платить за скорость рисованием
// не стоит.
const sbuf = document.createElement("canvas");
const sctx = sbuf.getContext("2d");

// перерисовать содержимое в экранный буфер
function rebuildScreen() {
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, sbuf.width, sbuf.height);
  sctx.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  for (const o of S.ops) drawOp(sctx, o);
}

function present() {
  rebuildScreen();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(sbuf, 0, 0);

  ctx.save();
  ctx.setTransform(dpr * V.k, 0, 0, dpr * V.k, dpr * V.x, dpr * V.y);
  // рамка мира, чтобы границы холста было видно
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1 / V.k;
  ctx.strokeRect(0, 0, WORLD.w, WORLD.h);
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

// МИНИКАРТА перестраивается целиком, когда меняется зум.
//
// Раньше здесь была инкрементальная схема со счётчиком mDrawnCount: буфер
// дорисовывался от mDrawnCount до конца списка операций. Счётчик относился к
// удалённому буферу мира и в миникарту попал по наследству, при этом
// сбрасывался не везде. Замер: S.ops = 2 операции, а mDrawnCount = 128, то
// есть цикл for (i = 128; i < 2) не выполнялся ни разу и миникарта молча
// не показывала ничего нового. Ластик стирал холст, а на карте ничего не
// менялось: 18444 розовых пикселей до и после.
//
// Вторая причина, почему инкрементальность тут не годилась: ширина ластика
// на миникарте считается как size/V.k, то есть зависит от зума. Значит при
// смене зума миникарту всё равно надо перестраивать целиком.
//
// Замер полной перестройки на 2000 операциях (из них 286 стираний):
// 4.2мс на зуме 1, 4.2мс на зуме 2, 6.9мс на зуме 4. Раньше на миникарту
// уходили десятки мс, и на кадре это было заметно.
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

// ОТПРАВКА ШТРИХА.
//
// Операция рисуется на холсте сразу, не дожидаясь сервера, и помечается
// cid — уникальным токеном, который клиент генерирует сам и который сервер
// возвращает в эхо.
//
// ПОЧЕМУ ТОКЕН, А НЕ ПОРЯДОК. Раньше эхо подтверждало «первую
// неподтверждённую операцию», то есть операции сопоставлялись по порядку.
// Это ломалось, как только на холсте рисуют двое: broadcast получают все,
// чужое эхо приходило в общий поток и занимало мой слот подтверждения.
// Замер: мой штрис исчезал из списка (indexOf → -1), а чужая операция
// попадала в список дважды. Владелец описывал это как «рисую и штрис
// пропадает», причём на одном клиенте тоже — эхо приходило пачками и
// сдвигало очередь.
//
// С токеном сопоставление однозначное: чужое эхо просто добавляется как
// новая операция, а моё находит именно свою локальную копию по cid.
const PENDING = [];

// счётчик для cid. время не берём: две вкладки одного юзера должны получать
// разные значения, а Date.now() в пределах миллисекунды совпадёт.
let cidSeq = 0;
function newCid() {
  cidSeq += 1;
  return (S.user ? S.user.login : "anon") + ":" + Date.now().toString(36) + ":" + cidSeq;
}

function commit() {
  if (!live || live._sent) return;
  live._sent = true;
  const o = live;
  live = null;
  // local больше не нужен: он был булевым полем, а отмена сравнивала его с
  // числовым серверным id, из-за чего сравнение всегда было истинно и
  // неподтверждённый штрис не удалялся. Сверка идёт по cid.
  o.cid = newCid();
  S.ops.push(o);
  PENDING.push(o);
  mbufDirty = true;
  present();
  send({ t: "ops", ops: [o] });
}

// эхо сервера: если cid совпал с нашей неотправленной операцией — это наше
// подтверждение, заменяем локальную копию на серверную. если cid чужой или
// отсутствует — просто добавляем, это чужой штрих или результат loadBoard.
function settle(serverOp) {
  let mine = null;
  if (serverOp.cid != null) {
    const at = PENDING.findIndex((o) => o.cid === serverOp.cid);
    if (at >= 0) mine = PENDING.splice(at, 1)[0];
  }
  if (!mine) {
    // не наше: чужое эхо или догрузка доски. добавляем как есть, но только
    // если такого id ещё нет — иначе получится дубль при переподключении
    if (serverOp.id != null && S.ops.some((o) => o.id === serverOp.id)) return;
    S.ops.push(serverOp);
    mbufDirty = true;
    return;
  }
  const at = S.ops.indexOf(mine);
  if (at < 0) {
    // локальную копию уже убрали (отмена или перезагрузка доски) —
    // возвращаем на холст серверную версию
    S.ops.push(serverOp);
  } else {
    S.ops[at] = serverOp;
  }
  mbufDirty = true;
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
      // size здесь — кегль НА ЭКРАНЕ в пикселях. делить на зум дальше нельзя:
      // widthOf делает это сам, иначе текст уменьшался в квадрате зума.
      pushLive({ op: "text", x: wx, y: wy, text: t.trim(),
                 color: S.color, size: S.textSize });
      commit();
    }
    drawing = false;
    return;
  }

  pushLive({
    op: S.tool === "eraser" ? "erase" : "stroke",
    pts: [[wx, wy]],
    color: S.color,
    size: S.tool === "eraser" ? Math.min(THICK_MAX, S.size * 2) : S.size,
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
  }
  // Раньше здесь стояло «если точек больше 4000 — commit()». Это рвало штрих
  // на середине жеста: commit обнулял live, но drawing оставалась true, и
  // последующие pointermove уже ничего не рисовали — штрих обрывался молча.
  // Вместо обрыва прореживаем: шаг между точками растёт, кривая визуально
  // та же, но память и json не растут бесконечно.
  if (live.pts.length > MAX_PTS) thinStroke();
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

// первый connect — обычное открытие, последующие это переподключения
let everOpen = false;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  S.ws = ws;
  ws.onopen = () => {
    setNet(true);
    flushQueue();
    // после обрыва связи операции, нарисованные другими за время обрыва,
    // не приходят: сервер шлёт только новые. без досинхронизации они терялись
    // до F5. на первом открытии доска и так грузится после авторизации.
    if (everOpen) loadBoard();
    everOpen = true;
  };
  ws.onclose = () => {
    setNet(false);
    setTimeout(connect, 2500);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "ops") {
      // каждое эхо проходит через settle: там сверка по cid, и только
      // если операция не моя неотправленная — она добавляется как новая.
      // Раньше стояло «если PENDING не пуст — settle(o)», то есть ЛЮБОЕ
      // пришедшее эхо, включая чужое от другого участника, занимало слот
      // подтверждения: мой штрис пропадал, чужой дублировался.
      for (const o of m.ops) settle(o);
      mbufDirty = true;
      present();
    } else if (m.t === "undo") {
      // отмена приходит с id серверной операции. Раньше тут стояло
      // x.local !== m.id, но local это булево поле, а m.id число —
      // сравнение всегда истинно и ничего не удаляло. Теперь сверяем cid:
      // неподтверждённый штрис серверного id ещё не знает, и удалять его
      // нужно по токену.
      S.ops = S.ops.filter((x) => x.id !== m.id && x.cid !== m.cid);
      if (m.cid != null) {
        const p = PENDING.findIndex((x) => x.cid === m.cid);
        if (p >= 0) PENDING.splice(p, 1);
      }
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
  // ВАЖНО, ОТКУДА ТУТ ВЗЯЛАСЬ ПОТЕРЯ НЕОТПРАВЛЕННОГО.
  // Раньше стояло PENDING.length = 0 и S.ops = d.ops, то есть список
  // заменялся целиком. Операция, нарисованная но ещё не подтверждённая
  // сервером, в ответе /api/board отсутствует — и она исчезала с холста
  // вместе с очисткой PENDING, хотя continue рисования был жив. Владелец
  // описывал это как «рисую, не отпускаю мышку, штрих иногда пропадает».
  // То же самое делал loadBoard() по событию reload и по переподключению.
  // Теперь доска — это основа, а локальные неотправленные дописываются
  // поверх в порядке отправки: эхо сервера их потом заменит по порядку.
  const base = d.ops || [];
  S.ops = base.concat(PENDING);
  S.online = d.online || [];
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
  $("#sizeval").textContent = S.size + "px";
  $("#sz").value = S.size;
  $("#textsizeval").textContent = S.textSize + "px";
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
    s.title = p.login;
    // логин в отдельном span: text-overflow работает только на блочном
    // контейнере, а .who это inline-flex с точкой внутри — на нём самом
    // многоточие не появляется, 12 длинных логинов раздувают всю строку
    s.innerHTML = `<b style="background:${p.color}"></b>` +
      `<span class="whon">${escapeHtml(p.login)}</span>`;
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
      ${isMe ? "" : `<button class="btn-mini" data-a="wipe" data-l="${escapeHtml(u.login)}">стереть</button>`}`;
    w.appendChild(row);
  }
  $$("#ulist .btn-mini").forEach((b) => {
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
      ${S.admin ? `<button class="btn-mini" data-id="${h.id}">убрать</button>` : ""}`;
    w.appendChild(row);
  }
  $$("#hlist .btn-mini").forEach((b) => {
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
  // нативный выбор цвета: меняем значение и сразу применяем
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
  // пинг каждые 15с: сервер по нему понимает что сокет живой, иначе он
  // не отличает «клиент молчит» от «клиент исчез» и через 200с тишины рвёт
  // соединение. заодно держим соединение живым через прокси.
  setInterval(() => {
    // прямой send, не wsSend: ping не операция, гонять его через очередь
    // незачем — в очереди он бесмысленно провиснет до переподключения
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: "ping" }));
  }, 15000);
  setInterval(() => {
    if (S.cursors.size) present();
  }, 1000);
}

boot();