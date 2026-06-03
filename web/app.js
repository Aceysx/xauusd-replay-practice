/* 回测练习 */

const LOAD_THRESHOLD = 200;
const SPEEDS = [1, 2, 4, 8];
const DRAG_HIT_PX = 18;
const LOTS = 0.01;
const PRACTICE_STORAGE_KEY = "replay_practice_v1";

let practiceSaveTimer = null;
const state = {
  config: null,
  allBars: [],
  cursor: 0,
  replayMode: false,
  playing: false,
  speed: 1,
  speedIdx: 0,
  lastFrame: 0,
  barMs: 300,
  timeframe: "5m",
  position: null,
  priceLines: {},
  loadedStart: null,
  loadedEnd: null,
  hasMoreBefore: true,
  loading: false,
  chartReady: false,
  orderRecords: [],
  nextOrderId: 1,
  drag: null,
  dragPrice: null,
  suppressRangeLoad: false,
  selectedOrderId: null,
};

let chart, candleSeries, chartEl;

const API_BASE =
  (typeof window !== "undefined" && window.__API_BASE__) || "";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function $(id) {
  return document.getElementById(id);
}

function tDir(dir) {
  return t(dir === "buy" ? "dir.buy" : "dir.sell");
}

function tExit(reason) {
  if (reason === "sl") return t("exit.sl");
  if (reason === "tp") return t("exit.tp");
  return t("exit.manual");
}

function refreshUiLocale() {
  if (typeof applyI18n === "function") applyI18n();
  updatePositionInfoPanel();
  renderStatement();
  renderSessionStats();
  updateRrOverlay();
  if ($("btnPlay")) $("btnPlay").textContent = state.playing ? t("btn.pause") : t("btn.play");
  if ($("btnSpeed")) $("btnSpeed").textContent = `${state.speed}x`;
  if (!state.loading && $("btnJump")) $("btnJump").textContent = t("btn.jump");
  if (state.chartReady && candleSeries) updateChart();
}

window.onLocaleChange = refreshUiLocale;

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function profitUsd(dir, entry, exitPx, lots = LOTS) {
  const mult = lots / 0.01;
  return dir === "buy" ? (exitPx - entry) * mult : (entry - exitPx) * mult;
}

function barDateKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function findBarIndexByTime(ts) {
  if (!state.allBars.length) return 0;
  let lo = 0,
    hi = state.allBars.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (state.allBars[mid].time < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findFirstBarOnDate(dateStr) {
  const idx = state.allBars.findIndex((b) => barDateKey(b.time) === dateStr);
  return idx >= 0 ? idx : 0;
}

function mergeBars(newBars) {
  const map = new Map(state.allBars.map((b) => [b.time, b]));
  newBars.forEach((b) => map.set(b.time, b));
  state.allBars = [...map.values()].sort((a, b) => a.time - b.time);
}

function currentBar() {
  return state.allBars[state.cursor] || null;
}

function visibleBarsForChart() {
  const end = state.replayMode ? state.cursor + 1 : state.allBars.length;
  return state.allBars.slice(0, Math.max(0, end));
}

function syncPlaybackBarMs() {
  state.barMs = state.config?.bar_ms_per_candle_at_1x || 300;
}

function updateTimeframeBarActive() {
  const bar = $("timeframeBar");
  if (!bar) return;
  bar.querySelectorAll("button[data-tf]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tf === state.timeframe);
  });
}

function setTimeframeBarDisabled(disabled) {
  const bar = $("timeframeBar");
  if (!bar) return;
  bar.querySelectorAll("button[data-tf]").forEach((btn) => {
    btn.disabled = disabled;
  });
}

function setupTimeframeBar() {
  const bar = $("timeframeBar");
  if (!bar || !state.config?.timeframes?.length) return;
  bar.innerHTML = state.config.timeframes
    .map(
      (tf) =>
        `<button type="button" data-tf="${tf.id}" title="${tf.label}">${tf.label}</button>`
    )
    .join("");
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tf]");
    if (!btn || btn.disabled) return;
    const next = btn.dataset.tf;
    if (next === state.timeframe) return;
    switchTimeframe(next);
  });
  updateTimeframeBarActive();
}

async function switchTimeframe(tf) {
  if (tf === state.timeframe) return;
  pause();
  const cursorTime = state.allBars[state.cursor]?.time ?? null;
  const prevTf = state.timeframe;
  state.timeframe = tf;
  syncPlaybackBarMs();
  updateTimeframeBarActive();
  setUiLoading(true, "loading.timeframe");
  try {
    let data;
    if (state.loadedStart && state.loadedEnd) {
      data = await fetchBarsQuery({ start: state.loadedStart, end: state.loadedEnd });
    } else {
      data = await fetchBarsQuery({
        days: String(state.config.initial_trading_days || 30),
        end: state.config.last_date,
      });
    }
    if (!data.bars?.length) {
      state.timeframe = prevTf;
      syncPlaybackBarMs();
      updateTimeframeBarActive();
      alert(t("alert.noBars"));
      return;
    }
    applyBarsPayload(data, { replace: true });
    let idx = 0;
    if (cursorTime != null) idx = findBarIndexByTime(cursorTime);
    else if (state.allBars.length) idx = state.allBars.length - 1;
    setCursor(idx, {
      skipLoad: true,
      skipBarCheck: !state.position,
      scrollToCursor: true,
    });
    savePracticeStateNow();
  } catch (e) {
    state.timeframe = prevTf;
    syncPlaybackBarMs();
    updateTimeframeBarActive();
    throw e;
  } finally {
    setUiLoading(false);
  }
}

function inferHasMoreBefore(data) {
  if (typeof data.has_more_before === "boolean") return data.has_more_before;
  const first = state.config?.first_date;
  if (!first || !state.loadedStart) return true;
  return state.loadedStart > first;
}

function setUiLoading(loading, messageKey = "loading.default") {
  state.loading = loading;
  const overlay = $("chartLoading");
  const box = overlay?.querySelector(".loading-box");
  if (overlay) {
    overlay.classList.toggle("hidden", !loading);
    overlay.setAttribute("aria-hidden", loading ? "false" : "true");
  }
  if (box) box.textContent = t(messageKey);
  const disable = loading;
  [
    "btnBuy",
    "btnSell",
    "btnClosePos",
    "btnStepPrev",
    "btnStepNext",
    "btnPlay",
    "btnSpeed",
    "btnJump",
    "jumpDate",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = disable;
  });
  setTimeframeBarDisabled(disable);
  if ($("btnJump") && messageKey === "loading.jump") {
    $("btnJump").textContent = loading ? t("loading.jump") : t("btn.jump");
  }
}

