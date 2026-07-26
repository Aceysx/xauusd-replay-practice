/* 图表画线：水平线 / 趋势线 / 射线 / 路径 / 斐波那契 / 矩形 / 价格块 / 文字（可编辑） */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** 快捷键 → 工具（避开 B/S/C/L/Space/方向键等交易快捷键） */
const DRAW_TOOL_KEYS = {
  v: "cursor",
  "1": "cursor",
  h: "hline",
  "2": "hline",
  t: "trend",
  "3": "trend",
  y: "ray",
  "8": "ray",
  p: "path",
  "4": "path",
  f: "fib",
  "5": "fib",
  r: "rect",
  "6": "rect",
  z: "zone",
  "9": "zone",
  a: "text",
  "7": "text",
};
const HIT_PX = 9;
const HANDLE_R = 5;
const PATH_ARROW_LEN = 11;
const PATH_ARROW_WING = 5;
const TEXT_FONT_SIZE = 14;
const TEXT_CHAR_W = 8;
const TEXT_LINE_H = 18;
/** 画线描边：实线略粗于虚线预览 */
const STROKE_MAIN = 2;
const STROKE_DASH = 1.5;
const STROKE_GUIDE = 1;
const STROKE_FIB = 1.5;
const STROKE_ZONE_EDGE = 2;
const STROKE_ZONE_BAND = 1.5;

const DRAW_DEFAULT_COLORS = {
  hline: "#c9d1e0",
  trend: "#f0d78c",
  ray: "#e8a87c",
  path: "#d4b87a",
  fib: "#5b9cf5",
  rect: "#8fd4a8",
  zone: "#3dd68c",
  text: "#e6eaf2",
};
const DRAW_PALETTE = [
  "#e6eaf2",
  "#f0d78c",
  "#d4b87a",
  "#5b9cf5",
  "#8fd4a8",
  "#f07178",
];
const DRAW_COLOR_STORAGE_KEY = "replay_draw_stroke_color";

const drawState = {
  tool: "cursor",
  items: [],
  draft: null,
  preview: null,
  selectedId: null,
  editDrag: null,
  rectDragging: false,
  textEdit: null,
  nextId: 1,
  strokeColor: DRAW_DEFAULT_COLORS.trend,
  shiftKey: false,
  lastPointer: null,
};

function drawDefaultColor(type) {
  return DRAW_DEFAULT_COLORS[type] || "#e6eaf2";
}

function drawItemColor(item) {
  if (item?.color) return item.color;
  if (item?.type) return drawDefaultColor(item.type);
  return drawState.strokeColor;
}

function itemZ(item) {
  return Number.isFinite(item?.z) ? item.z : 0;
}

function sortedDrawItems() {
  return [...drawState.items].sort((a, b) => itemZ(a) - itemZ(b) || a.id - b.id);
}

function ensureItemsZ() {
  sortedDrawItems().forEach((it, i) => {
    it.z = i;
  });
}

function nextZ() {
  if (!drawState.items.length) return 0;
  return Math.max(...drawState.items.map(itemZ)) + 1;
}

function pushDrawItem(partial) {
  const id = drawState.nextId++;
  const item = { id, z: nextZ(), ...partial };
  drawState.items.push(item);
  return id;
}

/**
 * Horizontal ray from (time, price) extending left (toward earlier bars).
 * @returns {number|null} drawing id
 */
function addLeftHorizontalRay(time, price, color) {
  const t = Number(time);
  const p = Number(price);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return null;
  const id = pushDrawItem({
    type: "ray",
    points: [
      { time: t, price: p },
      { time: t - 3600, price: p },
    ],
    color: color || DRAW_DEFAULT_COLORS.ray,
  });
  notifyPracticeSave();
  renderDrawings();
  return id;
}

function bringLayerForward(id) {
  ensureItemsZ();
  const sorted = sortedDrawItems();
  const i = sorted.findIndex((it) => it.id === id);
  if (i < 0 || i >= sorted.length - 1) return;
  const z = sorted[i].z;
  sorted[i].z = sorted[i + 1].z;
  sorted[i + 1].z = z;
  notifyPracticeSave();
  renderDrawings();
}

function sendLayerBackward(id) {
  ensureItemsZ();
  const sorted = sortedDrawItems();
  const i = sorted.findIndex((it) => it.id === id);
  if (i <= 0) return;
  const z = sorted[i].z;
  sorted[i].z = sorted[i - 1].z;
  sorted[i - 1].z = z;
  notifyPracticeSave();
  renderDrawings();
}

function syncLayerToolbar() {
  const has = drawState.selectedId != null && drawState.tool === "cursor";
  document.querySelectorAll(".draw-toolbar [data-action^='layer-']").forEach((btn) => {
    btn.disabled = !has;
  });
}

function hexToRgb(hex) {
  let h = String(hex || "#888888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 200, g: 200, b: 200 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function colorWithAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function syncDrawColorUi() {
  const item = drawState.selectedId != null ? getItem(drawState.selectedId) : null;
  const hex = (item ? drawItemColor(item) : drawState.strokeColor).toLowerCase();
  document.querySelectorAll(".draw-color-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color === hex);
  });
}

function buildDrawColorPalette() {
  const root = document.getElementById("drawColorPalette");
  if (!root) return;
  root.replaceChildren();
  for (const hex of DRAW_PALETTE) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "draw-color-swatch";
    btn.dataset.color = hex;
    btn.style.setProperty("--swatch", hex);
    btn.addEventListener("click", () => onDrawColorInput(hex));
    root.appendChild(btn);
  }
  syncDrawColorUi();
}

function onDrawColorInput(hex) {
  drawState.strokeColor = hex;
  try {
    localStorage.setItem(DRAW_COLOR_STORAGE_KEY, hex);
  } catch (_) {}
  const item = drawState.selectedId != null ? getItem(drawState.selectedId) : null;
  if (item && drawState.tool === "cursor") {
    item.color = hex;
    notifyPracticeSave();
  }
  syncDrawColorUi();
  renderDrawings();
}

let drawChart = null;
let drawSeries = null;
let drawChartEl = null;
let drawOverlayEl = null;
let drawTextInputEl = null;
let onDrawToolChange = null;
/** 当前 chart series 上的 K 线，仅用于时间轴刻度换算（与 allBars 无关） */
let getSeriesBars = () => [];

function averageBarStep(bars) {
  if (!bars?.length) return 300;
  if (bars.length === 1) return 300;
  let sum = 0;
  let n = 0;
  const start = Math.max(1, bars.length - 5);
  for (let i = start; i < bars.length; i++) {
    sum += bars[i].time - bars[i - 1].time;
    n++;
  }
  return n ? sum / n : bars[1].time - bars[0].time;
}

function timeFromLogical(logical) {
  const bars = getSeriesBars();
  if (!bars.length) return null;
  if (logical < 0) {
    return bars[0].time + logical * averageBarStep(bars);
  }
  const last = bars.length - 1;
  if (logical >= last) {
    return bars[last].time + (logical - last) * averageBarStep(bars);
  }
  const lo = Math.floor(logical);
  const hi = Math.ceil(logical);
  if (lo === hi) return bars[lo].time;
  const t0 = bars[lo].time;
  const t1 = bars[hi].time;
  if (t1 === t0) return t0;
  return t0 + (logical - lo) * (t1 - t0);
}

