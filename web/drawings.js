/* 图表画线：水平线 / 趋势线 / 斐波那契 / 矩形 / 文字（可编辑） */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const HIT_PX = 8;
const HANDLE_R = 5;
const TEXT_FONT_SIZE = 14;
const TEXT_CHAR_W = 8;
const TEXT_LINE_H = 18;

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
};

let drawChart = null;
let drawSeries = null;
let drawChartEl = null;
let drawOverlayEl = null;
let drawTextInputEl = null;

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
  drawTextInputEl.classList.add("hidden");
  drawState.textEdit = null;

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
    const id = drawState.nextId++;
    drawState.items.push({
      id,
      type: "text",
      time: edit.time,
      price: edit.price,
      text: value,
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
    else if (item.type === "rect") renderRect(g, item, w, h, false);
    else if (item.type === "text") renderText(g, item, false);
    drawOverlayEl.appendChild(g);
  }

  if (drawState.draft) {
    const g = svgEl("g", { class: "draw-draft" });
    if (drawState.draft.type === "trend" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderTrendSegment(g, drawState.draft.points[0], drawState.preview, w, h, true);
    } else if (drawState.draft.type === "fib" && drawState.draft.points.length >= 1 && drawState.preview) {
      renderFibShape(g, drawState.draft.points[0], drawState.preview, w, h, true);
    } else if (drawState.draft.type === "rect" && drawState.draft.points.length >= 1) {
      const p1 = drawState.draft.points[0];
      const p2 = drawState.preview || p1;
      renderRect(g, { id: -1, type: "rect", points: [p1, p2] }, w, h, true);
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

function renderRectCornerHandles(g, points) {
  points.forEach((p, i) => {
    const x = drawTimeToX(p.time);
    const y = drawPriceToY(p.price);
    if (x == null || y == null) return;
    g.appendChild(
      svgEl("circle", {
        cx: x,
        cy: y,
        r: HANDLE_R + 2,
        fill: "#8fd4a8",
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
  if (item.points.length >= 2 || draft) {
    renderRectShape(g, p1, p2, w, h, !!draft);
  }
  const selected = item.id === drawState.selectedId;
  if (selected || draft) {
    const handlePoints =
      draft && drawState.preview && item.points.length === 1
        ? [p1, drawState.preview]
        : item.points.length >= 2
          ? item.points
          : [p1];
    renderRectCornerHandles(g, handlePoints);
  }
}

function renderText(g, item, preview) {
  const box = estimateTextScreenBox(item);
  if (!box) return;
  const selected = item.id === drawState.selectedId;
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
        fill: preview ? "rgba(230, 200, 122, 0.08)" : "rgba(230, 200, 122, 0.12)",
        stroke: preview ? "#8b95a8" : "#e6c87a",
        "stroke-width": 1,
        "stroke-dasharray": preview ? "4 4" : "none",
      })
    );
  }

  lines.forEach((line, i) => {
    const el = svgEl("text", {
      class: "draw-text-label",
      x: box.x,
      y: box.y + i * TEXT_LINE_H,
      fill: preview ? "#8b95a8" : selected ? "#f0d78c" : "#e6eaf2",
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
        fill: "#e6c87a",
        stroke: "#0f1115",
        "stroke-width": 1,
        class: "draw-handle",
      })
    );
  }
}

function renderRectShape(g, p1, p2, w, h, dashed) {
  const b = drawRectBounds(p1, p2);
  if (!b) return;
  const rw = b.right - b.left;
  const rh = b.bottom - b.top;
  if (rw < 0.5 && rh < 0.5) return;
  const dash = dashed ? "4 4" : "none";
  g.appendChild(
    svgEl("rect", {
      x: b.left,
      y: b.top,
      width: rw,
      height: rh,
      fill: dashed ? "rgba(143, 212, 168, 0.12)" : "rgba(143, 212, 168, 0.18)",
      stroke: dashed ? "#8fd4a8" : "#a8e6bc",
      "stroke-width": dashed ? 1 : 1.5,
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

    if (item.type === "rect" && item.points?.length >= 2) {
      const p1 = item.points[0];
      const p2 = item.points[1];
      for (let pi = 0; pi < 2; pi++) {
        const px = drawTimeToX(item.points[pi].time);
        const py = drawPriceToY(item.points[pi].price);
        if (px != null && py != null && Math.hypot(pt.x - px, pt.y - py) < HIT_PX + 4) {
          return { item, kind: "rect-point", pointIndex: pi };
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
          return { item, kind: "rect-box" };
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
    return;
  }

  if (item.type === "rect" && item.points?.length >= 2) {
    if (drag.kind === "rect-point") {
      item.points[drag.pointIndex] = { time: pt.time, price: pt.price };
    } else if (drag.kind === "rect-box") {
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
  });
  drawState.draft = null;
  drawState.preview = null;
  return id;
}

function afterDrawComplete(newId) {
  drawState.selectedId = newId ?? null;
  setDrawTool("cursor");
  renderDrawings();
  notifyPracticeSave();
}

function finishRectDrag() {
  if (!drawState.rectDragging) return;
  drawState.rectDragging = false;
  const draft = drawState.draft;
  const pt = drawState.preview;
  if (!draft || draft.type !== "rect" || draft.points.length !== 1 || !pt) {
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
    });
    drawState.preview = null;
    afterDrawComplete(id);
    return;
  }

  if (drawState.tool === "rect" || drawState.tool === "text") return;

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
      if (hit.item.type === "text" && hit.kind === "text-body") {
        drawState.selectedId = hit.item.id;
        startEdit(hit, pt);
      } else {
        startEdit(hit, pt);
      }
      renderDrawings();
    } else {
      drawState.selectedId = null;
      renderDrawings();
    }
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (drawState.tool === "rect") {
    drawState.draft = { type: "rect", points: [{ time: pt.time, price: pt.price }] };
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
  if (drawState.rectDragging) finishRectDrag();
  if (drawState.editDrag) notifyPracticeSave();
  drawState.editDrag = null;
}

function onChartDblClick(e) {
  if (drawState.tool !== "cursor" || !drawChartEl) return;
  const hit = hitTestItem(e.clientX, e.clientY);
  if (!hit || hit.item.type !== "text") return;
  e.preventDefault();
  e.stopPropagation();
  beginEditTextItem(hit.item);
}

function onDrawKeyDown(e) {
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
  if (e.key === "Escape") {
    drawState.draft = null;
    drawState.preview = null;
    drawState.editDrag = null;
    drawState.rectDragging = false;
    renderDrawings();
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

function initDrawings(chart, series, chartEl) {
  drawChart = chart;
  drawSeries = series;
  drawChartEl = chartEl;
  drawOverlayEl = document.getElementById("drawOverlay");
  drawTextInputEl = document.getElementById("drawTextInput");
  if (!drawChartEl) return;

  drawChartEl.addEventListener("mousedown", onChartMouseDown, true);
  drawChartEl.addEventListener("dblclick", onChartDblClick, true);
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);
  window.addEventListener("keydown", onDrawKeyDown);

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