function setVisibleLogicalRange(from, to) {
  state.suppressRangeLoad = true;
  chart.timeScale().setVisibleLogicalRange({ from, to });
  requestAnimationFrame(() => {
    state.suppressRangeLoad = false;
  });
}

const CHART_VIEW_BARS = 150;

/** 当前光标在图表 series 中的逻辑索引（回放时 series 仅含 0..cursor） */
function cursorLogicalIndex() {
  const bars = visibleBarsForChart();
  if (!bars.length) return 0;
  const t = state.allBars[state.cursor]?.time;
  let idx = bars.findIndex((b) => b.time === t);
  if (idx < 0) idx = bars.length - 1;
  return idx;
}

function centerLogicalRange(centerIdx, spanBars = CHART_VIEW_BARS) {
  const half = Math.floor(spanBars / 2);
  let from = centerIdx - half;
  let to = centerIdx + half;
  if (!state.replayMode) {
    const maxLi = Math.max(0, visibleBarsForChart().length - 1);
    if (from < 0) {
      to -= from;
      from = 0;
    }
    if (to > maxLi) {
      from = Math.max(0, from - (to - maxLi));
      to = maxLi;
    }
  }
  setVisibleLogicalRange(from, to);
}

/** 将当前光标 K 线置于视口水平中间（回放允许左侧留白） */
function scrollChartToCursor() {
  if (!state.chartReady || !visibleBarsForChart().length) return;
  centerLogicalRange(cursorLogicalIndex());
}

function ensureCursorInView() {
  if (!state.chartReady) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  const li = cursorLogicalIndex();
  if (li >= range.from && li <= range.to) return;
  const width = Math.max(CHART_VIEW_BARS, range.to - range.from);
  centerLogicalRange(li, width);
}

function markerVisibleTime(ts) {
  if (ts == null) return false;
  if (!state.replayMode) return true;
  const bar = currentBar();
  if (!bar) return false;
  return ts <= bar.time;
}

function snapBarTime(ts) {
  if (!state.allBars.length || ts == null) return ts;
  return state.allBars[findBarIndexByTime(ts)]?.time ?? ts;
}

function buildChartMarkers() {
  const markers = [];
  const cursorBar = currentBar();

  for (const rec of state.orderRecords) {
    if (!markerVisibleTime(rec.open_ts)) continue;
    const isBuy = rec.direction === "buy";
    markers.push({
      time: snapBarTime(rec.open_ts),
      position: isBuy ? "belowBar" : "aboveBar",
      color: isBuy ? "#3dd68c" : "#f07178",
      shape: isBuy ? "arrowUp" : "arrowDown",
      text: isBuy ? t("marker.openLong") : t("marker.openShort"),
    });
    if (markerVisibleTime(rec.close_ts)) {
      markers.push({
        time: snapBarTime(rec.close_ts),
        position: isBuy ? "aboveBar" : "belowBar",
        color: rec.net >= 0 ? "#3dd68c" : "#f07178",
        shape: isBuy ? "arrowDown" : "arrowUp",
        text:
          rec.exit === "tp"
            ? t("marker.win")
            : rec.exit === "sl"
              ? t("marker.loss")
              : t("marker.flat"),
      });
    }
  }

  const pos = state.position;
  if (pos && markerVisibleTime(pos.openTime)) {
    const isBuy = pos.direction === "buy";
    markers.push({
      time: snapBarTime(pos.openTime),
      position: isBuy ? "belowBar" : "aboveBar",
      color: isBuy ? "#3dd68c" : "#f07178",
      shape: isBuy ? "arrowUp" : "arrowDown",
      text: isBuy ? t("marker.holdLong") : t("marker.holdShort"),
    });
  }

  if (cursorBar && state.replayMode) {
    markers.push({
      time: cursorBar.time,
      position: "aboveBar",
      color: "#5b9cf5",
      shape: "circle",
      text: "▶",
    });
  }

  markers.sort((a, b) => a.time - b.time);
  return markers;
}

function updateChart(opts = {}) {
  if (!state.chartReady || !candleSeries) return;
  const bars = visibleBarsForChart();
  if (!bars.length) {
    candleSeries.setData([]);
    candleSeries.setMarkers([]);
    return;
  }
  candleSeries.setData(bars);
  candleSeries.setMarkers(buildChartMarkers());
  refreshPositionLines();

  if (opts.scrollToCursor) {
    scrollChartToCursor();
  } else if (opts.ensureVisible) {
    ensureCursorInView();
  }
  updateRrOverlay();
  if (typeof renderDrawings === "function") renderDrawings();
}

function setCursor(idx, opts = {}) {
  const max = Math.max(0, state.allBars.length - 1);
  state.cursor = Math.max(0, Math.min(idx, max));
  const bar = currentBar();
  $("playTime").textContent = bar ? fmtTime(bar.time) : "—";
  updateChart({
    scrollToCursor: !!opts.scrollToCursor,
    ensureVisible: !!opts.ensureVisible,
  });
  if (!opts.skipBarCheck) checkPositionOnBar(bar);
  if (!opts.skipLoad && state.cursor <= LOAD_THRESHOLD) loadMoreBefore();
  if (!opts.skipSave) scheduleSavePracticeState();
}

function goToLatest() {
  pause();
  state.replayMode = false;
  setCursor(state.allBars.length - 1, { skipLoad: true, scrollToCursor: true });
}

function removeLine(key) {
  if (state.priceLines[key]) {
    try {
      candleSeries.removePriceLine(state.priceLines[key]);
    } catch (_) {}
    state.priceLines[key] = null;
  }
}

function setLine(key, price, color, title, width = 2, solid = false) {
  removeLine(key);
  state.priceLines[key] = candleSeries.createPriceLine({
    price,
    color,
    lineWidth: width,
    lineStyle: solid
      ? LightweightCharts.LineStyle.Solid
      : LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title,
  });
}

function clearPositionLines() {
  ["simEntry", "simSl", "simTp", "simDrag"].forEach(removeLine);
}

function priceMovePct(from, to) {
  if (!from) return "0.000";
  return ((Math.abs(to - from) / from) * 100).toFixed(3);
}

function tradeEndTime(trade) {
  if (trade.close_ts != null) return trade.close_ts;
  const bar = currentBar();
  return bar?.time ?? trade.open_ts;
}

function rrBoxHorizontal(trade) {
  if (!chart || !state.chartReady) return null;
  const ts = chart.timeScale();
  const startTime = trade.open_ts;
  const endTime = tradeEndTime(trade);
  let left = ts.timeToCoordinate(startTime);
  let right = ts.timeToCoordinate(endTime);
  if (left == null && right == null) return null;
  if (left == null) left = right - 8;
  if (right == null) right = left + 8;
  const x = Math.min(left, right);
  const w = Math.max(10, Math.abs(right - left) + 2);
  return { left: x, width: w, right: x + w };
}