function snapTimeAtChartX(x) {
  let time = drawChart.timeScale().coordinateToTime(x);
  if (time != null) return time;
  const toLogical = drawChart.timeScale().coordinateToLogical;
  if (typeof toLogical !== "function") return null;
  const logical = toLogical.call(drawChart.timeScale(), x);
  if (logical == null || !Number.isFinite(logical)) return null;
  return timeFromLogical(logical);
}

function drawClientToPoint(clientX, clientY) {
  if (!drawChart || !drawSeries || !drawChartEl) return null;
  const rect = drawChartEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const time = snapTimeAtChartX(x);
  const price = drawSeries.coordinateToPrice(y);
  if (time == null || price == null || !Number.isFinite(price)) return null;
  return { time, price, x, y };
}

/** 两根相邻 K 线时间之间按时间线性插值 X（只用 chart 时间轴 API） */
function interpolateTimeToX(t0, x0, t1, x1, time) {
  if (x0 == null || x1 == null || !Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  if (t1 === t0) return x0;
  const frac = (time - t0) / (t1 - t0);
  return x0 + frac * (x1 - x0);
}

/** 时间轴坐标 → 屏幕 X：精确 bar 用 timeToCoordinate，否则在相邻 bar 时间之间插值 */
function drawTimeToX(time) {
  if (!drawChart || time == null) return null;
  const ts = drawChart.timeScale();

  const direct = ts.timeToCoordinate(time);
  if (direct != null && Number.isFinite(direct)) return direct;

  const series = getSeriesBars();
  const n = series.length;
  if (!n) return null;

  const xAt = (t) => ts.timeToCoordinate(t);

  if (n === 1) return xAt(series[0].time);

  const first = series[0].time;
  const last = series[n - 1].time;

  if (time <= first) {
    return interpolateTimeToX(first, xAt(first), series[1].time, xAt(series[1].time), time);
  }
  if (time >= last) {
    return interpolateTimeToX(
      series[n - 2].time,
      xAt(series[n - 2].time),
      last,
      xAt(last),
      time
    );
  }

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  if (series[lo].time === time) return xAt(time);
  const hiIdx = lo + 1;
  return interpolateTimeToX(
    series[lo].time,
    xAt(series[lo].time),
    series[hiIdx].time,
    xAt(series[hiIdx].time),
    time
  );
}

function drawPriceToY(price) {
  return drawSeries?.priceToCoordinate(price) ?? null;
}

/** Shift：相对锚点吸附为横线（同价）或竖线（同时）——按屏幕位移较大方向 */
function snapOrthogonalToAnchor(anchor, pt) {
  if (!anchor || !pt) return pt;
  const ax = drawTimeToX(anchor.time);
  const ay = drawPriceToY(anchor.price);
  const bx = drawTimeToX(pt.time);
  const by = drawPriceToY(pt.price);
  if (ax == null || ay == null || bx == null || by == null) {
    return Math.abs(pt.time - anchor.time) >= Math.abs(pt.price - anchor.price)
      ? { time: pt.time, price: anchor.price }
      : { time: anchor.time, price: pt.price };
  }
  if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
    return { time: pt.time, price: anchor.price };
  }
  return { time: anchor.time, price: pt.price };
}

function maybeSnapRayPoint(anchor, pt) {
  if (!drawState.shiftKey || !anchor || !pt) return pt;
  return snapOrthogonalToAnchor(anchor, pt);
}

function syncPointerModifiers(e) {
  if (e && typeof e.clientX === "number") {
    drawState.lastPointer = { clientX: e.clientX, clientY: e.clientY };
  }
  if (e && typeof e.shiftKey === "boolean") {
    drawState.shiftKey = e.shiftKey;
  }
}

function reapplyPointerSnap() {
  if (!drawState.lastPointer || !drawChartEl) return;
  const { clientX, clientY } = drawState.lastPointer;
  const raw = drawClientToPoint(clientX, clientY);
  if (!raw) return;
  if (drawState.editDrag) {
    applyEditDrag(raw);
    renderDrawings();
    return;
  }
  if (drawState.draft?.type === "ray" && drawState.draft.points.length === 1) {
    drawState.preview = maybeSnapRayPoint(drawState.draft.points[0], raw);
    renderDrawings();
  }
}

/** 将线段裁剪到图表矩形内，避免画线溢出到下单区 */
function clipSegmentToRect(x1, y1, x2, y2, w, h) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, x1],
    [dx, w - x1],
    [-dy, y1],
    [dy, h - y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return {
    x1: x1 + t0 * dx,
    y1: y1 + t0 * dy,
    x2: x1 + t1 * dx,
    y2: y1 + t1 * dy,
  };
}

