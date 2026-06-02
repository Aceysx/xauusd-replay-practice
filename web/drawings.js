/* 图表画线：水平线 / 趋势线 / 斐波那契（可编辑） */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const HIT_PX = 8;
const HANDLE_R = 5;

const drawState = {
  tool: "cursor",
  items: [],
  draft: null,
  preview: null,
  selectedId: null,
  editDrag: null,
  nextId: 1,
};

let drawChart = null;
let drawSeries = null;
let drawChartEl = null;
let drawOverlayEl = null;

function drawClientToPoint(clientX, clientY) {
  if (!drawChart || !drawSeries || !drawChartEl) return null;
  const rect = drawChartEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const time = drawChart.timeScale().coordinateToTime(x);
  const price = drawSeries.coordinateToPrice(y);
  if (time == null || price == null || !Number.isFinite(price)) return null;
  return { time, price, x, y };
}

function drawTimeToX(time) {
  return drawChart?.timeScale().timeToCoordinate(time) ?? null;
}

function drawPriceToY(price) {
  return drawSeries?.priceToCoordinate(price) ?? null;
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

function drawFibPrices(p1, p2) {
  const low = Math.min(p1.price, p2.price);
  const high = Math.max(p1.price, p2.price);
  const span = high - low;
  return FIB_LEVELS.map((lv) => ({
    level: lv,
    price: high - lv * span,
  }));
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
  if (item.type === "hline") return { ...item };
  return { ...item, points: item.points.map((p) => ({ ...p })) };
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
      "stroke-width": 1,
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
        "stroke-width": 1,
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

  for (const item of drawState.items) {
    const selected = item.id === drawState.selectedId;
    const g = svgEl("g", {
      class: `draw-item${selected ? " draw-selected" : ""}`,
      "data-id": item.id,
    });
    if (item.type === "hline") renderHLine(g, item, w, h, false);
    else if (item.type === "trend") renderTrend(g, item, w, h, false);
    else if (item.type === "fib") renderFib(g, item, w, false);
    drawOverlayEl.appendChild(g);
  }

  if (drawState.draft) {
    const g = svgEl("g", { class: "draw-draft" });
    if (drawState.draft.type === "trend" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderTrendSegment(g, drawState.draft.points[0], drawState.preview, w, h, true);
    } else if (drawState.draft.type === "fib" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderFibShape(g, drawState.draft.points[0], drawState.preview, w, h, true);
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

  g.appendChild(
    svgEl("line", {
      x1: 0,
      y1: y,
      x2: w,
      y2: y,
      stroke: preview ? "#8b95a8" : selected ? "#e6eaf2" : "#c9d1e0",
      "stroke-width": selected ? 1.5 : 1,
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
  renderTrendSegment(g, item.points[0], item.points[1], w, h, draft);
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
          fill: "#f0d78c",
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderTrendSegment(g, p1, p2, w, h, dashed) {
  const seg = drawExtendTrend(p1, p2, w, h);
  if (!seg) return;
  g.appendChild(
    svgEl("line", {
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      stroke: dashed ? "#e6c87a" : "#f0d78c",
      "stroke-width": dashed ? 1 : 1.5,
      "stroke-dasharray": dashed ? "6 4" : "none",
    })
  );
}

function renderFib(g, item, w, h, draft) {
  if (item.points?.length < 2) return;
  renderFibShape(g, item.points[0], item.points[1], w, h, !!draft);
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
          fill: "#5b9cf5",
          stroke: "#0f1115",
          "stroke-width": 1,
          class: "draw-handle",
          "data-point": i,
        })
      );
    });
  }
}

function renderFibShape(g, p1, p2, w, h, dashed) {
  const x1 = drawTimeToX(p1.time);
  const x2 = drawTimeToX(p2.time);
  if (x1 == null || x2 == null) return;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const dash = dashed ? "4 4" : "none";

  const yA = drawPriceToY(p1.price);
  const yB = drawPriceToY(p2.price);
  if (yA != null && yB != null) {
    g.appendChild(
      svgEl("line", {
        x1: left,
        y1: yA,
        x2: left,
        y2: yB,
        stroke: "#5b9cf5",
        "stroke-width": 1,
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
        stroke: "#5b9cf5",
        "stroke-width": 1,
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
  }
  return null;
}

function startEdit(hit, pt) {
  drawState.selectedId = hit.item.id;
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
  }
}

function finishDraft() {
  if (!drawState.draft || drawState.draft.points.length < 2) return null;
  const id = drawState.nextId++;
  drawState.items.push({
    id,
    type: drawState.draft.type,
    points: drawState.draft.points.map((p) => ({ ...p })),
  });
  drawState.draft = null;
  drawState.preview = null;
  return id;
}

function afterDrawComplete(newId) {
  drawState.selectedId = newId ?? null;
  setDrawTool("cursor");
  notifyPracticeSave();
}

function placeDrawing(pt) {
  if (drawState.tool === "hline") {
    const id = drawState.nextId++;
    drawState.items.push({
      id,
      type: "hline",
      price: pt.price,
      time: pt.time,
    });
    drawState.preview = null;
    afterDrawComplete(id);
    return;
  }

  if (!drawState.draft) {
    drawState.draft = { type: drawState.tool, points: [{ time: pt.time, price: pt.price }] };
  } else {
    drawState.draft.points.push({ time: pt.time, price: pt.price });
    if (drawState.draft.points.length >= 2) {
      const id = finishDraft();
      if (id != null) afterDrawComplete(id);
    }
  }
}

function onChartMouseDown(e) {
  if (e.button !== 0 || !drawChartEl) return;

  const pt = drawClientToPoint(e.clientX, e.clientY);
  if (!pt) return;

  if (drawState.tool === "cursor") {
    const hit = hitTestItem(e.clientX, e.clientY);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      startEdit(hit, pt);
      renderDrawings();
    } else {
      drawState.selectedId = null;
      renderDrawings();
    }
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  placeDrawing(pt);
  renderDrawings();
}

function onChartMouseMove(e) {
  const pt = drawClientToPoint(e.clientX, e.clientY);
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
    drawState.preview = pt;
    renderDrawings();
  }
}

function onChartMouseUp() {
  if (drawState.editDrag) notifyPracticeSave();
  drawState.editDrag = null;
}

function onDrawKeyDown(e) {
  if (e.key === "Escape") {
    drawState.draft = null;
    drawState.preview = null;
    drawState.editDrag = null;
    renderDrawings();
  }
  if ((e.key === "Delete" || e.key === "Backspace") && drawState.selectedId != null) {
    drawState.items = drawState.items.filter((it) => it.id !== drawState.selectedId);
    drawState.selectedId = null;
    renderDrawings();
    notifyPracticeSave();
  }
}

function setDrawTool(tool) {
  drawState.tool = tool;
  drawState.draft = null;
  drawState.preview = null;
  drawState.editDrag = null;
  const area = drawChartEl?.closest(".chart-area");
  if (area) area.classList.toggle("draw-active", tool !== "cursor");
  document.querySelectorAll(".draw-toolbar [data-tool]").forEach((btn) => {
    if (btn.dataset.tool === "clear") return;
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
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
  renderDrawings();
  notifyPracticeSave();
}

function notifyPracticeSave() {
  if (typeof scheduleSavePracticeState === "function") scheduleSavePracticeState();
}

function exportDrawingsState() {
  return {
    items: drawState.items.map((it) => {
      if (it.type === "hline") return { ...it };
      return { ...it, points: it.points?.map((p) => ({ ...p })) ?? [] };
    }),
    nextId: drawState.nextId,
  };
}

function importDrawingsState(data) {
  if (!data) return;
  drawState.items = (data.items || []).map((it) => {
    if (it.type === "hline") return { ...it };
    return { ...it, points: it.points?.map((p) => ({ ...p })) ?? [] };
  });
  drawState.nextId = data.nextId ?? 1;
  drawState.draft = null;
  drawState.preview = null;
  drawState.selectedId = null;
  renderDrawings();
}

function initDrawings(chart, series, chartEl) {
  drawChart = chart;
  drawSeries = series;
  drawChartEl = chartEl;
  drawOverlayEl = document.getElementById("drawOverlay");
  if (!drawChartEl) return;

  drawChartEl.addEventListener("mousedown", onChartMouseDown, true);
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);
  window.addEventListener("keydown", onDrawKeyDown);

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

  setDrawTool("cursor");
}

function isDrawToolActive() {
  return drawState.tool !== "cursor";
}

function isDrawEditing() {
  return drawState.editDrag != null;
}