function zoneAlpha(entry, level, refDist, readonly = false) {
  const dist = Math.abs(level - entry);
  const ref = Math.max(refDist, dist, 0.5);
  const base = readonly ? 0.04 : 0.05;
  const span = readonly ? 0.08 : 0.12;
  return base + span * Math.min(1, dist / ref);
}

function applyZoneDepth(el, entry, level, refDist, kind, readonly = false) {
  if (!el || level == null) return;
  const a = zoneAlpha(entry, level, refDist, readonly);
  if (kind === "profit") {
    el.style.background = `rgba(61, 214, 140, ${a})`;
    el.style.borderColor = `rgba(61, 214, 140, ${Math.min(0.35, a + 0.12)})`;
  } else {
    el.style.background = `rgba(240, 113, 120, ${a})`;
    el.style.borderColor = `rgba(240, 113, 120, ${Math.min(0.35, a + 0.12)})`;
  }
}

function placeRrEl(el, box, top, height, visible) {
  if (!el) return;
  if (!visible || height < 1) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.left = `${box.left}px`;
  el.style.width = `${box.width}px`;
  el.style.top = `${top}px`;
  if (height != null) el.style.height = `${height}px`;
}

function placeRrLine(el, box, y) {
  if (!el || y == null) {
    if (el) el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.left = `${box.left}px`;
  el.style.width = `${box.width}px`;
  el.style.top = `${y}px`;
}

function placeRrHandle(el, box, y, visible) {
  if (!el) return;
  if (!visible || y == null) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.style.left = `${box.right}px`;
  el.style.top = `${y}px`;
}

function placeRrLabel(el, box, y, html) {
  if (!el) return;
  if (y == null || !html) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.left = `${box.left + 6}px`;
  el.style.top = `${y}px`;
  el.innerHTML = html;
}

function effectiveSlTp(trade) {
  let sl = trade.sl;
  let tp = trade.tp;
  if (!trade.active) return { sl, tp };
  const preview = state.dragPrice;
  if (state.drag === "sl" && preview != null) sl = preview;
  if (state.drag === "tp" && preview != null) tp = preview;
  if (state.drag === "branch" && preview != null) {
    const minMove = 0.3;
    if (trade.direction === "buy") {
      if (preview < trade.entry - minMove) sl = preview;
      else if (preview > trade.entry + minMove) tp = preview;
    } else {
      if (preview > trade.entry + minMove) sl = preview;
      else if (preview < trade.entry - minMove) tp = preview;
    }
  }
  return { sl, tp };
}

function positionToTrade(pos) {
  return {
    key: "active",
    active: true,
    id: pos.orderId,
    open_ts: pos.openTime,
    close_ts: null,
    entry: pos.entry,
    close: null,
    sl: pos.sl,
    tp: pos.tp,
    direction: pos.direction,
    lots: pos.lots,
    exit: null,
  };
}

function collectRrTrades() {
  const closed = [...state.orderRecords].reverse();
  const list = closed.map((r) => ({
    key: `rec-${r.id}`,
    active: false,
    id: r.id,
    open_ts: r.open_ts,
    close_ts: r.close_ts,
    entry: r.entry,
    close: r.close,
    sl: r.sl,
    tp: r.tp,
    direction: r.direction,
    lots: r.lots ?? LOTS,
    exit: r.exit,
    net: r.net,
  }));
  if (state.position) list.push(positionToTrade(state.position));
  return list;
}

function createRrTradeEl(key) {
  const wrap = document.createElement("div");
  wrap.className = "rr-trade";
  wrap.dataset.key = key;
  wrap.innerHTML = `
    <div class="rr-hit"></div>
    <div class="rr-zone rr-profit"></div>
    <div class="rr-zone rr-loss"></div>
    <div class="rr-entry-line"></div>
    <div class="rr-handle rr-handle-tp" data-drag="tp"></div>
    <div class="rr-handle rr-handle-entry" data-drag="entry"></div>
    <div class="rr-handle rr-handle-sl" data-drag="sl"></div>
    <div class="rr-label rr-label-tp"></div>
    <div class="rr-label rr-label-entry"></div>
    <div class="rr-label rr-label-sl"></div>
  `;
  return wrap;
}

function renderSingleRrTrade(wrap, trade) {
  const box = rrBoxHorizontal(trade);
  const entryY = priceToY(trade.entry);
  if (!box || entryY == null) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  wrap.classList.toggle("rr-readonly", !trade.active);
  wrap.classList.toggle("rr-selected", state.selectedOrderId === trade.id);
  const readonly = !trade.active;

  const { sl, tp } = effectiveSlTp(trade);
  const refDist = Math.max(
    sl != null ? Math.abs(trade.entry - sl) : 0,
    tp != null ? Math.abs(tp - trade.entry) : 0,
    0.5
  );

  const hitEl = wrap.querySelector(".rr-hit");
  const profitEl = wrap.querySelector(".rr-profit");
  const lossEl = wrap.querySelector(".rr-loss");
  const entryLine = wrap.querySelector(".rr-entry-line");
  const hTp = wrap.querySelector(".rr-handle-tp");
  const hSl = wrap.querySelector(".rr-handle-sl");
  const hEntry = wrap.querySelector(".rr-handle-entry");
  const lTp = wrap.querySelector(".rr-label-tp");
  const lSl = wrap.querySelector(".rr-label-sl");
  const lEntry = wrap.querySelector(".rr-label-entry");

  placeRrLine(entryLine, box, entryY);

  if (readonly) {
    const pad = 14;
    let hitTop = entryY - pad;
    let hitBottom = entryY + pad;
    if (tp != null) {
      const y = priceToY(tp);
      if (y != null) {
        hitTop = Math.min(hitTop, y);
        hitBottom = Math.max(hitBottom, y);
      }
    }
    if (sl != null) {
      const y = priceToY(sl);
      if (y != null) {
        hitTop = Math.min(hitTop, y);
        hitBottom = Math.max(hitBottom, y);
      }
    }
    placeRrEl(hitEl, box, hitTop, Math.max(28, hitBottom - hitTop), true);
  } else {
    placeRrEl(hitEl, box, 0, 0, false);
  }

  const isBuy = trade.direction === "buy";
  const needBranch = trade.active && (trade.sl == null || trade.tp == null);
  const showHandles = trade.active;

  if (tp != null) {
    const tpY = priceToY(tp);
    const rect = zoneRect(entryY, tpY);
    placeRrEl(profitEl, box, rect.top, rect.height, true);
    applyZoneDepth(profitEl, trade.entry, tp, refDist, "profit", readonly);
    const tpPnl = pnlAtPrice(trade, tp);
    placeRrLabel(
      lTp,
      box,
      tpY,
      `${t("rr.target")} ${tp.toFixed(2)} (${priceMovePct(trade.entry, tp)}%) · ${tpPnl >= 0 ? "+" : ""}${tpPnl.toFixed(2)} USD`
    );
    placeRrHandle(hTp, box, tpY, showHandles);
  } else {
    placeRrEl(profitEl, box, 0, 0, false);
    placeRrLabel(lTp, box, null, "");
    placeRrHandle(hTp, box, null, false);
  }

  if (sl != null) {
    const slY = priceToY(sl);
    const rect = zoneRect(entryY, slY);
    placeRrEl(lossEl, box, rect.top, rect.height, true);
    applyZoneDepth(lossEl, trade.entry, sl, refDist, "loss", readonly);
    const slPnl = pnlAtPrice(trade, sl);
    placeRrLabel(
      lSl,
      box,
      slY,
      `${t("rr.stop")} ${sl.toFixed(2)} (${priceMovePct(trade.entry, sl)}%) · ${slPnl >= 0 ? "+" : ""}${slPnl.toFixed(2)} USD`
    );
    placeRrHandle(hSl, box, slY, showHandles);
  } else {
    placeRrEl(lossEl, box, 0, 0, false);
    placeRrLabel(lSl, box, null, "");
    placeRrHandle(hSl, box, null, false);
  }

  const { slPts, tpPts } = slTpPoints({ ...trade, sl, tp });
  const rr = riskRewardLabel(slPts, tpPts);
  const dirLabel = isBuy ? t("rr.long") : t("rr.short");

  if (trade.active) {
    const bar = currentBar();
    const markPx = bar ? bar.close : trade.entry;
    const floatPnl = profitUsd(trade.direction, trade.entry, markPx, trade.lots);
    const fsign = floatPnl >= 0 ? "+" : "";
    let entryHint = `${dirLabel} ${trade.entry.toFixed(2)} · ${t("rr.float")} ${fsign}${floatPnl.toFixed(2)}`;
    if (needBranch && state.drag !== "branch") entryHint += ` · ${t("rr.dragHint")}`;
    placeRrLabel(
      lEntry,
      box,
      entryY,
      `${entryHint}<br><span class="rr-sub">${t("rr.riskReward")} ${rr}</span>`
    );
    placeRrHandle(hEntry, box, entryY, needBranch);
  } else {
    const net = trade.net ?? profitUsd(trade.direction, trade.entry, trade.close, trade.lots);
    const nsign = net >= 0 ? "+" : "";
    const exitLabel =
      trade.exit === "sl"
        ? t("rr.exitSl")
        : trade.exit === "tp"
          ? t("rr.exitTp")
          : t("rr.exitManual");
    placeRrLabel(
      lEntry,
      box,
      entryY,
      `#${trade.id} ${dirLabel} ${trade.entry.toFixed(2)} · ${exitLabel} ${nsign}${net.toFixed(2)}<br><span class="rr-sub">${t("rr.riskReward")} ${rr}</span>`
    );
    placeRrHandle(hEntry, box, entryY, false);
    placeRrHandle(hTp, box, tp != null ? priceToY(tp) : null, false);
    placeRrHandle(hSl, box, sl != null ? priceToY(sl) : null, false);
  }
}

function updateRrOverlay() {
  const root = $("rrOverlay");
  if (!root || !state.chartReady) return;

  const trades = collectRrTrades();
  if (!trades.length) {
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = "";
    return;
  }

  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");

  const existing = new Map(
    [...root.querySelectorAll(".rr-trade")].map((el) => [el.dataset.key, el])
  );

  for (const trade of trades) {
    let el = existing.get(trade.key);
    if (!el) {
      el = createRrTradeEl(trade.key);
      root.appendChild(el);
      if (trade.active) bindRrHandlesOnTrade(el);
    }
    renderSingleRrTrade(el, trade);
    existing.delete(trade.key);
  }
  for (const el of existing.values()) el.remove();
}

function zoneRect(y1, y2) {
  const top = Math.min(y1, y2);
  return { top, height: Math.abs(y2 - y1) };
}

function pnlAtPrice(pos, price) {
  return profitUsd(pos.direction, pos.entry, price, pos.lots);
}

function slTpPoints(pos) {
  const slPts =
    pos.sl != null
      ? Math.abs(pos.entry - pos.sl)
      : null;
  const tpPts =
    pos.tp != null
      ? Math.abs(pos.tp - pos.entry)
      : null;
  return { slPts, tpPts };
}

function riskRewardLabel(slPts, tpPts) {
  if (slPts == null || tpPts == null || slPts < 0.01) return "—";
  return `1:${(tpPts / slPts).toFixed(2)}`;
}

function updatePositionInfoPanel() {
  const el = $("positionInfo");
  if (!el) return;
  const pos = state.position;
  if (!pos) {
    el.className = "position-info empty";
    el.textContent = t("position.none");
    return;
  }
  const bar = currentBar();
  const px = bar ? bar.close : pos.entry;
  const floatPnl = profitUsd(pos.direction, pos.entry, px, pos.lots);
  const { slPts, tpPts } = slTpPoints(pos);
  const rr = riskRewardLabel(slPts, tpPts);
  const fcls = floatPnl >= 0 ? "pnl-pos" : "pnl-neg";
  const fsign = floatPnl >= 0 ? "+" : "";

  el.className = `position-info ${pos.direction}`;
  el.innerHTML = `
    <span class="${fcls}">${t("position.float")} ${fsign}${floatPnl.toFixed(2)}</span>
    <span class="pos-sep">·</span>
    <span>${t("position.rr")} ${rr}</span>
  `;
}

function refreshPositionLines() {
  const pos = state.position;
  if (!pos) {
    clearPositionLines();
    updateRrOverlay();
    updatePositionInfoPanel();
    return;
  }

  clearPositionLines();
  if (state.drag === "branch" && state.dragPrice != null) {
    setLine("simDrag", state.dragPrice, "#8b95a8", "", 1);
  } else {
    removeLine("simDrag");
  }

  updateRrOverlay();
  updatePositionInfoPanel();
}

function yToPrice(clientY) {
  const rect = chartEl.getBoundingClientRect();
  const price = candleSeries.coordinateToPrice(clientY - rect.top);
  return price != null && Number.isFinite(price) ? price : null;
}

function priceToY(price) {
  const y = candleSeries.priceToCoordinate(price);
  return y != null ? y : null;
}

function nearestDragTarget(clientY) {
  const pos = state.position;
  if (!pos) return null;

  const rect = chartEl.getBoundingClientRect();
  const yLocal = clientY - rect.top;

  const distTo = (price) => {
    const py = priceToY(price);
    if (py == null) return Infinity;
    return Math.abs(yLocal - py);
  };

  const entryDist = distTo(pos.entry);
  const needBranch = pos.sl == null || pos.tp == null;

  if (needBranch && entryDist < DRAG_HIT_PX + 6) {
    return "entry";
  }

  const slDist = pos.sl != null ? distTo(pos.sl) : Infinity;
  const tpDist = pos.tp != null ? distTo(pos.tp) : Infinity;

  if (slDist < DRAG_HIT_PX && slDist <= tpDist) return "sl";
  if (tpDist < DRAG_HIT_PX) return "tp";
  if (needBranch && entryDist < DRAG_HIT_PX) return "entry";

  return null;
}

function assignSlTpFromBranch(price) {
  const pos = state.position;
  if (!pos || price == null) return;
  const minMove = 0.3;
  if (pos.direction === "buy") {
    if (price < pos.entry - minMove && pos.sl == null) pos.sl = price;
    else if (price > pos.entry + minMove && pos.tp == null) pos.tp = price;
  } else {
    if (price > pos.entry + minMove && pos.sl == null) pos.sl = price;
    else if (price < pos.entry - minMove && pos.tp == null) pos.tp = price;
  }
}

function commitDragPrice(key, price) {
  const pos = state.position;
  if (!pos || price == null) return;
  const minMove = 0.2;
  if (key === "branch") {
    assignSlTpFromBranch(price);
    return;
  }
  if (key === "sl") {
    if (pos.direction === "buy" && price < pos.entry - minMove) pos.sl = price;
    else if (pos.direction === "sell" && price > pos.entry + minMove) pos.sl = price;
  }
  if (key === "tp") {
    if (pos.direction === "buy" && price > pos.entry + minMove) pos.tp = price;
    else if (pos.direction === "sell" && price < pos.entry - minMove) pos.tp = price;
  }
}

function lockChartPan(lock) {
  chart.applyOptions({
    handleScroll: {
      mouseWheel: !lock,
      pressedMouseMove: !lock,
      horzTouchDrag: !lock,
      vertTouchDrag: !lock,
    },
    handleScale: {
      axisPressedMouseMove: !lock,
      mouseWheel: !lock,
      pinch: !lock,
    },
  });
}

function startPositionDrag(target, clientY, e) {
  if (!state.position) return;
  if (target === "entry") {
    state.drag = "branch";
    state.dragPrice = yToPrice(clientY) ?? state.position.entry;
  } else if (target === "sl" || target === "tp") {
    state.drag = target;
    state.dragPrice = target === "sl" ? state.position.sl : state.position.tp;
  } else {
    return;
  }
  lockChartPan(true);
  chartEl.classList.add("dragging");
  e.preventDefault();
  e.stopPropagation();
}

function bindRrHandlesOnTrade(wrap) {
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";
  wrap.querySelectorAll(".rr-handle").forEach((handle) => {
    handle.addEventListener(
      "mousedown",
      (e) => {
        if (!state.position || e.button !== 0) return;
        const kind = handle.dataset.drag;
        if (kind === "sl" && state.position.sl == null) return;
        if (kind === "tp" && state.position.tp == null) return;
        startPositionDrag(kind, e.clientY, e);
      },
      true
    );
  });
}

function setupDrag() {
  chartEl = $("chart");

  chartEl.addEventListener(
    "mousedown",
    (e) => {
      if (!state.position || e.button !== 0) return;
      if (typeof isDrawToolActive === "function" && isDrawToolActive()) return;
      if (typeof isDrawEditing === "function" && isDrawEditing()) return;
      const target = nearestDragTarget(e.clientY);
      if (!target) return;

      startPositionDrag(target, e.clientY, e);
    },
    true
  );

  window.addEventListener("mousemove", (e) => {
    if (!state.drag) return;
    e.preventDefault();
    const p = yToPrice(e.clientY);
    if (p != null) {
      state.dragPrice = p;
      refreshPositionLines();
    }
  });

  window.addEventListener("mouseup", () => {
    if (!state.drag) return;
    commitDragPrice(state.drag, state.dragPrice);
    state.drag = null;
    state.dragPrice = null;
    lockChartPan(false);
    chartEl.classList.remove("dragging");
    refreshPositionLines();
    savePracticeStateNow();
  });
}

function initChart() {
  chartEl = $("chart");
  chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: "#0f1115" }, textColor: "#8b95a8" },
    grid: { vertLines: { color: "#1e2430" }, horzLines: { color: "#1e2430" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: false },
    rightPriceScale: { borderColor: "#2a3140" },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#3dd68c",
    downColor: "#f07178",
    borderVisible: false,
    wickUpColor: "#3dd68c",
    wickDownColor: "#f07178",
  });
  state.chartReady = true;

  new ResizeObserver(() => {
    chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight });
    updateRrOverlay();
    if (typeof renderDrawings === "function") renderDrawings();
  }).observe(chartEl);

  initDrawings(chart, candleSeries, chartEl);

  chart.subscribeClick((param) => {
    if (!param.time || state.drag) return;
    if (typeof isDrawToolActive === "function" && isDrawToolActive()) return;
    if (typeof isDrawEditing === "function" && isDrawEditing()) return;
    if (state.position) return;
    // 回放模式：只用播放/步进推进，点击图表不改变光标（否则会隐藏已揭示的 K 线）
    if (state.replayMode) return;
    pause();
    const idx = findBarIndexByTime(param.time);
    setCursor(idx, { ensureVisible: true });
  });

  let rangeTimer = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    updateRrOverlay();
    if (typeof renderDrawings === "function") renderDrawings();
    if (!range || state.suppressRangeLoad || state.loading || !state.hasMoreBefore) return;
    if (range.from > 80) return;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => loadMoreBefore(), 250);
  });

  setupDrag();
}