function drawExtendTrend(p1, p2, w, h) {
  const x1 = drawTimeToX(p1.time);
  const y1 = drawPriceToY(p1.price);
  const x2 = drawTimeToX(p2.time);
  const y2 = drawPriceToY(p2.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  if (Math.abs(x2 - x1) < 0.5) {
    return clipSegmentToRect(x1, y1, x2, y2, w, h);
  }
  const slope = (y2 - y1) / (x2 - x1);
  const ex1 = 0;
  const ey1 = y1 + slope * (0 - x1);
  const ex2 = w;
  const ey2 = y1 + slope * (w - x1);
  return clipSegmentToRect(ex1, ey1, ex2, ey2, w, h);
}

/** 射线：从 p1 出发，经 p2 确定方向，仅向 p2 一侧延伸至图表边界 */
function drawExtendRay(p1, p2, w, h) {
  const x1 = drawTimeToX(p1.time);
  const y1 = drawPriceToY(p1.price);
  const x2 = drawTimeToX(p2.time);
  const y2 = drawPriceToY(p2.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.hypot(dx, dy) < 0.5) {
    return { x1, y1, x2: x1, y2: y1 };
  }
  let tMax = 1;
  const candidates = [];
  if (Math.abs(dx) > 1e-9) {
    candidates.push((0 - x1) / dx);
    candidates.push((w - x1) / dx);
  }
  if (Math.abs(dy) > 1e-9) {
    candidates.push((0 - y1) / dy);
    candidates.push((h - y1) / dy);
  }
  for (const t of candidates) {
    if (t <= 0) continue;
    const x = x1 + t * dx;
    const y = y1 + t * dy;
    if (x >= -0.5 && x <= w + 0.5 && y >= -0.5 && y <= h + 0.5) {
      tMax = Math.max(tMax, t);
    }
  }
  return {
    x1,
    y1,
    x2: x1 + tMax * dx,
    y2: y1 + tMax * dy,
  };
}

function drawFibPrices(p1, p2) {
  const span = p2.price - p1.price;
  return FIB_LEVELS.map((lv) => ({
    level: lv,
    price: p1.price + lv * span,
  }));
}

/** 两点 → 屏幕矩形边界（time 升序，y 为屏幕坐标） */
function drawRectBounds(p1, p2) {
  const x1 = drawTimeToX(p1.time);
  const x2 = drawTimeToX(p2.time);
  const y1 = drawPriceToY(p1.price);
  const y2 = drawPriceToY(p2.price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
  return {
    left: Math.min(x1, x2),
    right: Math.max(x1, x2),
    top: Math.min(y1, y2),
    bottom: Math.max(y1, y2),
  };
}

function pathScreenPoints(points) {
  const out = [];
  for (const p of points) {
    const x = drawTimeToX(p.time);
    const y = drawPriceToY(p.price);
    if (y == null) return null;
    if (x == null) return null;
    out.push({ x, y });
  }
  return out.length >= 2 ? out : null;
}

function appendPathArrowHead(g, x1, y1, x2, y2, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1.5) return;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const bx = x2 - ux * PATH_ARROW_LEN;
  const by = y2 - uy * PATH_ARROW_LEN;
  g.appendChild(
    svgEl("polygon", {
      points: [
        `${x2},${y2}`,
        `${bx + px * PATH_ARROW_WING},${by + py * PATH_ARROW_WING}`,
        `${bx - px * PATH_ARROW_WING},${by - py * PATH_ARROW_WING}`,
      ].join(" "),
      fill: color,
      class: "draw-path-arrowhead",
    })
  );
}

function renderPathSegments(g, screenPts, { color, dashed, arrowOnLast }) {
  for (let i = 0; i < screenPts.length - 1; i++) {
    const p1 = screenPts[i];
    const p2 = screenPts[i + 1];
    const isLast = i === screenPts.length - 2;
    let x1 = p1.x;
    let y1 = p1.y;
    let x2 = p2.x;
    let y2 = p2.y;
    if (isLast && arrowOnLast) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len > PATH_ARROW_LEN) {
        const ux = dx / len;
        const uy = dy / len;
        const inset = PATH_ARROW_LEN * 0.85;
        x2 -= ux * inset;
        y2 -= uy * inset;
      }
    }
    g.appendChild(
      svgEl("line", {
        x1,
        y1,
        x2,
        y2,
        stroke: color,
        "stroke-width": dashed ? STROKE_DASH : STROKE_MAIN,
        "stroke-dasharray": dashed ? "6 4" : "none",
        class: isLast && arrowOnLast ? "draw-path-line draw-path-last" : "draw-path-line",
      })
    );
    if (isLast && arrowOnLast) {
      appendPathArrowHead(g, p1.x, p1.y, p2.x, p2.y, color);
    }
  }
}

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

function cloneItem(item) {
  if (item.type === "hline" || item.type === "text") return { ...item };
  return { ...item, points: item.points.map((p) => ({ ...p })) };
}

function textDisplayLines(text) {
  return String(text || "").split("\n");
}

function estimateTextScreenBox(item) {
  const x = drawTimeToX(item.time);
  const y = drawPriceToY(item.price);
  if (x == null || y == null) return null;
  const lines = textDisplayLines(item.text);
  const w = Math.max(24, ...lines.map((ln) => ln.length * TEXT_CHAR_W)) + 8;
  const h = lines.length * TEXT_LINE_H + 4;
  return { x, y, w, h };
}

function closeTextInput(commit) {
  const edit = drawState.textEdit;
  if (!edit || !drawTextInputEl) return;
  drawState.textEdit = null;
  drawTextInputEl.classList.add("hidden");
  drawTextInputEl.blur();

  if (!commit) {
    renderDrawings();
    return;
  }

  const value = drawTextInputEl.value.trim();
  if (!value) {
    if (typeof t === "function") alert(t("draw.text.empty"));
    renderDrawings();
    return;
  }

  if (edit.itemId != null) {
    const item = getItem(edit.itemId);
    if (item?.type === "text") {
      item.text = value;
      item.time = edit.time;
      item.price = edit.price;
      drawState.selectedId = item.id;
      notifyPracticeSave();
    }
  } else {
    const id = pushDrawItem({
      type: "text",
      time: edit.time,
      price: edit.price,
      text: value,
      color: drawState.strokeColor,
    });
    afterDrawComplete(id);
    return;
  }
  renderDrawings();
}

function openTextInputAt(pt, { itemId = null, initial = "" } = {}) {
  if (!drawTextInputEl || !drawChartEl) return;
  const area = drawChartEl.closest(".chart-area");
  if (!area) return;

  drawState.textEdit = { itemId, time: pt.time, price: pt.price };
  const rect = drawChartEl.getBoundingClientRect();
  const areaRect = area.getBoundingClientRect();
  drawTextInputEl.value = initial;
  drawTextInputEl.placeholder =
    typeof t === "function" ? t("draw.text.placeholder") : "输入文字…";
  drawTextInputEl.classList.remove("hidden");
  drawTextInputEl.style.left = `${rect.left - areaRect.left + pt.x}px`;
  drawTextInputEl.style.top = `${rect.top - areaRect.top + pt.y - TEXT_FONT_SIZE}px`;
  drawTextInputEl.focus();
  drawTextInputEl.select();
}

function beginEditTextItem(item) {
  const x = drawTimeToX(item.time);
  const y = drawPriceToY(item.price);
  if (x == null || y == null) return;
  drawState.selectedId = item.id;
  openTextInputAt(
    { time: item.time, price: item.price, x, y },
    { itemId: item.id, initial: item.text }
  );
}

function getItem(id) {
  return drawState.items.find((it) => it.id === id);
}

function renderVerticalGuide(g, time, h) {
  const x = drawTimeToX(time);
  if (x == null) return;
  g.appendChild(
    svgEl("line", {
      x1: x,
      y1: 0,
      x2: x,
      y2: h,
      stroke: "#8b95a8",
      "stroke-width": STROKE_GUIDE,
      "stroke-dasharray": "4 4",
      opacity: 0.75,
    })
  );
}

function renderCrossGuides(g, time, price, w, h) {
  const y = drawPriceToY(price);
  if (y != null) {
    g.appendChild(
      svgEl("line", {
        x1: 0,
        y1: y,
        x2: w,
        y2: y,
        stroke: "#8b95a8",
        "stroke-width": STROKE_GUIDE,
        "stroke-dasharray": "4 4",
        opacity: 0.75,
      })
    );
  }
  renderVerticalGuide(g, time, h);
}

function renderDrawings() {
  if (!drawOverlayEl || !drawChartEl) return;
  const w = drawChartEl.clientWidth;
  const h = drawChartEl.clientHeight;
  drawOverlayEl.setAttribute("width", w);
  drawOverlayEl.setAttribute("height", h);
  drawOverlayEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  drawOverlayEl.innerHTML = "";

  for (const item of sortedDrawItems()) {
    const selected = item.id === drawState.selectedId;
    const g = svgEl("g", {
      class: `draw-item${selected ? " draw-selected" : ""}`,
      "data-id": item.id,
    });
    if (item.type === "hline") renderHLine(g, item, w, h, false);
    else if (item.type === "trend") renderTrend(g, item, w, h, false);
    else if (item.type === "ray") renderRay(g, item, w, h, false);
    else if (item.type === "path") renderPath(g, item, w, h, false);
    else if (item.type === "fib") renderFib(g, item, w, h, false);
    else if (item.type === "rect") renderRect(g, item, w, h, false);
    else if (item.type === "zone") renderZone(g, item, w, h, false);
    else if (item.type === "text") renderText(g, item, false);
    drawOverlayEl.appendChild(g);
  }

  if (drawState.draft) {
    const g = svgEl("g", { class: "draw-draft" });
    const draftColor = drawState.strokeColor;
    if (drawState.draft.type === "trend" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderTrendSegment(g, drawState.draft.points[0], drawState.preview, w, h, true, draftColor);
    } else if (drawState.draft.type === "ray" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderRaySegment(g, drawState.draft.points[0], drawState.preview, w, h, true, draftColor);
    } else if (drawState.draft.type === "fib" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderFibShape(g, drawState.draft.points[0], drawState.preview, w, h, true, draftColor);
    } else if (drawState.draft.type === "path" && drawState.draft.points.length >= 1) {
      const pts = [...drawState.draft.points];
      if (drawState.preview) pts.push(drawState.preview);
      renderPath(g, { id: -1, type: "path", points: pts, color: draftColor }, w, h, true);
    } else if (drawState.draft.type === "rect" && drawState.draft.points.length >= 1) {
      const p1 = drawState.draft.points[0];
      const p2 = drawState.preview || p1;
      renderRect(g, { id: -1, type: "rect", points: [p1, p2], color: draftColor }, w, h, true);
    } else if (drawState.draft.type === "zone" && drawState.draft.points.length >= 1) {
      const p1 = drawState.draft.points[0];
      const p2 = drawState.preview || p1;
      renderZone(g, { id: -1, type: "zone", points: [p1, p2], color: draftColor }, w, h, true);
    }
    drawOverlayEl.appendChild(g);
  }

  if (drawState.tool === "hline" && drawState.preview && !drawState.draft) {
    const g = svgEl("g", { class: "draw-preview" });
    renderHLine(g, { price: drawState.preview.price, time: drawState.preview.time }, w, h, true);
    drawOverlayEl.appendChild(g);
  }
}

function renderHLine(g, item, w, h, preview) {
  const y = drawPriceToY(item.price);
  if (y == null) return;
  const selected = item.id === drawState.selectedId;
  const color = preview ? "#8b95a8" : drawItemColor(item);

  g.appendChild(
    svgEl("line", {
      x1: 0,
      y1: y,
      x2: w,
      y2: y,
      stroke: color,
      "stroke-width": selected ? STROKE_MAIN : STROKE_DASH,
      "stroke-dasharray": preview ? "4 4" : "none",
    })
  );

  if (preview) {
    renderCrossGuides(g, item.time, item.price, w, h);
  }
}