async function fetchBarsQuery(params) {
  const q = { ...params, tf: state.timeframe };
  const res = await fetch(`${apiUrl("/api/bars")}?${new URLSearchParams(q)}`);
  if (!res.ok) throw new Error(t("error.loadBars"));
  const data = await res.json();
  if (!data.bars) throw new Error(t("error.restartServer"));
  return data;
}

function applyBarsPayload(data, { replace = false } = {}) {
  const prevLen = state.allBars.length;
  if (replace) {
    state.allBars = data.bars || [];
    state.loadedStart = data.start;
    state.loadedEnd = data.end;
  } else {
    mergeBars(data.bars || []);
    state.loadedStart = data.start;
  }
  state.hasMoreBefore = inferHasMoreBefore(data);
  if (data.timeframe) state.timeframe = data.timeframe;
  return state.allBars.length - (replace ? 0 : prevLen);
}

function buildPracticeSnapshot() {
  return {
    version: 1,
    savedAt: Date.now(),
    orderRecords: state.orderRecords,
    nextOrderId: state.nextOrderId,
    position: state.position
      ? {
          orderId: state.position.orderId,
          direction: state.position.direction,
          entry: state.position.entry,
          sl: state.position.sl,
          tp: state.position.tp,
          lots: state.position.lots,
          openTime: state.position.openTime,
        }
      : null,
    cursorTime: state.allBars[state.cursor]?.time ?? null,
    timeframe: state.timeframe,
    replayMode: state.replayMode,
    jumpDate: $("jumpDate")?.value || null,
    loadedStart: state.loadedStart,
    loadedEnd: state.loadedEnd,
    drawings: typeof exportDrawingsState === "function" ? exportDrawingsState() : null,
  };
}