function renderTrend(g, item, w, h, draft) {
  if (item.points?.length < 2) return;
  const selected = item.id === drawState.selectedId;
  const color = drawItemColor(item);
  renderTrendSegment(g, item.points[0], item.points[1], w, h, draft, color);
  if (selected || draft) {
    item.points.forEach((p, i) => {
      const x = drawTimeToX(p.time);
      const y = drawPriceToY(p.price);
      if (x == null || y == null) return;
      g.appendChild(
        svgEl("circle", {
          cx: x,
          cy: y,
          r: HANDLE_R,
          fill: color,
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderTrendSegment(g, p1, p2, w, h, dashed, color) {
  const seg = drawExtendTrend(p1, p2, w, h);
  if (!seg) return;
  const stroke = color || drawDefaultColor("trend");
  g.appendChild(
    svgEl("line", {
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      stroke,
      "stroke-width": dashed ? STROKE_DASH : STROKE_MAIN,
      "stroke-dasharray": dashed ? "6 4" : "none",
      opacity: dashed ? 0.85 : 1,
    })
  );
}

function renderRay(g, item, w, h, draft) {
  if (item.points?.length < 2) return;
  const selected = item.id === drawState.selectedId;
  const color = drawItemColor(item);
  renderRaySegment(g, item.points[0], item.points[1], w, h, draft, color);
  if (selected || draft) {
    item.points.forEach((p, i) => {
      const x = drawTimeToX(p.time);
      const y = drawPriceToY(p.price);
      if (x == null || y == null) return;
      g.appendChild(
        svgEl("circle", {
          cx: x,
          cy: y,
          r: HANDLE_R,
          fill: color,
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderRaySegment(g, p1, p2, w, h, dashed, color) {
  const seg = drawExtendRay(p1, p2, w, h);
  if (!seg) return;
  const stroke = color || drawDefaultColor("ray");
  g.appendChild(
    svgEl("line", {
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      stroke,
      "stroke-width": dashed ? STROKE_DASH : STROKE_MAIN,
      "stroke-dasharray": dashed ? "6 4" : "none",
      opacity: dashed ? 0.85 : 1,
    })
  );
}

function renderPath(g, item, w, h, draft) {
  const points = item.points || [];
  if (points.length < 2) return;
  const screenPts = pathScreenPoints(points);
  if (!screenPts) return;
  const selected = item.id === drawState.selectedId;
  const color = drawItemColor(item);
  renderPathSegments(g, screenPts, {
    color,
    dashed: !!draft,
    arrowOnLast: true,
  });
  if (selected || draft) {
    const handlePts = draft && drawState.preview ? points.slice(0, -1) : points;
    handlePts.forEach((p, i) => {
      const x = drawTimeToX(p.time);
      const y = drawPriceToY(p.price);
      if (x == null || y == null) return;
      g.appendChild(
        svgEl("circle", {
          cx: x,
          cy: y,
          r: HANDLE_R,
          fill: color,
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderFib(g, item, w, h, draft) {
  if (item.points?.length < 2) return;
  const color = drawItemColor(item);
  renderFibShape(g, item.points[0], item.points[1], w, h, !!draft, color);
  const selected = item.id === drawState.selectedId;
  if (selected || draft) {
    item.points.forEach((p, i) => {
      const x = drawTimeToX(p.time);
      const y = drawPriceToY(p.price);
      if (x == null || y == null) return;
      g.appendChild(
        svgEl("circle", {
          cx: x,
          cy: y,
          r: HANDLE_R,
          fill: color,
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderFibShape(g, p1, p2, w, h, dashed, color) {
  const x1 = drawTimeToX(p1.time);
  const x2 = drawTimeToX(p2.time);
  if (x1 == null || x2 == null) return;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const dash = dashed ? "4 4" : "none";
  const stroke = color || drawDefaultColor("fib");

  const yA = drawPriceToY(p1.price);
  const yB = drawPriceToY(p2.price);
  if (yA != null && yB != null) {
    g.appendChild(
      svgEl("line", {
        x1: left,
        y1: yA,
        x2: left,
        y2: yB,
        stroke,
        "stroke-width": STROKE_FIB,
        opacity: 0.5,
        "stroke-dasharray": dash,
      })
    );
  }

  drawFibPrices(p1, p2).forEach(({ level, price }) => {
    const y = drawPriceToY(price);
    if (y == null) return;
    g.appendChild(
      svgEl("line", {
        x1: left,
        y1: y,
        x2: right,
        y2: y,
        stroke,
        "stroke-width": STROKE_FIB,
        "stroke-dasharray": dash,
      })
    );
    const t = svgEl("text", {
      x: right + 4,
      y: y + 4,
      fill: "#8b95a8",
      "font-size": 10,
    });
    t.textContent = `${(level * 100).toFixed(1)}%`;
    g.appendChild(t);
  });
}

function renderRectCornerHandles(g, points, color) {
  const fill = color || drawDefaultColor("rect");
  points.forEach((p, i) => {
    const x = drawTimeToX(p.time);
    const y = drawPriceToY(p.price);
    if (x == null || y == null) return;
    g.appendChild(
      svgEl("circle", {
        cx: x,
        cy: y,
        r: HANDLE_R + 2,
        fill,
        stroke: "#0f1115",
        "stroke-width": 2,
        class: "draw-handle",
        "data-point": i,
      })
    );
  });
}

function renderRect(g, item, w, h, draft) {
  if (!item.points?.length) return;
  const p1 = item.points[0];
  const p2 = item.points[1] ?? item.points[0];
  const color = drawItemColor(item);
  if (item.points.length >= 2 || draft) {
    renderRectShape(g, p1, p2, w, h, !!draft, color);
  }
  const selected = item.id === drawState.selectedId;
  if (selected || draft) {
    const handlePoints =
      draft && drawState.preview && item.points.length === 1
        ? [p1, drawState.preview]
        : item.points.length >= 2
          ? item.points
          : [p1];
    renderRectCornerHandles(g, handlePoints, color);
  }
}

/** 价格块：视觉接近开单 RR 区（半透明填充 + 左右边 + 上下价签） */
function renderZone(g, item, w, h, draft) {
  if (!item.points?.length) return;
  const p1 = item.points[0];
  const p2 = item.points[1] ?? item.points[0];
  const color = drawItemColor(item);
  if (item.points.length >= 2 || draft) {
    renderZoneShape(g, p1, p2, !!draft, color);
  }
  const selected = item.id === drawState.selectedId;
  if (selected || draft) {
    const handlePoints =
      draft && drawState.preview && item.points.length === 1
        ? [p1, drawState.preview]
        : item.points.length >= 2
          ? item.points
          : [p1];
    renderRectCornerHandles(g, handlePoints, color);
  }
}

function renderZoneShape(g, p1, p2, dashed, color) {
  const b = drawRectBounds(p1, p2);
  if (!b) return;
  const rw = b.right - b.left;
  const rh = b.bottom - b.top;
  if (rw < 0.5 && rh < 0.5) return;
  const stroke = color || drawDefaultColor("zone");
  const fillA = dashed ? 0.1 : 0.16;
  const edgeA = dashed ? 0.35 : 0.55;

  g.appendChild(
    svgEl("rect", {
      x: b.left,
      y: b.top,
      width: rw,
      height: rh,
      fill: colorWithAlpha(stroke, fillA),
      stroke: "none",
      class: "draw-zone-fill",
    })
  );
  g.appendChild(
    svgEl("line", {
      x1: b.left,
      y1: b.top,
      x2: b.left,
      y2: b.bottom,
      stroke: colorWithAlpha(stroke, edgeA),
      "stroke-width": STROKE_ZONE_EDGE,
      "stroke-dasharray": dashed ? "4 4" : "none",
    })
  );
  g.appendChild(
    svgEl("line", {
      x1: b.right,
      y1: b.top,
      x2: b.right,
      y2: b.bottom,
      stroke: colorWithAlpha(stroke, edgeA),
      "stroke-width": STROKE_ZONE_EDGE,
      "stroke-dasharray": dashed ? "4 4" : "none",
    })
  );
  g.appendChild(
    svgEl("line", {
      x1: b.left,
      y1: b.top,
      x2: b.right,
      y2: b.top,
      stroke: colorWithAlpha(stroke, edgeA * 0.85),
      "stroke-width": STROKE_ZONE_BAND,
      "stroke-dasharray": dashed ? "4 4" : "none",
    })
  );
  g.appendChild(
    svgEl("line", {
      x1: b.left,
      y1: b.bottom,
      x2: b.right,
      y2: b.bottom,
      stroke: colorWithAlpha(stroke, edgeA * 0.85),
      "stroke-width": STROKE_ZONE_BAND,
      "stroke-dasharray": dashed ? "4 4" : "none",
    })
  );

  const hi = Math.max(p1.price, p2.price);
  const lo = Math.min(p1.price, p2.price);
  const labelX = b.left + 6;
  const topLabel = svgEl("text", {
    x: labelX,
    y: b.top + 12,
    fill: stroke,
    "font-size": 11,
    "font-weight": 600,
    class: "draw-zone-label",
  });
  topLabel.textContent = hi.toFixed(2);
  g.appendChild(topLabel);
  const botLabel = svgEl("text", {
    x: labelX,
    y: b.bottom - 4,
    fill: stroke,
    "font-size": 11,
    "font-weight": 600,
    class: "draw-zone-label",
  });
  botLabel.textContent = lo.toFixed(2);
  g.appendChild(botLabel);
}

function renderText(g, item, preview) {
  const box = estimateTextScreenBox(item);
  if (!box) return;
  const selected = item.id === drawState.selectedId;
  const color = preview ? "#8b95a8" : drawItemColor(item);
  const lines = textDisplayLines(item.text);
  if (!lines.length) return;

  if (selected) {
    g.appendChild(
      svgEl("rect", {
        class: "draw-text-halo",
        x: box.x - 4,
        y: box.y - TEXT_FONT_SIZE,
        width: box.w,
        height: box.h,
        rx: 4,
        fill: preview ? colorWithAlpha(color, 0.08) : colorWithAlpha(color, 0.12),
        stroke: preview ? "#8b95a8" : color,
        "stroke-width": STROKE_DASH,
        "stroke-dasharray": preview ? "4 4" : "none",
      })
    );
  }

  lines.forEach((line, i) => {
    const el = svgEl("text", {
      class: "draw-text-label",
      x: box.x,
      y: box.y + i * TEXT_LINE_H,
      fill: color,
      "font-size": TEXT_FONT_SIZE,
      "font-weight": 600,
    });
    el.textContent = line;
    g.appendChild(el);
  });

  if (selected) {
    g.appendChild(
      svgEl("circle", {
        cx: box.x,
        cy: box.y,
        r: HANDLE_R,
        fill: color,
        stroke: "#0f1115",
        "stroke-width": 1,
        class: "draw-handle",
      })
    );
  }
}

function renderRectShape(g, p1, p2, w, h, dashed, color) {
  const b = drawRectBounds(p1, p2);
  if (!b) return;
  const rw = b.right - b.left;
  const rh = b.bottom - b.top;
  if (rw < 0.5 && rh < 0.5) return;
  const dash = dashed ? "4 4" : "none";
  const stroke = color || drawDefaultColor("rect");
  g.appendChild(
    svgEl("rect", {
      x: b.left,
      y: b.top,
      width: rw,
      height: rh,
      fill: colorWithAlpha(stroke, dashed ? 0.12 : 0.18),
      stroke,
      "stroke-width": dashed ? STROKE_DASH : STROKE_MAIN,
      "stroke-dasharray": dash,
    })
  );
}

function hitTestItem(clientX, clientY) {
  const pt = drawClientToPoint(clientX, clientY);
  if (!pt) return null;
  const w = drawChartEl.clientWidth;

  for (let i = drawState.items.length - 1; i >= 0; i--) {
    const item = drawState.items[i];

    if (item.type === "hline") {
      const y = drawPriceToY(item.price);
      const x = drawTimeToX(item.time);
      if (y != null && Math.abs(pt.y - y) < HIT_PX) {
        return { item, kind: "hline-price" };
      }
    }

    if (item.type === "trend" && item.points?.length >= 2) {
      const seg = drawExtendTrend(item.points[0], item.points[1], w, drawChartEl.clientHeight);
      if (seg && distPointToSegment(pt.x, pt.y, seg.x1, seg.y1, seg.x2, seg.y2) < HIT_PX) {
        for (let pi = 0; pi < 2; pi++) {
          const px = drawTimeToX(item.points[pi].time);
          const py = drawPriceToY(item.points[pi].price);
          if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
            return { item, kind: "trend-point", pointIndex: pi };
          }
        }
        return { item, kind: "trend-line" };
      }
    }

    if (item.type === "ray" && item.points?.length >= 2) {
      const seg = drawExtendRay(item.points[0], item.points[1], w, drawChartEl.clientHeight);
      if (seg && distPointToSegment(pt.x, pt.y, seg.x1, seg.y1, seg.x2, seg.y2) < HIT_PX) {
        for (let pi = 0; pi < 2; pi++) {
          const px = drawTimeToX(item.points[pi].time);
          const py = drawPriceToY(item.points[pi].price);
          if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
            return { item, kind: "ray-point", pointIndex: pi };
          }
        }
        return { item, kind: "ray-line" };
      }
    }

    if (item.type === "path" && item.points?.length >= 2) {
      for (let pi = 0; pi < item.points.length; pi++) {
        const px = drawTimeToX(item.points[pi].time);
        const py = drawPriceToY(item.points[pi].price);
        if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
          return { item, kind: "path-point", pointIndex: pi };
        }
      }
      const screenPts = pathScreenPoints(item.points);
      if (screenPts) {
        for (let si = 0; si < screenPts.length - 1; si++) {
          const p1 = screenPts[si];
          const p2 = screenPts[si + 1];
          if (distPointToSegment(pt.x, pt.y, p1.x, p1.y, p2.x, p2.y) < HIT_PX) {
            return { item, kind: "path-line" };
          }
        }
      }
    }

    if (item.type === "fib" && item.points?.length >= 2) {
      const p1 = item.points[0];
      const p2 = item.points[1];
      for (let pi = 0; pi < 2; pi++) {
        const px = drawTimeToX(item.points[pi].time);
        const py = drawPriceToY(item.points[pi].price);
        if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
          return { item, kind: "fib-point", pointIndex: pi };
        }
      }
      const x1 = drawTimeToX(p1.time);
      const x2 = drawTimeToX(p2.time);
      if (x1 != null && x2 != null) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        if (pt.x >= left - HIT_PX && pt.x <= right + HIT_PX) {
          for (const { price } of drawFibPrices(p1, p2)) {
            const y = drawPriceToY(price);
            if (y != null && Math.abs(pt.y - y) < HIT_PX) {
              return { item, kind: "fib-box" };
            }
          }
        }
      }
    }

    if ((item.type === "rect" || item.type === "zone") && item.points?.length >= 2) {
      const p1 = item.points[0];
      const p2 = item.points[1];
      const pointKind = item.type === "zone" ? "zone-point" : "rect-point";
      const boxKind = item.type === "zone" ? "zone-box" : "rect-box";
      for (let pi = 0; pi < 2; pi++) {
        const px = drawTimeToX(item.points[pi].time);
        const py = drawPriceToY(item.points[pi].price);
        if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
          return { item, kind: pointKind, pointIndex: pi };
        }
      }
      const b = drawRectBounds(p1, p2);
      if (b) {
        const pad = HIT_PX;
        const onEdge =
          (pt.x >= b.left - pad &&
            pt.x <= b.right + pad &&
            pt.y >= b.top - pad &&
            pt.y <= b.bottom + pad) &&
          (Math.abs(pt.x - b.left) < pad ||
            Math.abs(pt.x - b.right) < pad ||
            Math.abs(pt.y - b.top) < pad ||
            Math.abs(pt.y - b.bottom) < pad);
        const inside =
          pt.x > b.left + pad &&
          pt.x < b.right - pad &&
          pt.y > b.top + pad &&
          pt.y < b.bottom - pad;
        if (onEdge || inside) {
          return { item, kind: boxKind };
        }
      }
    }

    if (item.type === "text") {
      const box = estimateTextScreenBox(item);
      if (box) {
        const pad = HIT_PX;
        if (
          pt.x >= box.x - pad &&
          pt.x <= box.x + box.w + pad &&
          pt.y >= box.y - TEXT_FONT_SIZE - pad &&
          pt.y <= box.y - TEXT_FONT_SIZE + box.h + pad
        ) {
          const hx = box.x;
          const hy = box.y;
          if (Math.hypot(pt.x - hx, pt.y - hy) < HIT_PX + 6) {
            return { item, kind: "text-anchor" };
          }
          return { item, kind: "text-body" };
        }
      }
    }
  }
  return null;
}

function startEdit(hit, pt) {
  drawState.selectedId = hit.item.id;
  syncDrawColorUi();
  drawState.editDrag = {
    id: hit.item.id,
    kind: hit.kind,
    pointIndex: hit.pointIndex,
    start: { ...pt },
    snapshot: cloneItem(hit.item),
  };
}

function applyEditDrag(pt) {
  const item = getItem(drawState.editDrag?.id);
  const drag = drawState.editDrag;
  if (!item || !drag) return;

  if (item.type === "hline") {
    if (drag.kind === "hline-price") {
      item.price = pt.price;
    }
    return;
  }

  if (item.type === "trend" && item.points?.length >= 2) {
    if (drag.kind === "trend-point") {
      item.points[drag.pointIndex] = { time: pt.time, price: pt.price };
    } else if (drag.kind === "trend-line") {
      const dt = pt.time - drag.start.time;
      const dp = pt.price - drag.start.price;
      item.points = drag.snapshot.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      }));
    }
    return;
  }

  if (item.type === "ray" && item.points?.length >= 2) {
    if (drag.kind === "ray-point") {
      const other = item.points[1 - drag.pointIndex];
      item.points[drag.pointIndex] = maybeSnapRayPoint(other, {
        time: pt.time,
        price: pt.price,
      });
    } else if (drag.kind === "ray-line") {
      const dt = pt.time - drag.start.time;
      const dp = pt.price - drag.start.price;
      item.points = drag.snapshot.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      }));
    }
    return;
  }

  if (item.type === "path" && item.points?.length >= 2) {
    if (drag.kind === "path-point") {
      item.points[drag.pointIndex] = { time: pt.time, price: pt.price };
    } else if (drag.kind === "path-line") {
      const dt = pt.time - drag.start.time;
      const dp = pt.price - drag.start.price;
      item.points = drag.snapshot.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      }));
    }
    return;
  }

  if (item.type === "fib" && item.points?.length >= 2) {
    if (drag.kind === "fib-point") {
      item.points[drag.pointIndex] = { time: pt.time, price: pt.price };
    } else if (drag.kind === "fib-box") {
      const dt = pt.time - drag.start.time;
      const dp = pt.price - drag.start.price;
      item.points = drag.snapshot.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      }));
    }
    return;
  }

  if ((item.type === "rect" || item.type === "zone") && item.points?.length >= 2) {
    if (drag.kind === "rect-point" || drag.kind === "zone-point") {
      item.points[drag.pointIndex] = { time: pt.time, price: pt.price };
    } else if (drag.kind === "rect-box" || drag.kind === "zone-box") {
      const dt = pt.time - drag.start.time;
      const dp = pt.price - drag.start.price;
      item.points = drag.snapshot.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      }));
    }
    return;
  }

  if (item.type === "text") {
    if (drag.kind === "text-anchor" || drag.kind === "text-body") {
      item.time = pt.time;
      item.price = pt.price;
    }
  }
}

function finishDraft() {
  if (!drawState.draft || drawState.draft.points.length < 2) return null;
  const id = drawState.nextId++;
  drawState.items.push({
    id,
    type: drawState.draft.type,
    points: drawState.draft.points.map((p) => ({ ...p })),
    color: drawState.strokeColor,
  });
  drawState.draft = null;
  drawState.preview = null;
  return id;
}

function pathPointsEqual(a, b) {
  return (
    a &&
    b &&
    a.time === b.time &&
    Math.abs(a.price - b.price) < 1e-9
  );
}

function collapsePathPoints(points) {
  const out = [];
  for (const p of points) {
    if (out.length && pathPointsEqual(out[out.length - 1], p)) continue;
    out.push(p);
  }
  return out;
}

function finishPathDraft(opts = {}) {
  const draft = drawState.draft;
  if (draft?.type !== "path") return null;
  let points = collapsePathPoints(draft.points.map((p) => ({ ...p })));
  if (opts.includePreview && drawState.preview) {
    const last = points[points.length - 1];
    const p = drawState.preview;
    if (!pathPointsEqual(last, p)) {
      points.push({ time: p.time, price: p.price });
    }
  }
  points = collapsePathPoints(points);
  if (points.length < 2) return null;
  const id = drawState.nextId++;
  drawState.items.push({ id, type: "path", points, color: drawState.strokeColor });
  drawState.draft = null;
  drawState.preview = null;
  return id;
}

function afterDrawComplete(newId) {
  drawState.selectedId = newId ?? null;
  syncDrawColorUi();
  setDrawTool("cursor");
  renderDrawings();
  notifyPracticeSave();
}

function finishRectDrag() {
  if (!drawState.rectDragging) return;
  drawState.rectDragging = false;
  const draft = drawState.draft;
  const pt = drawState.preview;
  const okType = draft && (draft.type === "rect" || draft.type === "zone");
  if (!okType || draft.points.length !== 1 || !pt) {
    drawState.draft = null;
    drawState.preview = null;
    renderDrawings();
    return;
  }
  const p1 = draft.points[0];
  const b = drawRectBounds(p1, pt);
  if (!b || b.right - b.left < 4 || b.bottom - b.top < 4) {
    drawState.draft = null;
    drawState.preview = null;
    renderDrawings();
    return;
  }
  draft.points.push({ time: pt.time, price: pt.price });
  const id = finishDraft();
  if (id != null) afterDrawComplete(id);
  else renderDrawings();
}

function placeDrawing(pt) {
  if (drawState.tool === "hline") {
    const id = drawState.nextId++;
    drawState.items.push({
      id,
      type: "hline",
      price: pt.price,
      time: pt.time,
      color: drawState.strokeColor,
    });
    drawState.preview = null;
    afterDrawComplete(id);
    return;
  }

  if (drawState.tool === "rect" || drawState.tool === "zone" || drawState.tool === "text") return;

  if (drawState.tool === "path") {
    if (!drawState.draft) {
      drawState.draft = { type: "path", points: [{ time: pt.time, price: pt.price }] };
    } else {
      const last = drawState.draft.points[drawState.draft.points.length - 1];
      if (!pathPointsEqual(last, pt)) {
        drawState.draft.points.push({ time: pt.time, price: pt.price });
      }
    }
    return;
  }

  if (!drawState.draft) {
    drawState.draft = { type: drawState.tool, points: [{ time: pt.time, price: pt.price }] };
  } else {
    let p = { time: pt.time, price: pt.price };
    if (drawState.draft.type === "ray" && drawState.draft.points.length === 1) {
      p = maybeSnapRayPoint(drawState.draft.points[0], p);
    }
    drawState.draft.points.push(p);
    if (drawState.draft.points.length >= 2) {
      const id = finishDraft();
      if (id != null) afterDrawComplete(id);
    }
  }
}

function onChartMouseDown(e) {
  if (e.button !== 0 || !drawChartEl) return;

  syncPointerModifiers(e);
  const pt = drawClientToPoint(e.clientX, e.clientY);
  if (!pt) return;

  if (drawState.tool === "cursor") {
    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      if (hit.item.type === "text" && hit.kind === "text-body") {
        drawState.selectedId = hit.item.id;
        syncDrawColorUi();
        startEdit(hit, pt);
      } else {
        startEdit(hit, pt);
      }
      renderDrawings();
    } else {
      drawState.selectedId = null;
      syncDrawColorUi();
      renderDrawings();
    }
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (drawState.tool === "rect" || drawState.tool === "zone") {
    drawState.draft = { type: drawState.tool, points: [{ time: pt.time, price: pt.price }] };
    drawState.preview = { time: pt.time, price: pt.price };
    drawState.rectDragging = true;
    renderDrawings();
    return;
  }

  if (drawState.tool === "text") {
    openTextInputAt(pt);
    return;
  }

  placeDrawing(pt);
  renderDrawings();
}

function onChartMouseMove(e) {
  syncPointerModifiers(e);
  let pt = drawClientToPoint(e.clientX, e.clientY);
  if (!pt) return;

  if (drawState.editDrag) {
    e.preventDefault();
    applyEditDrag(pt);
    renderDrawings();
    return;
  }

  if (drawState.tool === "hline" && !drawState.draft) {
    drawState.preview = pt;
    renderDrawings();
    return;
  }

  if (drawState.draft) {
    if (drawState.draft.type === "ray" && drawState.draft.points.length === 1) {
      pt = maybeSnapRayPoint(drawState.draft.points[0], pt);
    }
    drawState.preview = pt;
    renderDrawings();
    return;
  }

  if (drawState.tool === "path") {
    drawState.preview = pt;
    renderDrawings();
  }
}

function onChartMouseUp() {
  if (drawState.rectDragging) finishRectDrag();
  if (drawState.editDrag) notifyPracticeSave();
  drawState.editDrag = null;
}

function onChartDblClick(e) {
  if (!drawChartEl) return;
  if (drawState.tool === "path") {
    e.preventDefault();
    e.stopPropagation();
    const id = finishPathDraft({ includePreview: true });
    if (id != null) afterDrawComplete(id);
    return;
  }
  if (drawState.tool !== "cursor") return;
  const hit = hitTestItem(e.clientX, e.clientY);
  if (!hit || hit.item.type !== "text") return;
  e.preventDefault();
  e.stopPropagation();
  beginEditTextItem(hit.item);
}

function onChartContextMenu(e) {
  if (drawState.tool !== "path") return;
  const n = drawState.draft?.points?.length ?? 0;
  if (n < 2 && !(n === 1 && drawState.preview)) return;
  e.preventDefault();
  const id = finishPathDraft({ includePreview: true });
  if (id != null) afterDrawComplete(id);
}

function drawKeyBlocked() {
  if (drawState.textEdit && drawTextInputEl && !drawTextInputEl.classList.contains("hidden")) {
    return true;
  }
  const el = document.activeElement;
  if (!el) return false;
  if (el.id === "drawTextInput" && el.classList.contains("hidden")) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function onDrawKeyDown(e) {
  if (e.key === "Shift") {
    drawState.shiftKey = true;
    if (!e.repeat) reapplyPointerSnap();
  }

  if (drawState.textEdit && drawTextInputEl && !drawTextInputEl.classList.contains("hidden")) {
    if (e.key === "Enter") {
      e.preventDefault();
      closeTextInput(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeTextInput(false);
    }
    return;
  }

  if (
    !drawKeyBlocked() &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.repeat
  ) {
    const lookup = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const tool = DRAW_TOOL_KEYS[lookup];
    if (tool) {
      e.preventDefault();
      setDrawTool(tool);
      return;
    }
  }

  if (e.key === "Escape") {
    e.preventDefault();
    drawState.draft = null;
    drawState.preview = null;
    drawState.editDrag = null;
    drawState.rectDragging = false;
    if (drawState.tool !== "cursor") {
      setDrawTool("cursor");
    } else {
      drawState.selectedId = null;
      renderDrawings();
    }
    return;
  }
  if (
    e.key === "Enter" &&
    drawState.tool === "path" &&
    (drawState.draft?.points?.length >= 2 ||
      (drawState.draft?.points?.length === 1 && drawState.preview))
  ) {
    e.preventDefault();
    const id = finishPathDraft({ includePreview: true });
    if (id != null) afterDrawComplete(id);
    return;
  }
  if (
    e.key === "Enter" &&
    drawState.tool === "cursor" &&
    drawState.selectedId != null
  ) {
    const item = getItem(drawState.selectedId);
    if (item?.type === "text") {
      e.preventDefault();
      beginEditTextItem(item);
    }
  }
  if ((e.key === "Delete" || e.key === "Backspace") && drawState.selectedId != null) {
    drawState.items = drawState.items.filter((it) => it.id !== drawState.selectedId);
    drawState.selectedId = null;
    renderDrawings();
    notifyPracticeSave();
  }
}

function onDrawKeyUp(e) {
  if (e.key === "Shift") {
    drawState.shiftKey = false;
    reapplyPointerSnap();
  }
}

function setDrawTool(tool) {
  closeTextInput(false);
  drawState.tool = tool;
  drawState.draft = null;
  drawState.preview = null;
  drawState.editDrag = null;
  drawState.rectDragging = false;
  const area = drawChartEl?.closest(".chart-area");
  if (area) area.classList.toggle("draw-active", tool !== "cursor");
  document.querySelectorAll(".draw-toolbar [data-tool]").forEach((btn) => {
    if (btn.dataset.tool === "clear") return;
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  if (onDrawToolChange) onDrawToolChange(tool);
  renderDrawings();
}

function clearDrawSelection() {
  drawState.selectedId = null;
  renderDrawings();
}

function clearDrawings() {
  drawState.items = [];
  drawState.draft = null;
  drawState.preview = null;
  drawState.selectedId = null;
  drawState.editDrag = null;
  drawState.rectDragging = false;
  renderDrawings();
  notifyPracticeSave();
}

function notifyPracticeSave() {
  if (typeof scheduleSavePracticeState === "function") scheduleSavePracticeState();
}

function exportDrawingsState() {
  return {
    items: drawState.items.map((it) => {
      if (it.type === "hline" || it.type === "text") return { ...it };
      return { ...it, points: it.points?.map((p) => ({ ...p })) ?? [] };
    }),
    nextId: drawState.nextId,
  };
}

function importDrawingsState(data) {
  if (!data) return;
  drawState.items = (data.items || []).map((it) => {
    if (it.type === "hline" || it.type === "text") return { ...it };
    return { ...it, points: it.points?.map((p) => ({ ...p })) ?? [] };
  });
  drawState.nextId = data.nextId ?? 1;
  drawState.draft = null;
  drawState.preview = null;
  drawState.selectedId = null;
  renderDrawings();
}

function initDrawings(chart, series, chartEl, hooks = {}) {
  drawChart = chart;
  drawSeries = series;
  drawChartEl = chartEl;
  onDrawToolChange = hooks.onToolChange ?? null;
  getSeriesBars = hooks.getSeriesBars ?? (() => []);
  drawOverlayEl = document.getElementById("drawOverlay");
  drawTextInputEl = document.getElementById("drawTextInput");
  if (!drawChartEl) return;

  drawChartEl.addEventListener("mousedown", onChartMouseDown, true);
  drawChartEl.addEventListener("dblclick", onChartDblClick, true);
  drawChartEl.addEventListener("contextmenu", onChartContextMenu, true);
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);
  window.addEventListener("keydown", onDrawKeyDown);
  window.addEventListener("keyup", onDrawKeyUp);

  if (drawTextInputEl) {
    drawTextInputEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        closeTextInput(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeTextInput(false);
      }
    });
    drawTextInputEl.addEventListener("mousedown", (e) => e.stopPropagation());
    drawTextInputEl.addEventListener("blur", () => {
      if (drawState.textEdit) closeTextInput(true);
    });
  }

  document.querySelectorAll(".draw-toolbar [data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.tool;
      if (tool === "clear") {
        clearDrawings();
        return;
      }
      setDrawTool(tool);
    });
  });

  try {
    const saved = localStorage.getItem(DRAW_COLOR_STORAGE_KEY);
    if (saved && DRAW_PALETTE.includes(saved.toLowerCase())) {
      drawState.strokeColor = saved.toLowerCase();
    }
  } catch (_) {}

  buildDrawColorPalette();

  setDrawTool("cursor");
}

function isDrawToolActive() {
  return drawState.tool !== "cursor";
}

function isDrawEditing() {
  return (
    drawState.editDrag != null ||
    (drawState.textEdit != null &&
      drawTextInputEl &&
      !drawTextInputEl.classList.contains("hidden"))
  );
}