function savePracticeState() {
  try {
    localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(buildPracticeSnapshot()));
  } catch (e) {
    console.warn("保存练习数据失败", e);
  }
}

function scheduleSavePracticeState() {
  clearTimeout(practiceSaveTimer);
  practiceSaveTimer = setTimeout(savePracticeState, 400);
}

function savePracticeStateNow() {
  clearTimeout(practiceSaveTimer);
  savePracticeState();
}

function loadPracticeSnapshot() {
  try {
    const raw = localStorage.getItem(PRACTICE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.version === 1 ? data : null;
  } catch {
    return null;
  }
}

function findBarIndexExact(ts) {
  const idx = state.allBars.findIndex((b) => b.time === ts);
  return idx >= 0 ? idx : findBarIndexByTime(ts);
}

function applyPracticeState(data) {
  if (!data) return;
  state.orderRecords = Array.isArray(data.orderRecords) ? data.orderRecords : [];
  state.nextOrderId =
    typeof data.nextOrderId === "number"
      ? data.nextOrderId
      : state.orderRecords.length + 1;
  state.position = data.position || null;
  if (data.jumpDate && $("jumpDate")) $("jumpDate").value = data.jumpDate;
  if (typeof importDrawingsState === "function") importDrawingsState(data.drawings);
  renderStatement();
  updatePositionInfoPanel();
  refreshPositionLines();

  state.replayMode = !!data.replayMode;

  let idx = 0;
  if (data.cursorTime != null && state.allBars.length) {
    idx = findBarIndexExact(data.cursorTime);
  } else if (data.replayMode && data.jumpDate) {
    idx = findFirstBarOnDate(data.jumpDate);
  } else if (state.allBars.length) {
    idx = state.allBars.length - 1;
    state.replayMode = false;
  }

  pause();
  setCursor(idx, {
    skipLoad: true,
    skipBarCheck: false,
    skipSave: true,
    scrollToCursor: true,
  });
  requestAnimationFrame(() => {
    scrollChartToCursor();
    updateRrOverlay();
    updateChart();
  });
}

function setupJumpDateInputs() {
  if (!$("jumpDate") || !state.config) return;
  $("jumpDate").min = state.config.first_date;
  $("jumpDate").max = state.config.last_date;
}

async function loadBarsFromSnapshot(saved) {
  const end = state.config.last_date;
  const days = state.config.initial_trading_days || 30;

  if (saved?.replayMode && saved.jumpDate) {
    return loadBarsForBacktestFrom(saved.jumpDate);
  }

  if (saved?.loadedStart && saved?.loadedEnd) {
    const ranged = await fetchBarsQuery({
      start: saved.loadedStart,
      end: saved.loadedEnd,
    });
    if (ranged.bars?.length) return ranged;
  }

  if (saved?.cursorTime) {
    const cursorDate = barDateKey(saved.cursorTime);
    let data = await fetchBarsQuery({ days: String(days), end });
    const firstTs = data.bars?.[0]?.time;
    if (firstTs != null && saved.cursorTime < firstTs) {
      const wider = await fetchBarsQuery({ days: String(days * 2), end: cursorDate });
      if (wider.bars?.length) return wider;
      return loadBarsForBacktestFrom(cursorDate);
    }
    return data;
  }

  return fetchBarsQuery({ days: String(days), end });
}

function resetPracticeData() {
  if (
    !confirm(t("confirm.reset"))
  ) {
    return;
  }
  localStorage.removeItem(PRACTICE_STORAGE_KEY);
  state.orderRecords = [];
  state.nextOrderId = 1;
  state.position = null;
  state.selectedOrderId = null;
  state.replayMode = false;
  state.drag = null;
  clearPositionLines();
  if (typeof clearDrawings === "function") clearDrawings();
  renderStatement();
  goToLatest();
  savePracticeStateNow();
}

async function loadInitialBars() {
  const data = await fetchBarsQuery({
    days: String(state.config.initial_trading_days || 30),
    end: state.config.last_date,
  });
  applyBarsPayload(data, { replace: true });
  setupJumpDateInputs();
  if (!$("jumpDate").value) $("jumpDate").value = state.config.last_date;
  state.replayMode = false;
  goToLatest();
}

async function loadMoreBefore() {
  if (state.loading || !state.hasMoreBefore || !state.loadedStart) return;
  setUiLoading(true, "loading.earlier");
  const oldCursor = state.cursor;
  try {
    const days = state.config.load_chunk_trading_days || 30;
    const data = await fetchBarsQuery({ before: state.loadedStart, days: String(days) });
    if (!data.bars?.length) {
      state.hasMoreBefore = false;
      return;
    }
    const added = applyBarsPayload(data, { replace: false });
    if (added === 0) {
      state.hasMoreBefore = false;
      return;
    }
    setCursor(oldCursor + added, { skipLoad: true, skipBarCheck: true });
    if (state.cursor <= LOAD_THRESHOLD && state.hasMoreBefore) await loadMoreBefore();
  } finally {
    setUiLoading(false);
    savePracticeStateNow();
  }
}

async function loadBarsForBacktestFrom(dateStr) {
  const ctxDays = state.config.initial_trading_days || 30;
  const end = state.config.last_date;

  const ctx = await fetchBarsQuery({ days: String(ctxDays), end: dateStr });
  const forward = await fetchBarsQuery({ start: dateStr, end });

  const map = new Map();
  (ctx.bars || []).forEach((b) => map.set(b.time, b));
  (forward.bars || []).forEach((b) => map.set(b.time, b));
  const bars = [...map.values()].sort((a, b) => a.time - b.time);

  if (!bars.length) {
    const fallback = await fetchBarsQuery({ days: String(ctxDays * 2), end });
    return fallback;
  }

  return {
    bars,
    start: ctx.start || dateStr,
    end: forward.end || end,
    has_more_before: ctx.has_more_before ?? false,
  };
}

async function jumpToBacktestDate() {
  const dateStr = $("jumpDate").value;
  if (!dateStr) {
    alert(t("alert.pickDate"));
    return;
  }
  pause();
  closePositionSilent();
  setUiLoading(true, "loading.jump");
  try {
    const data = await loadBarsForBacktestFrom(dateStr);
    if (!data.bars?.length) {
      alert(t("alert.noBars"));
      return;
    }
    applyBarsPayload(data, { replace: true });

    const idx = findFirstBarOnDate(dateStr);
    state.replayMode = true;
    setCursor(idx, { skipLoad: true, skipBarCheck: true, scrollToCursor: false });
    requestAnimationFrame(() => {
      scrollChartToCursor();
      requestAnimationFrame(() => {
        scrollChartToCursor();
        updateRrOverlay();
        savePracticeStateNow();
      });
    });
  } finally {
    setUiLoading(false);
  }
}

function stepBar(delta) {
  pause();
  const next = state.cursor + delta;
  if (next < 0) return;
  const max = state.allBars.length - 1;
  if (next > max) return;
  if (state.replayMode && delta > 0 && next > max) return;
  setCursor(next, { ensureVisible: true });
}

function checkBarHit(pos, bar) {
  let slHit = false,
    tpHit = false;
  if (pos.sl != null) {
    slHit = pos.direction === "buy" ? bar.low <= pos.sl : bar.high >= pos.sl;
  }
  if (pos.tp != null) {
    tpHit = pos.direction === "buy" ? bar.high >= pos.tp : bar.low <= pos.tp;
  }
  if (slHit && tpHit) return { hit: true, px: pos.sl, reason: "sl" };
  if (slHit) return { hit: true, px: pos.sl, reason: "sl" };
  if (tpHit) return { hit: true, px: pos.tp, reason: "tp" };
  return { hit: false };
}

function appendOrderRecord(exitPx, reason, bar) {
  const pos = state.position;
  if (!pos || !bar) return;
  const net = profitUsd(pos.direction, pos.entry, exitPx, pos.lots);
  state.orderRecords.unshift({
    id: pos.orderId,
    direction: pos.direction,
    open_time: fmtTime(pos.openTime),
    open_ts: pos.openTime,
    close_time: fmtTime(bar.time),
    close_ts: bar.time,
    entry: pos.entry,
    close: exitPx,
    sl: pos.sl,
    tp: pos.tp,
    lots: pos.lots,
    net,
    exit: reason,
  });
  state.selectedOrderId = pos.orderId;
  renderStatement();
  updateRrOverlay();
  updateChart();
  savePracticeStateNow();
}

function closePositionSilent() {
  state.position = null;
  state.drag = null;
  clearPositionLines();
  updateRrOverlay();
  updatePositionInfoPanel();
  updateChart();
}

function closePosition(exitPx, reason, bar) {
  if (!state.position) return;
  appendOrderRecord(exitPx, reason, bar);
  closePositionSilent();
}

function checkPositionOnBar(bar) {
  if (!bar || !state.position) return;
  const hit = checkBarHit(state.position, bar);
  if (hit.hit) closePosition(hit.px, hit.reason, bar);
  else refreshPositionLines();
}

function openPosition(direction) {
  if (state.position) {
    alert(t("alert.closeFirst"));
    return;
  }
  const bar = currentBar();
  if (!bar) return;
  pause();
  state.position = {
    orderId: state.nextOrderId++,
    direction,
    entry: bar.close,
    sl: null,
    tp: null,
    lots: LOTS,
    openTime: bar.time,
  };
  refreshPositionLines();
  updatePositionInfoPanel();
  updateChart();
  savePracticeStateNow();
}

function manualClose() {
  if (!state.position) return;
  const bar = currentBar();
  if (!bar) return;
  closePosition(bar.close, "manual", bar);
}

function cycleSpeed() {
  state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
  state.speed = SPEEDS[state.speedIdx];
  $("btnSpeed").textContent = `${state.speed}x`;
}

function play() {
  if (!state.allBars.length) return;
  state.playing = true;
  $("btnPlay").textContent = t("btn.pause");
  state.lastFrame = performance.now();
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  $("btnPlay").textContent = t("btn.play");
}

function tick(now) {
  if (!state.playing) return;
  if (now - state.lastFrame >= state.barMs / state.speed) {
    state.lastFrame = now;
    if (state.cursor >= state.allBars.length - 1) {
      pause();
      if (state.replayMode) {
        state.replayMode = false;
        updateChart();
      }
      return;
    }
    setCursor(state.cursor + 1, { ensureVisible: true });
  }
  requestAnimationFrame(tick);
}

function computeSessionStats() {
  const records = [...state.orderRecords].reverse();
  if (!records.length) return null;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let maxConsecLoss = 0;
  let consecLoss = 0;
  let rrSum = 0;
  let rrCount = 0;
  const daily = new Map();

  for (const r of records) {
    equity += r.net;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (r.net > 0) {
      wins += 1;
      sumWin += r.net;
      consecLoss = 0;
    } else {
      sumLoss += r.net;
      consecLoss += 1;
      maxConsecLoss = Math.max(maxConsecLoss, consecLoss);
    }
    if (r.sl != null && r.tp != null) {
      const risk = Math.abs(r.entry - r.sl);
      const reward = Math.abs(r.tp - r.entry);
      if (risk >= 0.01) {
        rrSum += reward / risk;
        rrCount += 1;
      }
    }
    const day = barDateKey(r.close_ts);
    daily.set(day, (daily.get(day) || 0) + r.net);
  }

  const n = records.length;
  const losses = n - wins;
  const avgWin = wins ? sumWin / wins : 0;
  const avgLoss = losses ? sumLoss / losses : 0;
  const profitFactor =
    sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0;

  return {
    totalNet: equity,
    n,
    wins,
    winRate: (100 * wins) / n,
    maxDd,
    avgWin,
    avgLoss,
    profitFactor,
    maxConsecLoss,
    avgRr: rrCount ? rrSum / rrCount : null,
    daily: [...daily.entries()].sort((a, b) => b[0].localeCompare(a[0])),
  };
}

function renderSessionStats() {
  const grid = $("sessionStatsGrid");
  if (!grid) return;
  const s = computeSessionStats();
  if (!s) {
    grid.className = "stat-grid empty";
    grid.textContent = t("orders.empty");
    return;
  }
  grid.className = "stat-grid";
  const pnlCls = s.totalNet >= 0 ? "pnl-pos" : "pnl-neg";
  const lossCount = s.n - s.wins;
  const pf =
    s.profitFactor === Infinity
      ? "∞"
      : lossCount === 0 && s.totalNet > 0
        ? "—"
        : s.profitFactor.toFixed(2);
  const rr = s.avgRr != null ? `1:${s.avgRr.toFixed(2)}` : "—";
  const dailyText = s.daily
    .slice(0, 5)
    .map(([d, v]) => `${d} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`)
    .join(" · ");

  grid.innerHTML = `
    <span class="stat-item ${pnlCls}"><strong>${t("stat.totalPnl")}</strong>${s.totalNet >= 0 ? "+" : ""}${s.totalNet.toFixed(2)}</span>
    <span class="stat-item"><strong>${t("stat.trades")}</strong>${s.n}</span>
    <span class="stat-item"><strong>${t("stat.winRate")}</strong>${s.winRate.toFixed(1)}%</span>
    <span class="stat-item"><strong>${t("stat.maxDd")}</strong>${s.maxDd.toFixed(2)}</span>
    <span class="stat-item pnl-pos"><strong>${t("stat.avgWin")}</strong>+${s.avgWin.toFixed(2)}</span>
    <span class="stat-item pnl-neg"><strong>${t("stat.avgLoss")}</strong>${s.avgLoss.toFixed(2)}</span>
    <span class="stat-item"><strong>${t("stat.profitFactor")}</strong>${pf}</span>
    <span class="stat-item"><strong>${t("stat.plannedRr")}</strong>${rr}</span>
    <span class="stat-item"><strong>${t("stat.consecLoss", { n: s.maxConsecLoss })}</strong></span>
    ${dailyText ? `<span class="stat-daily"><strong>${t("stat.daily")}</strong>${dailyText}</span>` : ""}
  `;
}

function renderStatement() {
  const body = $("stmtBody");
  body.innerHTML = "";

  state.orderRecords.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.id = String(r.id);
    const pnlCls = r.net >= 0 ? "pnl-pos" : "pnl-neg";
    const dirCls = r.direction === "buy" ? "buy" : "sell";
    const exitCls = r.exit === "sl" ? "tag-sl" : r.exit === "tp" ? "tag-tp" : "";
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.open_time}</td>
      <td class="${dirCls}">${tDir(r.direction)}</td>
      <td>${r.entry.toFixed(2)}</td>
      <td>${r.close.toFixed(2)}</td>
      <td class="${pnlCls}">${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)}</td>
      <td class="${exitCls}">${tExit(r.exit)}</td>
    `;
    body.appendChild(tr);
  });

  const n = state.orderRecords.length;
  $("stmtCount").textContent = n ? t("orders.count", { n }) : "";
  renderSessionStats();
}

function setupPanelResize() {
  const handle = $("panelResize");
  const panel = $("stmtPanel");
  if (!handle || !panel) return;

  const saved = localStorage.getItem("replay_bottom_panel_h");
  if (saved) {
    const h = parseInt(saved, 10);
    if (h >= 140 && h <= 720) {
      document.documentElement.style.setProperty("--bottom-panel-h", `${h}px`);
    }
  }

  let startY = 0;
  let startH = 0;

  const onMove = (e) => {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = startY - clientY;
    const next = Math.max(140, Math.min(window.innerHeight * 0.75, startH + delta));
    document.documentElement.style.setProperty("--bottom-panel-h", `${next}px`);
    if (chart && chartEl) {
      chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight });
      updateRrOverlay();
    }
  };

  const onUp = () => {
    document.body.classList.remove("resizing-panel");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onUp);
    const h = panel.getBoundingClientRect().height;
    localStorage.setItem("replay_bottom_panel_h", String(Math.round(h)));
  };

  const onDown = (e) => {
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startH = panel.getBoundingClientRect().height;
    document.body.classList.add("resizing-panel");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    e.preventDefault();
  };

  handle.addEventListener("mousedown", onDown);
  handle.addEventListener("touchstart", onDown, { passive: false });
}

function isTypingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function setupKeyboardShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget()) return;
    if (state.loading) return;

    const key = e.key;
    if (key === " " || key === "Spacebar") {
      e.preventDefault();
      if (state.playing) pause();
      else play();
      return;
    }
    if (key === "ArrowLeft") {
      e.preventDefault();
      stepBar(-1);
      return;
    }
    if (key === "ArrowRight") {
      e.preventDefault();
      stepBar(1);
      return;
    }
    if (key === "b" || key === "B") {
      e.preventDefault();
      openPosition("buy");
      return;
    }
    if (key === "s" || key === "S") {
      e.preventDefault();
      openPosition("sell");
      return;
    }
    if (key === "c" || key === "C") {
      e.preventDefault();
      manualClose();
      return;
    }
    if (key === "l" || key === "L") {
      e.preventDefault();
      goToLatest();
    }
  });
}

function bindEvents() {
  setupPanelResize();
  setupKeyboardShortcuts();
  window.addEventListener("beforeunload", savePracticeStateNow);
  $("btnBuy").addEventListener("click", () => openPosition("buy"));
  $("btnSell").addEventListener("click", () => openPosition("sell"));
  $("btnClosePos").addEventListener("click", manualClose);
  $("btnStepPrev").addEventListener("click", () => stepBar(-1));
  $("btnStepNext").addEventListener("click", () => stepBar(1));
  $("btnPlay").addEventListener("click", () => (state.playing ? pause() : play()));
  $("btnSpeed").addEventListener("click", cycleSpeed);
  $("btnJump").addEventListener("click", jumpToBacktestDate);
  $("btnResetData")?.addEventListener("click", resetPracticeData);
}

async function init() {
  initChart();
  initI18n();
  bindEvents();
  state.speed = SPEEDS[0];
  $("btnSpeed").textContent = "1x";

  const cfgRes = await fetch(apiUrl("/api/config"));
  state.config = await cfgRes.json();
  state.timeframe = state.config.default_timeframe || "5m";
  syncPlaybackBarMs();

  const saved = loadPracticeSnapshot();
  if (saved?.timeframe) {
    state.timeframe = saved.timeframe;
  }
  setupTimeframeBar();
  renderStatement();
  renderSessionStats();
  updatePositionInfoPanel();

  if (saved) {
    setUiLoading(true, "loading.restore");
    try {
      const barData = await loadBarsFromSnapshot(saved);
      if (!barData.bars?.length) {
        await loadInitialBars();
      } else {
        applyBarsPayload(barData, { replace: true });
        setupJumpDateInputs();
        applyPracticeState(saved);
      }
    } finally {
      setUiLoading(false);
    }
  } else {
    await loadInitialBars();
    savePracticeStateNow();
  }
}

init().catch((e) => {
  console.error(e);
  $("playTime").textContent = t("error.loadFailed", { msg: e.message });
});
