/* 回测练习 */

const LOAD_THRESHOLD = 200;
const SPEEDS = [1, 2, 4, 8];
/** 各周期回放统一墙钟节奏（@1x ≈ 300ms/根），与 K 线真实时长无关 */
const PLAYBACK_BAR_MS = 300;
const DRAG_HIT_PX = 18;
const LOTS = 0.01;
const PRACTICE_STORAGE_KEY = "replay_practice_v1";
const ORDER_RECORDS_STORAGE_KEY = "replay_order_records_v1";

let practiceSaveTimer = null;
let orderRecordsSaveTimer = null;
const barsTfCache = new Map();
const BARS_CACHE_MAX = 32;
let replayTfPrefetchTimer = null;
let prefetchAbortSeq = 0;
let prefetchInFlight = 0;
const PREFETCH_MAX_CONCURRENT = 1;
const state = {
  config: null,
  allBars: [],
  cursor: 0,
  replayMode: false,
  replayUntilTime: null,
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
  restoringTfView: false,
  selectedOrderId: null,
  barInfoBar: null,
  /** 各周期独立视野：logicalFrom/To + barSpacing；跨周期首次进入用 timeFrom/To */
  tfViews: {},
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
  if (typeof renderPatternDock === "function") renderPatternDock();
  if ($("btnPlay")) $("btnPlay").textContent = state.playing ? t("btn.pause") : t("btn.play");
  if ($("btnSpeed")) $("btnSpeed").textContent = `${state.speed}x`;
  if (!state.loading && $("btnJump")) $("btnJump").textContent = t("btn.jump");
  if (!state.loading && $("btnRandomStart"))
    $("btnRandomStart").textContent = t("btn.randomStart");
  updateBarInfoPanel(state.barInfoBar ?? currentBar());
  if (state.chartReady && candleSeries) updateChart({ preserveView: true });
}

window.onLocaleChange = refreshUiLocale;

function fmtTime(ts) {
  if (typeof fmtDisplayTime === "function") return fmtDisplayTime(ts);
  if (!ts) return "—";
  const locale = typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN";
  const d = new Date(ts * 1000);
  const part = d.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  return `${part} ${typeof t === "function" ? t("time.beijing") : "北京时间"}`;
}

function barFromClickParam(param) {
  if (!param?.time) return null;
  const seriesData = param.seriesData?.get?.(candleSeries);
  if (seriesData) {
    return {
      time: param.time,
      open: seriesData.open,
      high: seriesData.high,
      low: seriesData.low,
      close: seriesData.close,
    };
  }
  return state.allBars[findBarIndexByTime(param.time)] || null;
}

function updateBarInfoPanel(bar) {
  const el = $("barInfo");
  if (!el) return;
  state.barInfoBar = bar || null;
  if (!bar) {
    el.textContent = t("barInfo.empty");
    el.className = "bar-info";
    return;
  }
  const up = bar.close >= bar.open;
  el.className = `bar-info bar-${up ? "up" : "down"}`;
  const time = fmtTime(bar.time);
  el.innerHTML = `<span class="bar-time">${time}</span>${t("barInfo.o")} ${bar.open.toFixed(2)}  ${t("barInfo.h")} ${bar.high.toFixed(2)}  ${t("barInfo.l")} ${bar.low.toFixed(2)}  ${t("barInfo.c")} ${bar.close.toFixed(2)}`;
}

function profitUsd(dir, entry, exitPx, lots = LOTS) {
  const mult = lots / 0.01;
  return dir === "buy" ? (exitPx - entry) * mult : (entry - exitPx) * mult;
}

function barDateKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
if (typeof window !== "undefined") window.barDateKey = barDateKey;

/** 回放进度对应的时间落在哪根 K 线上（取 time <= ts 的最后一根） */
function findBarIndexByTime(ts) {
  if (!state.allBars.length) return 0;
  if (ts <= state.allBars[0].time) return 0;
  const last = state.allBars.length - 1;
  if (ts >= state.allBars[last].time) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (state.allBars[mid].time <= ts) lo = mid;
    else hi = mid - 1;
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
  state.barMs = PLAYBACK_BAR_MS;
}

function timeframeBarSeconds(tf = state.timeframe) {
  const found = state.config?.timeframes?.find((x) => x.id === tf);
  if (found?.bar_seconds) return found.bar_seconds;
  const fallback = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "3h": 10800,
    "4h": 14400,
    "1d": 86400,
  };
  return fallback[tf] || 300;
}

function isFineReplayTimeframe(tf = state.timeframe) {
  return tf === "5m" || tf === "1m";
}

function replayUntilForTf(tf = state.timeframe) {
  if (!state.replayMode || state.replayUntilTime == null) return "";
  if (tf === "5m" || tf === "1m") return "";
  return String(state.replayUntilTime);
}

function replayFetchParams() {
  const until = replayUntilForTf();
  return until ? { until } : {};
}

function barsCacheKey(tf, start, end) {
  return `${tf}|${start}|${end}|${replayUntilForTf(tf)}`;
}

function barsCacheGet(tf, start, end) {
  if (!start || !end) return null;
  return barsTfCache.get(barsCacheKey(tf, start, end)) || null;
}

function barsCacheSet(tf, start, end, data) {
  if (!start || !end || !data) return;
  const key = barsCacheKey(tf, start, end);
  if (barsTfCache.size >= BARS_CACHE_MAX) {
    const first = barsTfCache.keys().next().value;
    barsTfCache.delete(first);
  }
  barsTfCache.set(key, data);
}

/** 同一周期+区间只保留当前 until 的缓存，避免回放推进后占满缓存 */
function pruneStaleUntilCache(tf, start, end) {
  const prefix = `${tf}|${start}|${end}|`;
  const keep = barsCacheKey(tf, start, end);
  for (const key of [...barsTfCache.keys()]) {
    if (key.startsWith(prefix) && key !== keep) barsTfCache.delete(key);
  }
}

function clearBarsCache() {
  barsTfCache.clear();
}

async function prefetchBarsTf(tf, start, end, seq = prefetchAbortSeq) {
  if (!start || !end || tf === state.timeframe) return;
  if (seq !== prefetchAbortSeq) return;
  if (barsCacheGet(tf, start, end)) return;
  if (prefetchInFlight >= PREFETCH_MAX_CONCURRENT) return;
  prefetchInFlight += 1;
  try {
    if (seq !== prefetchAbortSeq) return;
    const until = replayUntilForTf(tf);
    const q = { start, end, tf, ...(until ? { until } : {}) };
    const res = await fetch(`${apiUrl("/api/bars")}?${new URLSearchParams(q)}`);
    if (seq !== prefetchAbortSeq || !res.ok) return;
    const data = await res.json();
    if (data.bars?.length) {
      pruneStaleUntilCache(tf, start, end);
      barsCacheSet(tf, start, end, data);
    }
  } catch {
    /* 后台预取，忽略失败 */
  } finally {
    prefetchInFlight = Math.max(0, prefetchInFlight - 1);
  }
}

async function prefetchOtherTimeframes(start, end, activeTf = state.timeframe) {
  if (!start || !end) return;
  const seq = prefetchAbortSeq;
  for (const tf of state.config?.timeframes || []) {
    if (tf.id === activeTf) continue;
    if (seq !== prefetchAbortSeq) return;
    await prefetchBarsTf(tf.id, start, end, seq);
  }
}

function scheduleReplayTfPrefetch() {
  if (!state.replayMode || !state.loadedStart || !state.loadedEnd) return;
  // 播放中不预取，避免占满服务端导致切周期/加载卡住
  if (state.playing) return;
  clearTimeout(replayTfPrefetchTimer);
  replayTfPrefetchTimer = setTimeout(() => {
    void prefetchOtherTimeframes(state.loadedStart, state.loadedEnd, state.timeframe);
  }, 600);
}

/** 回放已揭示到的最后时刻（任意周期播放/步进才更新，切周期不变） */
function recordReplayProgress(time) {
  if (!state.replayMode || time == null) return;
  if (state.replayUntilTime == null || time > state.replayUntilTime) {
    state.replayUntilTime = time;
    scheduleReplayTfPrefetch();
  }
}

function replayProgressBarIndex() {
  if (!state.replayMode || state.replayUntilTime == null || !state.allBars.length) return 0;
  return findBarIndexByTime(state.replayUntilTime);
}

/** 播放中轻量推进一步（不做全量重绘 / 存盘 / 标记刷新） */
function advanceReplayStepLite() {
  const next = state.cursor + 1;
  if (next >= state.allBars.length) return false;
  state.cursor = next;
  const bar = state.allBars[next];
  if (state.replayMode && bar) recordReplayProgress(bar.time);
  $("playTime").textContent = bar ? fmtTime(bar.time) : "—";

  const bars = visibleBarsForChart();
  if (bars.length && candleSeries) {
    candleSeries.update(bars[bars.length - 1]);
    state._chartSeriesLen = bars.length;
  }
  if (state.position && bar) checkPositionOnBar(bar);
  requestAnimationFrame(() => {
    if (typeof renderDrawings === "function") renderDrawings();
    updateRrOverlay();
  });
  return true;
}

/** 回放前进一步 */
function advanceReplayForward(opts = {}) {
  if (!state.allBars.length || state.cursor >= state.allBars.length - 1) return false;
  if (state.playing) {
    return advanceReplayStepLite();
  }
  setCursor(state.cursor + 1, {
    preserveView: opts.preserveView !== false,
    ensureVisible: !!opts.ensureVisible,
  });
  return true;
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
  prefetchAbortSeq += 1;
  clearTimeout(replayTfPrefetchTimer);
  replayTfPrefetchTimer = null;
  captureTimeframeView(state.timeframe);
  const prevTf = state.timeframe;
  const viewTime = state.allBars[state.cursor]?.time ?? null;
  state.timeframe = tf;
  syncPlaybackBarMs();
  updateTimeframeBarActive();
  const rangeStart = state.loadedStart;
  const rangeEnd = state.loadedEnd;
  let data =
    rangeStart && rangeEnd ? barsCacheGet(tf, rangeStart, rangeEnd) : null;
  const fromCache = !!data;
  if (!fromCache) setUiLoading(true, "loading.timeframe");
  try {
    if (!data) {
      if (rangeStart && rangeEnd) {
        data = await fetchBarsQuery({ start: rangeStart, end: rangeEnd });
      } else {
        data = await fetchBarsQuery({
          days: String(state.config.initial_trading_days || 30),
          end: state.config.last_date,
        });
      }
    }
    if (!data.bars?.length) {
      state.timeframe = prevTf;
      syncPlaybackBarMs();
      updateTimeframeBarActive();
      alert(t("alert.noBars"));
      return;
    }
    applyBarsPayload(data, { replace: true });
    state._chartSeriesLen = 0;
    let idx = 0;
    if (state.replayMode) {
      idx = replayProgressBarIndex();
    } else if (viewTime != null) {
      idx = findBarIndexByTime(viewTime);
    } else if (state.allBars.length) {
      idx = state.allBars.length - 1;
    }
    setCursor(idx, {
      skipLoad: true,
      skipBarCheck: !state.position,
      scrollToCursor: false,
      preserveView: false,
      fixStaleRange: false,
      forceSetData: true,
      fitPriceScale: true,
      skipReplayProgress: true,
    });
    requestAnimationFrame(() => {
      scrollChartToCursor();
      requestAnimationFrame(() => {
        scrollChartToCursor();
        fitPriceScaleToVisible();
        syncChartOverlays();
      });
    });
    savePracticeStateNow();
    // 切换完成后再低优先级预取其它周期
    setTimeout(() => {
      if (!state.loading) void prefetchOtherTimeframes(state.loadedStart, state.loadedEnd, tf);
    }, 300);
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
    "btnRandomStart",
    "jumpDate",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = disable;
  });
  setTimeframeBarDisabled(disable);
  if ($("btnJump") && messageKey === "loading.jump") {
    $("btnJump").textContent = loading ? t("loading.jump") : t("btn.jump");
  }
  if ($("btnRandomStart") && messageKey === "loading.random") {
    $("btnRandomStart").textContent = loading ? t("loading.random") : t("btn.randomStart");
  }
}

function setVisibleLogicalRange(from, to) {
  state.suppressRangeLoad = true;
  chart.timeScale().setVisibleLogicalRange({ from, to });
  requestAnimationFrame(() => {
    state.suppressRangeLoad = false;
  });
}

function chartVisibleTimeRange() {
  if (!chart) return null;
  const range = chart.timeScale().getVisibleRange();
  if (!range || range.from == null || range.to == null) return null;
  const from = typeof range.from === "number" ? range.from : null;
  const to = typeof range.to === "number" ? range.to : null;
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function snapshotChartView() {
  if (!state.chartReady || !chart) return null;
  const logical = chart.timeScale().getVisibleLogicalRange();
  if (!logical || logical.to <= logical.from) return null;
  const view = {
    logicalFrom: logical.from,
    logicalTo: logical.to,
    barSpacing: chart.timeScale().options().barSpacing,
  };
  const time = chartVisibleTimeRange();
  if (time) {
    view.timeFrom = time.from;
    view.timeTo = time.to;
  }
  return view;
}

function applyTimeframeView(view) {
  if (!state.chartReady || !chart || !view) return false;
  try {
    if (view.barSpacing != null && Number.isFinite(view.barSpacing)) {
      chart.timeScale().applyOptions({ barSpacing: view.barSpacing });
    }
    if (
      view.logicalFrom != null &&
      view.logicalTo != null &&
      view.logicalTo > view.logicalFrom
    ) {
      chart.timeScale().setVisibleLogicalRange({
        from: view.logicalFrom,
        to: view.logicalTo,
      });
      return true;
    }
    if (view.timeFrom != null && view.timeTo != null && view.timeTo > view.timeFrom) {
      chart.timeScale().setVisibleRange({ from: view.timeFrom, to: view.timeTo });
      return true;
    }
    // 兼容旧存档 { from, to }
    if (view.from != null && view.to != null && view.to > view.from) {
      chart.timeScale().setVisibleRange({ from: view.from, to: view.to });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** setData 后 chart 会异步重置视野，需连续几帧重试 */
function scheduleApplyTimeframeView(view) {
  if (!view) return;
  state.suppressRangeLoad = true;
  state.restoringTfView = true;
  const apply = () => applyTimeframeView(view);
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(() => {
      apply();
      state.suppressRangeLoad = false;
      state.restoringTfView = false;
      updateRrOverlay();
      if (typeof renderDrawings === "function") renderDrawings();
    });
  });
}

function captureTimeframeView(tf = state.timeframe) {
  const view = snapshotChartView();
  if (!view) return;
  state.tfViews[tf] = view;
}

/** 回到某周期用其存档；首次进入则沿用上一周期的时间窗口 */
function resolveTimeframeView(tf, prevTf) {
  const saved = state.tfViews[tf];
  if (saved) return { ...saved };
  const transfer = prevTf ? state.tfViews[prevTf] : null;
  if (!transfer) return null;
  if (transfer.timeFrom != null && transfer.timeTo != null) {
    return {
      timeFrom: transfer.timeFrom,
      timeTo: transfer.timeTo,
      barSpacing: transfer.barSpacing,
    };
  }
  if (transfer.from != null && transfer.to != null) {
    return { timeFrom: transfer.from, timeTo: transfer.to, barSpacing: transfer.barSpacing };
  }
  return null;
}

function restoreTimeframeView(tf = state.timeframe) {
  const saved = state.tfViews[tf];
  if (!saved) return false;
  scheduleApplyTimeframeView(saved);
  return true;
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

/** 切换周期/替换数据后：可见区间超出 series 长度会导致画线坐标失效 */
function fixVisibleRangeIfStale() {
  if (!state.chartReady) return;
  const seriesN = visibleBarsForChart().length;
  if (!seriesN) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) {
    scrollChartToCursor();
    return;
  }
  // 回放时 allBars 含未揭示 K 线，允许视口延伸到右侧以便在未来区域绘图
  const allowMaxLi = state.replayMode
    ? Math.max(seriesN - 1, state.allBars.length - 1)
    : seriesN - 1;
  if (range.from >= state.allBars.length) {
    scrollChartToCursor();
    return;
  }
  if (range.to > allowMaxLi + 1) {
    setVisibleLogicalRange(
      Math.max(0, range.from),
      Math.max(range.from + 2, Math.min(range.to, allowMaxLi + 1))
    );
  }
}

/** 原样恢复缩放/平移（播放时保持用户当前视野，不随光标 clamp） */
function restoreVisibleLogicalRange(saved) {
  if (!saved || !Number.isFinite(saved.from) || !Number.isFinite(saved.to)) return;
  if (saved.to <= saved.from) return;
  setVisibleLogicalRange(saved.from, saved.to);
}

function syncChartOverlays() {
  if (typeof renderDrawings === "function") renderDrawings();
  updateRrOverlay();
}

function scheduleChartViewSync() {
  requestAnimationFrame(() => {
    syncChartOverlays();
  });
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
    normalizeOrderRecord(rec);
    if (!rec.chartVisible) continue;
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

function fitPriceScaleToVisible() {
  if (!state.chartReady || !chart) return;
  try {
    chart.priceScale("right").applyOptions({ autoScale: true });
  } catch (_) {
    /* ignore */
  }
}

function updateChart(opts = {}) {
  if (!state.chartReady || !candleSeries) return;
  const lite = !!opts.lite;
  const bars = visibleBarsForChart();
  const savedRange =
    opts.preserveView && chart ? chart.timeScale().getVisibleLogicalRange() : null;

  if (!bars.length) {
    candleSeries.setData([]);
    candleSeries.setMarkers([]);
    state._chartSeriesLen = 0;
    return;
  }

  const lenChanged = state._chartSeriesLen !== bars.length;
  const replayStep =
    state.replayMode &&
    lenChanged &&
    bars.length === state._chartSeriesLen + 1 &&
    !opts.forceSetData;

  if (replayStep && bars.length > 0) {
    candleSeries.update(bars[bars.length - 1]);
    state._chartSeriesLen = bars.length;
  } else if (lenChanged || opts.forceSetData) {
    if (opts.fitPriceScale) fitPriceScaleToVisible();
    candleSeries.setData(bars);
    state._chartSeriesLen = bars.length;
  } else {
    candleSeries.update(bars[bars.length - 1]);
  }
  candleSeries.setMarkers(buildChartMarkers());
  refreshPositionLines();

  if (opts.fixStaleRange) fixVisibleRangeIfStale();

  if (opts.restoreTimeView) {
    scheduleApplyTimeframeView(opts.restoreTimeView);
  } else if (opts.scrollToCursor) {
    scrollChartToCursor();
  } else if (!replayStep && opts.preserveView && savedRange) {
    const shift = opts.logicalRangeShift || 0;
    restoreVisibleLogicalRange({
      from: savedRange.from + shift,
      to: savedRange.to + shift,
    });
  }
  if (opts.ensureVisible) ensureCursorInView();
  if (!lite) {
    updateRrOverlay();
    if (typeof renderDrawings === "function") renderDrawings();
  }
}

function setCursor(idx, opts = {}) {
  const max = Math.max(0, state.allBars.length - 1);
  const prevCursor = state.cursor;
  state.cursor = Math.max(0, Math.min(idx, max));
  const bar = currentBar();
  if (!opts.skipReplayProgress && state.replayMode && bar) {
    if (state.cursor > prevCursor) {
      recordReplayProgress(bar.time);
    } else if (state.cursor < prevCursor) {
      state.replayUntilTime = bar.time;
    }
  }
  $("playTime").textContent = bar ? fmtTime(bar.time) : "—";
  updateBarInfoPanel(bar);
  if (state.position) {
    updatePositionExcursion();
    updatePositionInfoPanel();
  }
  const scrollToCursor = !!opts.scrollToCursor;
  updateChart({
    scrollToCursor,
    ensureVisible: !!opts.ensureVisible,
    preserveView: opts.preserveView ?? !scrollToCursor,
    fixStaleRange: !!opts.fixStaleRange,
    forceSetData: !!opts.forceSetData,
    fitPriceScale: !!opts.fitPriceScale,
    logicalRangeShift: opts.logicalRangeShift || 0,
  });
  if (!opts.skipBarCheck) checkPositionOnBar(bar);
  if (!opts.skipLoad && state.cursor <= LOAD_THRESHOLD) loadMoreBefore();
  if (!opts.skipSave && !state.playing) scheduleSavePracticeState();
}

async function goToLatest() {
  pause();
  state.replayMode = false;
  state.replayUntilTime = null;
  setCursor(state.allBars.length - 1, {
    skipLoad: true,
    scrollToCursor: true,
    skipReplayProgress: true,
  });
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
  const startTime = trade.open_ts;
  const endTime = tradeEndTime(trade);
  let left = chartTimeToX(startTime);
  let right = chartTimeToX(endTime);
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

function floatBandAlpha(entry, mark, refDist) {
  const dist = Math.abs(mark - entry);
  const ref = Math.max(refDist, 0.5);
  return 0.14 + 0.22 * Math.min(1, dist / ref);
}

function barsSinceOpen(pos) {
  if (!pos?.openTime) return [];
  const openIdx = findBarIndexByTime(pos.openTime);
  const endIdx = state.cursor;
  if (openIdx < 0 || openIdx > endIdx) return [];
  return state.allBars.slice(openIdx, endIdx + 1);
}

/** MFE/MAE in price points (not USD, not × lots). */
function computeExcursionFromBars(pos, bars) {
  let mfe = 0;
  let mae = 0;
  const entry = pos.entry;
  for (const bar of bars) {
    let favorable;
    let adverse;
    if (pos.direction === "buy") {
      favorable = bar.high - entry;
      adverse = bar.low - entry;
    } else {
      favorable = entry - bar.low;
      adverse = entry - bar.high;
    }
    if (favorable > mfe) mfe = favorable;
    if (adverse < mae) mae = adverse;
  }
  return {
    mfe: Math.round(mfe * 100) / 100,
    mae: Math.round(mae * 100) / 100,
  };
}

function updatePositionExcursion() {
  const pos = state.position;
  if (!pos) return;
  const bars = barsSinceOpen(pos);
  if (!bars.length) {
    pos.maxFloatProfit = pos.maxFloatProfit ?? 0;
    pos.maxFloatLoss = pos.maxFloatLoss ?? 0;
    return;
  }
  const { mfe, mae } = computeExcursionFromBars(pos, bars);
  pos.maxFloatProfit = mfe;
  pos.maxFloatLoss = mae;
}

function formatExcursionLine(mfe, mae) {
  return `${t("rr.maxFloatProfit")} ${fmtPtsSigned(mfe)} · ${t("rr.maxFloatLoss")} ${fmtPtsMae(mae)}`;
}

function priceForPnlUsd(trade, pnlUsd) {
  const mult = (trade.lots ?? LOTS) / 0.01;
  if (trade.direction === "buy") return trade.entry + pnlUsd / mult;
  return trade.entry - pnlUsd / mult;
}

function applyFloatBand(el, entry, mark, refDist, kind, alphaScale = 1) {
  if (!el || mark == null) return;
  const a = floatBandAlpha(entry, mark, refDist) * alphaScale;
  el.classList.remove("rr-float-profit", "rr-float-loss");
  el.classList.add(kind === "profit" ? "rr-float-profit" : "rr-float-loss");
  if (kind === "profit") {
    el.style.background = `rgba(61, 214, 140, ${a})`;
    el.style.borderColor = `rgba(61, 214, 140, ${Math.min(0.45, a + 0.1)})`;
  } else {
    el.style.background = `rgba(240, 113, 120, ${a})`;
    el.style.borderColor = `rgba(240, 113, 120, ${Math.min(0.45, a + 0.1)})`;
  }
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

function placeRrHitArea(hitEl, box, entryY, sl, tp) {
  if (!hitEl || entryY == null) {
    if (hitEl) placeRrEl(hitEl, box, 0, 0, false);
    return;
  }
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
}

function sanitizeSlTpLevel(direction, entry, level, kind) {
  if (level == null || !Number.isFinite(level) || !(level > 0)) return null;
  if (entry == null || !Number.isFinite(entry)) return null;
  if (Math.abs(level - entry) < 0.005) return null;
  const dir = String(direction || "").toLowerCase();
  if (dir === "buy") {
    if (kind === "sl" && !(level < entry)) return null;
    if (kind === "tp" && !(level > entry)) return null;
  } else if (dir === "sell") {
    if (kind === "sl" && !(level > entry)) return null;
    if (kind === "tp" && !(level < entry)) return null;
  }
  return level;
}

/** Chart display SL/TP: drop wrong-side broker levels; for closed trades fill from close if needed. */
function resolveDisplaySlTp(trade) {
  let sl = sanitizeSlTpLevel(trade.direction, trade.entry, trade.sl, "sl");
  let tp = sanitizeSlTpLevel(trade.direction, trade.entry, trade.tp, "tp");
  if (trade.active) return { sl, tp };

  const close = trade.close;
  if (
    close == null ||
    !Number.isFinite(close) ||
    trade.entry == null ||
    !Number.isFinite(trade.entry) ||
    Math.abs(close - trade.entry) < 0.005
  ) {
    return { sl, tp };
  }
  const dir = String(trade.direction || "").toLowerCase();
  const favorable = dir === "buy" ? close > trade.entry : close < trade.entry;
  if (favorable) {
    if (tp == null) tp = close;
  } else if (sl == null) {
    sl = close;
  }
  return { sl, tp };
}

function effectiveSlTp(trade) {
  let { sl, tp } = resolveDisplaySlTp(trade);
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
    max_float_profit: pos.maxFloatProfit ?? 0,
    max_float_loss: pos.maxFloatLoss ?? 0,
  };
}

function collectRrTrades() {
  const closed = [...state.orderRecords]
    .reverse()
    .filter((r) => normalizeOrderRecord(r).chartVisible);
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
    max_float_profit: r.max_float_profit ?? 0,
    max_float_loss: r.max_float_loss ?? 0,
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
    <div class="rr-zone rr-float-band"></div>
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
  wrap.classList.toggle(
    "rr-labels-pinned",
    trade.active && !!state.drag
  );
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
  const floatBandEl = wrap.querySelector(".rr-float-band");
  const entryLine = wrap.querySelector(".rr-entry-line");
  const hTp = wrap.querySelector(".rr-handle-tp");
  const hSl = wrap.querySelector(".rr-handle-sl");
  const hEntry = wrap.querySelector(".rr-handle-entry");
  const lTp = wrap.querySelector(".rr-label-tp");
  const lSl = wrap.querySelector(".rr-label-sl");
  const lEntry = wrap.querySelector(".rr-label-entry");

  placeRrLine(entryLine, box, entryY);

  placeRrHitArea(hitEl, box, entryY, sl, tp);

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

  const mfe = trade.max_float_profit ?? 0;
  const mae = trade.max_float_loss ?? 0;
  const excursionLine = formatExcursionLine(mfe, mae);

  if (trade.active) {
    const bar = currentBar();
    const markPx = bar ? bar.close : trade.entry;
    const markY = priceToY(markPx);
    const floatPnl = profitUsd(trade.direction, trade.entry, markPx, trade.lots);
    const fsign = floatPnl >= 0 ? "+" : "";

    if (floatBandEl && markY != null) {
      if (floatPnl > 0.005) {
        const rect = zoneRect(entryY, markY);
        placeRrEl(floatBandEl, box, rect.top, rect.height, true);
        applyFloatBand(floatBandEl, trade.entry, markPx, refDist, "profit");
      } else if (floatPnl < -0.005) {
        const rect = zoneRect(entryY, markY);
        placeRrEl(floatBandEl, box, rect.top, rect.height, true);
        applyFloatBand(floatBandEl, trade.entry, markPx, refDist, "loss");
      } else {
        placeRrEl(floatBandEl, box, 0, 0, false);
      }
    }

    let entryHint = `${dirLabel} ${trade.entry.toFixed(2)} · ${t("rr.float")} ${fsign}${floatPnl.toFixed(2)}`;
    if (needBranch && state.drag !== "branch") entryHint += ` · ${t("rr.dragHint")}`;
    placeRrLabel(
      lEntry,
      box,
      entryY,
      `${entryHint}<br><span class="rr-sub">${excursionLine}<br>${t("rr.riskReward")} ${rr}</span>`
    );
    placeRrHandle(hEntry, box, entryY, needBranch);
  } else {
    // Closed: shade entry→close path; MFE (points) as light favorable band when larger than close move
    const closePx = trade.close;
    const net =
      trade.net ?? profitUsd(trade.direction, trade.entry, closePx, trade.lots);
    let showedFloat = false;
    if (closePx != null && Number.isFinite(closePx) && Math.abs(closePx - trade.entry) >= 0.005) {
      const closeY = priceToY(closePx);
      if (closeY != null) {
        const rect = zoneRect(entryY, closeY);
        placeRrEl(floatBandEl, box, rect.top, rect.height, true);
        applyFloatBand(
          floatBandEl,
          trade.entry,
          closePx,
          refDist,
          net >= 0 ? "profit" : "loss",
          0.9
        );
        showedFloat = true;
      }
    }
    if (!showedFloat) placeRrEl(floatBandEl, box, 0, 0, false);

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
      `#${trade.id} ${dirLabel} ${trade.entry.toFixed(2)} · ${exitLabel} ${nsign}${net.toFixed(2)}<br><span class="rr-sub">${excursionLine}<br>${t("rr.riskReward")} ${rr}</span>`
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

  const mfe = pos.maxFloatProfit ?? 0;
  const mae = pos.maxFloatLoss ?? 0;
  el.className = `position-info ${pos.direction}`;
  el.innerHTML = `
    <span class="${fcls}">${t("position.float")} ${fsign}${floatPnl.toFixed(2)}</span>
    <span class="pos-sep">·</span>
    <span>${t("position.rr")} ${rr}</span>
    <span class="pos-sep">·</span>
    <span class="position-excursion">${formatExcursionLine(mfe, mae)}</span>
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

function interpolateChartTimeToX(t0, x0, t1, x1, time) {
  if (x0 == null || x1 == null || !Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  if (t1 === t0) return x0;
  return x0 + ((time - t0) / (t1 - t0)) * (x1 - x0);
}

/** 时间 → 屏幕 X（精确 bar 用 API，否则在相邻 K 线间插值） */
function chartTimeToX(time) {
  if (!chart || time == null) return null;
  const ts = chart.timeScale();
  const direct = ts.timeToCoordinate(time);
  if (direct != null && Number.isFinite(direct)) return direct;

  const series = visibleBarsForChart();
  const n = series.length;
  if (!n) return null;
  const xAt = (t) => ts.timeToCoordinate(t);
  if (n === 1) return xAt(series[0].time);

  const first = series[0].time;
  const last = series[n - 1].time;
  if (time <= first) {
    return interpolateChartTimeToX(first, xAt(first), series[1].time, xAt(series[1].time), time);
  }
  if (time >= last) {
    return interpolateChartTimeToX(
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
  return interpolateChartTimeToX(
    series[lo].time,
    xAt(series[lo].time),
    series[hiIdx].time,
    xAt(series[hiIdx].time),
    time
  );
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
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: false },
    rightPriceScale: { borderColor: "#2a3140" },
    localization: {
      locale: typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN",
      timeFormatter: (time) => {
        const ts = typeof time === "number" ? time : time?.timestamp ?? time;
        if (typeof fmtDisplayTime === "function") {
          return fmtDisplayTime(ts, { withZone: false });
        }
        return fmtTime(ts);
      },
    },
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
    syncChartOverlays();
  }).observe(chartEl);

  initDrawings(chart, candleSeries, chartEl, {
    onToolChange: (tool) => lockChartPan(tool !== "cursor"),
    getSeriesBars: () => visibleBarsForChart(),
  });

  chart.subscribeClick((param) => {
    if (!param.time || state.drag) return;
    if (typeof isDrawToolActive === "function" && isDrawToolActive()) return;
    if (typeof isDrawEditing === "function" && isDrawEditing()) return;

    const clickedBar = barFromClickParam(param);
    if (clickedBar) updateBarInfoPanel(clickedBar);

    if (state.position) return;
    // 回放模式：点击只查看 K 线信息，不移动光标
    if (state.replayMode) return;
    pause();
    const idx = findBarIndexByTime(param.time);
    setCursor(idx, { ensureVisible: true });
  });

  let rangeTimer = null;
  let tfViewSaveTimer = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    syncChartOverlays();
    if (!range || state.suppressRangeLoad || state.loading || !state.hasMoreBefore) return;
    if (range.from > 80) return;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(() => loadMoreBefore(), 250);
  });
  chart.timeScale().subscribeVisibleTimeRangeChange(() => {
    if (state.suppressRangeLoad || state.restoringTfView || !state.chartReady) return;
    clearTimeout(tfViewSaveTimer);
    tfViewSaveTimer = setTimeout(() => {
      captureTimeframeView(state.timeframe);
      scheduleSavePracticeState();
    }, 300);
  });

  setupDrag();
}

async function fetchBarsQuery(params) {
  const q = { ...params, tf: state.timeframe, ...replayFetchParams() };
  const start = q.start;
  const end = q.end;
  if (start && end) {
    const hit = barsCacheGet(state.timeframe, start, end);
    if (hit) return hit;
  }
  const res = await fetch(`${apiUrl("/api/bars")}?${new URLSearchParams(q)}`);
  if (!res.ok) throw new Error(t("error.loadBars"));
  const data = await res.json();
  if (!data.bars) throw new Error(t("error.restartServer"));
  if (start && end) {
    pruneStaleUntilCache(state.timeframe, start, end);
    barsCacheSet(state.timeframe, start, end, data);
  }
  return data;
}

function applyBarsPayload(data, { replace = false } = {}) {
  const prevLen = state.allBars.length;
  if (replace) {
    state.allBars = data.bars || [];
    state.loadedStart = data.start;
    state.loadedEnd = data.end;
    state._chartSeriesLen = 0;
  } else {
    mergeBars(data.bars || []);
    state.loadedStart = data.start;
  }
  state.hasMoreBefore = inferHasMoreBefore(data);
  if (data.timeframe) state.timeframe = data.timeframe;
  return state.allBars.length - (replace ? 0 : prevLen);
}

function saveOrderRecordsLocal() {
  /* 下单记录已改存服务端磁盘；保留空实现以免旧调用报错 */
}

function loadOrderRecordsLocal() {
  try {
    const raw = localStorage.getItem(ORDER_RECORDS_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.version === 1 ? data : null;
  } catch {
    return null;
  }
}

async function fetchOrderRecordsFromDisk() {
  const res = await fetch(apiUrl("/api/orders"));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.slice(0, 160) || res.statusText || `HTTP ${res.status}`);
  }
  return res.json();
}

async function persistOrderRecordsToDisk(opts = {}) {
  const payload = {
    version: 1,
    orderRecords: state.orderRecords,
    nextOrderId: state.nextOrderId,
  };
  const body = JSON.stringify(payload);
  // keepalive 对 body 大小有限制（约 64KB），导入多笔后会静默失败
  const useKeepalive =
    !!opts.keepalive && new TextEncoder().encode(body).length < 60_000;
  const res = await fetch(apiUrl("/api/orders"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: useKeepalive,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  }
  return res.json();
}

function scheduleSaveOrderRecords() {
  clearTimeout(orderRecordsSaveTimer);
  orderRecordsSaveTimer = setTimeout(() => {
    void persistOrderRecordsToDisk().catch((e) => {
      console.warn("保存下单记录到磁盘失败", e);
    });
  }, 400);
}

function applyOrderRecordsStore(data) {
  if (!data) return;
  state.orderRecords = Array.isArray(data.orderRecords)
    ? data.orderRecords.map((r) => normalizeOrderRecord({ ...r }))
    : [];
  state.nextOrderId =
    typeof data.nextOrderId === "number" && data.nextOrderId > 0
      ? data.nextOrderId
      : state.orderRecords.length + 1;
  syncNextOrderIdFromRecords();
}

/** 磁盘为空时，把 localStorage 里的旧下单记录迁到硬盘 */
async function migrateOrderRecordsToDiskIfNeeded(diskStore) {
  const diskHas = Array.isArray(diskStore?.orderRecords) && diskStore.orderRecords.length > 0;
  if (diskHas) {
    applyOrderRecordsStore(diskStore);
    return { migrated: false };
  }
  const local = loadOrderRecordsLocal();
  const snap = loadPracticeSnapshot();
  const fromLocal = local?.orderRecords?.length
    ? local
    : snap?.orderRecords?.length
      ? { orderRecords: snap.orderRecords, nextOrderId: snap.nextOrderId }
      : null;
  if (!fromLocal) {
    applyOrderRecordsStore(diskStore || { orderRecords: [], nextOrderId: 1 });
    return { migrated: false };
  }
  applyOrderRecordsStore(fromLocal);
  await persistOrderRecordsToDisk();
  try {
    localStorage.removeItem(ORDER_RECORDS_STORAGE_KEY);
  } catch (_) {}
  return { migrated: true };
}

function buildPracticeSnapshot() {
  return {
    version: 1,
    savedAt: Date.now(),
    position: state.position
      ? {
          orderId: state.position.orderId,
          direction: state.position.direction,
          entry: state.position.entry,
          sl: state.position.sl,
          tp: state.position.tp,
          lots: state.position.lots,
          openTime: state.position.openTime,
          maxFloatProfit: state.position.maxFloatProfit ?? 0,
          maxFloatLoss: state.position.maxFloatLoss ?? 0,
        }
      : null,
    cursorTime:
      state.replayMode && state.replayUntilTime != null
        ? state.replayUntilTime
        : state.allBars[state.cursor]?.time ?? null,
    timeframe: state.timeframe,
    replayMode: state.replayMode,
    replayUntilTime: state.replayUntilTime,
    jumpDate: $("jumpDate")?.value || null,
    loadedStart: state.loadedStart,
    loadedEnd: state.loadedEnd,
    configLastDate: state.config?.last_date || null,
    tfViews: state.tfViews,
    drawings: typeof exportDrawingsState === "function" ? exportDrawingsState() : null,
  };
}

function savePracticeState() {
  try {
    localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(buildPracticeSnapshot()));
  } catch (e) {
    console.warn("保存练习数据失败", e);
  }
  scheduleSaveOrderRecords();
}

function scheduleSavePracticeState() {
  clearTimeout(practiceSaveTimer);
  practiceSaveTimer = setTimeout(savePracticeState, 400);
}

function savePracticeStateNow() {
  clearTimeout(practiceSaveTimer);
  clearTimeout(orderRecordsSaveTimer);
  try {
    localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(buildPracticeSnapshot()));
  } catch (e) {
    console.warn("保存练习数据失败", e);
  }
  void persistOrderRecordsToDisk({ keepalive: true }).catch((e) => {
    console.warn("保存下单记录到磁盘失败", e);
  });
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
  if (data.tfViews && typeof data.tfViews === "object") {
    state.tfViews = data.tfViews;
  }
  // 下单记录以磁盘为准，不从练习快照覆盖
  state.position = data.position || null;
  if (state.position) {
    // Recompute from bars as points (snapshot may still hold old USD values).
    state.position.maxFloatProfit = 0;
    state.position.maxFloatLoss = 0;
  }
  if (data.jumpDate && $("jumpDate")) $("jumpDate").value = data.jumpDate;
  if (typeof importDrawingsState === "function") importDrawingsState(data.drawings);
  renderStatement();
  updatePositionInfoPanel();
  refreshPositionLines();

  state.replayMode = !!data.replayMode;
  if (data.replayUntilTime != null) {
    state.replayUntilTime = data.replayUntilTime;
  } else if (state.replayMode && data.cursorTime != null) {
    state.replayUntilTime = data.cursorTime;
  } else if (!state.replayMode) {
    state.replayUntilTime = null;
  }

  let idx = 0;
  if (state.replayMode && state.replayUntilTime != null && state.allBars.length) {
    idx = replayProgressBarIndex();
  } else if (data.cursorTime != null && state.allBars.length) {
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
    scrollToCursor: false,
    skipReplayProgress: true,
    preserveView: true,
  });
  requestAnimationFrame(() => {
    restoreTimeframeView(state.timeframe);
    updateRrOverlay();
    updateChart({ preserveView: true });
  });
}

function setupJumpDateInputs() {
  if (!$("jumpDate") || !state.config) return;
  $("jumpDate").min = state.config.first_date;
  $("jumpDate").max = state.config.last_date;
}

function isStaleBarsSnapshot(saved) {
  if (!saved || saved.replayMode) return false;
  const latest = state.config?.last_date;
  if (!latest) return false;
  if (saved.configLastDate && saved.configLastDate < latest) return true;
  if (saved.loadedEnd && saved.loadedEnd < latest) return true;
  return false;
}

async function loadBarsFromSnapshot(saved) {
  const end = state.config.last_date;
  const days = state.config.initial_trading_days || 30;

  if (isStaleBarsSnapshot(saved)) {
    return fetchBarsQuery({ days: String(days), end });
  }

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

function beginNewPracticeSession() {
  state.orderRecords = [];
  state.nextOrderId = 1;
  state.position = null;
  state.selectedOrderId = null;
  state.drag = null;
  state.tfViews = {};
  clearPositionLines();
  if (typeof clearDrawings === "function") clearDrawings();
  renderStatement();
  renderSessionStats();
  updatePositionInfoPanel();
}

async function resetPracticeData() {
  if (!confirm(t("confirm.reset"))) {
    return;
  }
  localStorage.removeItem(PRACTICE_STORAGE_KEY);
  localStorage.removeItem(ORDER_RECORDS_STORAGE_KEY);
  beginNewPracticeSession();
  state.replayMode = false;
  try {
    await fetch(apiUrl("/api/orders"), { method: "DELETE" });
  } catch (e) {
    console.warn("清除磁盘下单记录失败", e);
  }
  goToLatest();
  savePracticeStateNow();
}

async function loadInitialBars() {
  clearBarsCache();
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
    setCursor(oldCursor + added, {
      skipLoad: true,
      skipBarCheck: true,
      preserveView: true,
      logicalRangeShift: added,
      skipReplayProgress: true,
    });
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

async function jumpToBacktestDate(options = {}) {
  const dateStr = $("jumpDate").value;
  if (!dateStr) {
    alert(t("alert.pickDate"));
    return;
  }
  pause();
  if (!options.skipClosePosition) closePositionSilent();
  setUiLoading(true, options.loadingKey || "loading.jump");
  try {
    clearBarsCache();
    const data = await loadBarsForBacktestFrom(dateStr);
    if (!data.bars?.length) {
      alert(t("alert.noBars"));
      return;
    }
    applyBarsPayload(data, { replace: true });

    const idx = findFirstBarOnDate(dateStr);
    state.replayMode = true;
    state.replayUntilTime = state.allBars[idx]?.time ?? null;
    scheduleReplayTfPrefetch();
    setCursor(idx, {
      skipLoad: true,
      skipBarCheck: true,
      scrollToCursor: false,
      skipReplayProgress: true,
    });
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

async function startRandomBacktest() {
  pause();
  beginNewPracticeSession();
  try {
    const minFwd = state.config?.random_backtest_min_forward_days ?? 10;
    const res = await fetch(
      apiUrl(`/api/random_replay_start?min_forward_days=${encodeURIComponent(minFwd)}`)
    );
    const data = await res.json();
    if (!res.ok) {
      alert(t("alert.randomFailed", { msg: data.error || res.statusText }));
      return;
    }
    if ($("jumpDate")) $("jumpDate").value = data.date;
    await jumpToBacktestDate({ skipClosePosition: true, loadingKey: "loading.random" });
  } catch (e) {
    alert(t("alert.randomFailed", { msg: e.message }));
  }
}

function stepBar(delta) {
  pause();
  if (delta > 0) {
    void advanceReplayForward({ ensureVisible: true });
    return;
  }
  const next = state.cursor + delta;
  if (next < 0) return;
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

function computeOrderPoints(rec) {
  const entry = rec.entry;
  let sl_points = null;
  let tp_points = null;
  if (entry != null && rec.sl != null && Number.isFinite(rec.sl)) {
    sl_points = Math.abs(entry - rec.sl);
  }
  if (entry != null && rec.tp != null && Number.isFinite(rec.tp)) {
    tp_points = Math.abs(rec.tp - entry);
  }
  return {
    sl_points: sl_points != null ? Math.round(sl_points * 100) / 100 : null,
    tp_points: tp_points != null ? Math.round(tp_points * 100) / 100 : null,
  };
}

function orderTagsCatalog() {
  if (typeof patternState === "undefined" || !Array.isArray(patternState.tags)) return [];
  return patternState.tags;
}

function orderTagLabel(id) {
  const found = orderTagsCatalog().find((x) => x.id === id);
  return found?.label || String(id);
}

function normalizeOrderTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeOrderRecord(rec) {
  if (!rec) return rec;
  rec.entry_reason = String(rec.entry_reason ?? "");
  rec.tp_reason = String(rec.tp_reason ?? "");
  rec.sl_reason = String(rec.sl_reason ?? "");
  rec.notes = String(rec.notes ?? "");
  rec.tags = normalizeOrderTags(rec.tags);
  rec.lots = rec.lots ?? LOTS;
  rec.sl = sanitizeSlTpLevel(rec.direction, rec.entry, rec.sl, "sl");
  rec.tp = sanitizeSlTpLevel(rec.direction, rec.entry, rec.tp, "tp");
  rec.max_float_profit = rec.max_float_profit ?? 0;
  rec.max_float_loss = rec.max_float_loss ?? 0;
  rec.is_win = (rec.net ?? 0) > 0;
  if (rec.chartVisible == null) rec.chartVisible = true;
  else rec.chartVisible = !!rec.chartVisible;
  const pts = computeOrderPoints(rec);
  rec.sl_points = pts.sl_points;
  rec.tp_points = pts.tp_points;
  return rec;
}

function parseUtcIsoToUnix(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const iso = /Z$/i.test(t) || /[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function parseOptionalNum(s) {
  if (s == null || String(s).trim() === "") return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function isXauSymbol(sym) {
  const s = String(sym || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return s === "XAUUSD" || s === "XAUUSDM";
}

function mapBrokerCloseReason(reason) {
  const r = String(reason || "")
    .toLowerCase()
    .trim();
  if (r === "sl") return "sl";
  if (r === "tp") return "tp";
  return "manual";
}

/** 解析经纪商成交导出 CSV（ticket / opening_time_utc / …） */
function parseBrokerDealsCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) {
    throw new Error(t("orders.import.empty"));
  }
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const need = [
    "ticket",
    "opening_time_utc",
    "closing_time_utc",
    "type",
    "symbol",
    "opening_price",
    "closing_price",
  ];
  for (const name of need) {
    if (col(name) < 0) {
      throw new Error(t("orders.import.badHeader", { col: name }));
    }
  }

  const records = [];
  let skippedNonXau = 0;
  let skippedBad = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const get = (name) => {
      const j = col(name);
      return j >= 0 ? (cols[j] ?? "").trim() : "";
    };
    if (!isXauSymbol(get("symbol"))) {
      skippedNonXau++;
      continue;
    }
    const id = parseOptionalNum(get("ticket"));
    const openTs = parseUtcIsoToUnix(get("opening_time_utc"));
    const closeTs = parseUtcIsoToUnix(get("closing_time_utc"));
    const type = get("type").toLowerCase();
    const entry = parseOptionalNum(get("opening_price"));
    const close = parseOptionalNum(get("closing_price"));
    if (
      id == null ||
      openTs == null ||
      closeTs == null ||
      (type !== "buy" && type !== "sell") ||
      entry == null ||
      close == null
    ) {
      skippedBad++;
      continue;
    }
    const lots = parseOptionalNum(get("lots")) ?? LOTS;
    const net = parseOptionalNum(get("profit")) ?? 0;
    const rawSl = parseOptionalNum(get("stop_loss"));
    const rawTp = parseOptionalNum(get("take_profit"));
    records.push({
      id,
      entry_reason: "",
      tp_reason: "",
      sl_reason: "",
      notes: "",
      tags: [],
      direction: type,
      open_time: fmtTime(openTs),
      open_ts: openTs,
      close_time: fmtTime(closeTs),
      close_ts: closeTs,
      entry,
      close,
      sl: sanitizeSlTpLevel(type, entry, rawSl, "sl"),
      tp: sanitizeSlTpLevel(type, entry, rawTp, "tp"),
      lots,
      net,
      exit: mapBrokerCloseReason(get("close_reason")),
      max_float_profit: 0,
      max_float_loss: 0,
      screenshot: null,
      chartVisible: false,
      imported: true,
    });
  }

  return { records, skippedNonXau, skippedBad };
}

function syncNextOrderIdFromRecords() {
  let max = 0;
  for (const r of state.orderRecords) {
    const n = Number(r.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (state.nextOrderId <= max) state.nextOrderId = max + 1;
}

function mergeImportedOrderRecords(incoming) {
  const existing = new Set(state.orderRecords.map((r) => String(r.id)));
  let added = 0;
  let skippedDup = 0;
  for (const raw of incoming) {
    if (existing.has(String(raw.id))) {
      skippedDup++;
      continue;
    }
    state.orderRecords.push(normalizeOrderRecord({ ...raw }));
    existing.add(String(raw.id));
    added++;
  }
  state.orderRecords.sort((a, b) => (b.open_ts ?? 0) - (a.open_ts ?? 0));
  syncNextOrderIdFromRecords();
  return { added, skippedDup };
}

function setOrdersImportMsg(msg) {
  const el = $("ordersImportMsg");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

function findBarIndexInBars(bars, ts) {
  if (!bars?.length) return -1;
  if (ts <= bars[0].time) return 0;
  const last = bars.length - 1;
  if (ts >= bars[last].time) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bars[mid].time <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function barsForTradeWindow(bars, openTs, closeTs) {
  if (!bars?.length || openTs == null || closeTs == null) return [];
  const a = Math.min(openTs, closeTs);
  const b = Math.max(openTs, closeTs);
  const openIdx = findBarIndexInBars(bars, a);
  const closeIdx = findBarIndexInBars(bars, b);
  if (openIdx < 0 || closeIdx < openIdx) return [];
  return bars.slice(openIdx, closeIdx + 1);
}

/** 不污染图表缓存；固定用 5m 估算持仓期极值 */
async function fetchBarsForExcursion(startDate, endDate) {
  const q = {
    start: startDate,
    end: endDate,
    tf: "5m",
  };
  const res = await fetch(`${apiUrl("/api/bars")}?${new URLSearchParams(q)}`);
  if (!res.ok) throw new Error(t("error.loadBars"));
  const data = await res.json();
  return Array.isArray(data.bars) ? data.bars : [];
}

function listDateKeysInclusive(startDate, endDate) {
  const out = [];
  let t = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end) || t > end) return out;
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

async function fetchBarsRangeChunked(startDate, endDate) {
  const days = listDateKeysInclusive(startDate, endDate);
  if (!days.length) return [];
  const chunkSize = 45;
  const map = new Map();
  for (let i = 0; i < days.length; i += chunkSize) {
    const slice = days.slice(i, i + chunkSize);
    const bars = await fetchBarsForExcursion(slice[0], slice[slice.length - 1]);
    for (const b of bars) map.set(b.time, b);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function applyExcursionToRecord(rec, bars) {
  const windowBars = barsForTradeWindow(bars, rec.open_ts, rec.close_ts);
  if (!windowBars.length) {
    rec.max_float_profit = rec.max_float_profit ?? 0;
    rec.max_float_loss = rec.max_float_loss ?? 0;
    rec.excursion_ready = true;
    rec.excursion_unit = "points";
    return false;
  }
  const { mfe, mae } = computeExcursionFromBars(
    {
      direction: rec.direction,
      entry: rec.entry,
    },
    windowBars
  );
  rec.max_float_profit = mfe;
  rec.max_float_loss = mae;
  rec.excursion_ready = true;
  rec.excursion_unit = "points";
  return true;
}

function recordsNeedingExcursion(records) {
  return (records || []).filter(
    (r) =>
      r &&
      r.open_ts != null &&
      r.close_ts != null &&
      r.entry != null &&
      r.direction &&
      r.excursion_unit !== "points"
  );
}

async function fillExcursionsForRecords(records) {
  const pending = recordsNeedingExcursion(records);
  if (!pending.length) return { filled: 0 };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const r of pending) {
    minTs = Math.min(minTs, r.open_ts, r.close_ts);
    maxTs = Math.max(maxTs, r.open_ts, r.close_ts);
  }
  const bars = await fetchBarsRangeChunked(barDateKey(minTs), barDateKey(maxTs));
  let filled = 0;
  for (const r of pending) {
    applyExcursionToRecord(r, bars);
    filled += 1;
  }
  return { filled, bars: bars.length };
}

/** Recompute MFE/MAE as price points for records still on old USD/lot units. */
async function migrateExcursionsToPointsIfNeeded() {
  const pending = recordsNeedingExcursion(state.orderRecords);
  if (!pending.length) return;
  try {
    await fillExcursionsForRecords(pending);
    renderStatement();
    updateRrOverlay();
    clearTimeout(orderRecordsSaveTimer);
    await persistOrderRecordsToDisk();
  } catch (e) {
    console.warn("migrate MFE/MAE to points failed", e);
  }
}

async function importOrdersFromFile(file) {
  if (!file) return;
  setOrdersImportMsg("");
  try {
    const text = await file.text();
    const { records, skippedNonXau, skippedBad } = parseBrokerDealsCsv(text);
    const { added, skippedDup } = mergeImportedOrderRecords(records);
    renderStatement();
    updateRrOverlay();
    updateChart({ preserveView: true });

    let excursionMsg = "";
    const pending = recordsNeedingExcursion(state.orderRecords);
    if (pending.length) {
      setOrdersImportMsg(t("orders.import.computingExcursion"));
      try {
        const { filled } = await fillExcursionsForRecords(pending);
        renderStatement();
        excursionMsg = ` · ${t("orders.import.excursionDone", { n: filled })}`;
      } catch (e) {
        console.warn("fill excursions failed", e);
        excursionMsg = ` · ${t("orders.import.excursionFailed", {
          msg: e?.message || e,
        })}`;
      }
    }

    try {
      localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(buildPracticeSnapshot()));
    } catch (e) {
      console.warn("保存练习数据失败", e);
    }
    clearTimeout(orderRecordsSaveTimer);
    await persistOrderRecordsToDisk();
    setOrdersImportMsg(
      t("orders.import.result", {
        added,
        skippedDup,
        skippedNonXau,
        skippedBad,
      }) + excursionMsg
    );
  } catch (e) {
    console.warn("import orders csv failed", e);
    setOrdersImportMsg(e?.message || t("orders.import.failed"));
  }
}

function focusOrderOnChart(rec) {
  if (!rec || !state.allBars.length) return false;
  const ts = Number(rec.open_ts ?? rec.close_ts);
  if (!Number.isFinite(ts)) return false;
  const first = state.allBars[0]?.time;
  const last = state.allBars[state.allBars.length - 1]?.time;
  if (first == null || last == null) return false;
  if (ts < first || ts > last) return false;
  const idx = findBarIndexByTime(ts);
  setCursor(idx, {
    ensureVisible: true,
    scrollToCursor: true,
    skipReplayProgress: true,
    skipBarCheck: true,
  });
  requestAnimationFrame(() => {
    scrollChartToCursor();
    updateRrOverlay();
  });
  return true;
}

/** 若当前未加载该时刻 K 线，则跳到开仓日附近再聚焦 */
async function ensureOrderVisibleOnChart(rec) {
  if (!rec) return;
  const ts = Number(rec.open_ts ?? rec.close_ts);
  if (!Number.isFinite(ts)) return;

  pause();
  const first = state.allBars[0]?.time;
  const last = state.allBars[state.allBars.length - 1]?.time;
  const inRange =
    state.allBars.length > 0 &&
    first != null &&
    last != null &&
    ts >= first &&
    ts <= last;

  if (!inRange) {
    const dateStr = barDateKey(ts);
    if ($("jumpDate")) $("jumpDate").value = dateStr;
    setUiLoading(true, "loading.jump");
    try {
      clearBarsCache();
      const data = await loadBarsForBacktestFrom(dateStr);
      if (!data.bars?.length) {
        alert(t("alert.noBars"));
        return;
      }
      applyBarsPayload(data, { replace: true });
      // 复盘查看历史成交：不进入盲测截断，直接看完整区间
      state.replayMode = false;
      state.replayUntilTime = null;
    } finally {
      setUiLoading(false);
    }
  }

  focusOrderOnChart(rec);
}

function toggleOrderChartVisible(id) {
  const rec = state.orderRecords.find((r) => String(r.id) === String(id));
  if (!rec) return;
  normalizeOrderRecord(rec);
  const alreadyFocused =
    !!rec.chartVisible && String(state.selectedOrderId) === String(rec.id);

  // 再点同一笔：隐藏开单区；点其他笔 / 首次：显示并聚焦到开仓时间
  if (alreadyFocused) {
    rec.chartVisible = false;
    state.selectedOrderId = null;
    renderStatement();
    updateRrOverlay();
    updateChart({ preserveView: true });
    savePracticeStateNow();
    return;
  }

  rec.chartVisible = true;
  state.selectedOrderId = rec.id;
  if (typeof ensureOrderEntryLeftRay === "function") {
    ensureOrderEntryLeftRay(rec);
  }
  renderStatement();
  updateRrOverlay();
  updateChart({ preserveView: true });
  void ensureOrderVisibleOnChart(rec).then(() => savePracticeStateNow());
}

function updateOrderField(id, field, value) {
  const rec = state.orderRecords.find((r) => String(r.id) === String(id));
  if (!rec) return;
  if (
    field === "entry_reason" ||
    field === "tp_reason" ||
    field === "sl_reason" ||
    field === "notes"
  ) {
    rec[field] = String(value ?? "").trim();
  } else {
    return;
  }
  normalizeOrderRecord(rec);
  savePracticeStateNow();
}

function toggleOrderTag(id, tagId, on) {
  const rec = state.orderRecords.find((r) => String(r.id) === String(id));
  const tid = String(tagId ?? "").trim();
  if (!rec || !tid) return;
  const catalogIds = new Set(orderTagsCatalog().map((x) => x.id));
  if (on && !catalogIds.has(tid)) return;
  const set = new Set(normalizeOrderTags(rec.tags));
  if (on) set.add(tid);
  else set.delete(tid);
  // keep catalog order, then any leftover ids
  const ordered = [];
  for (const tg of orderTagsCatalog()) {
    if (set.has(tg.id)) ordered.push(tg.id);
  }
  for (const x of set) {
    if (!ordered.includes(x)) ordered.push(x);
  }
  rec.tags = ordered;
  normalizeOrderRecord(rec);
  const details = document.querySelector(
    `details.stmt-tags[data-order-id="${CSS.escape(String(id))}"]`
  );
  if (details) {
    const summary = details.querySelector(".stmt-tags-summary");
    if (summary) summary.textContent = formatOrderTagsSummary(rec.tags);
  }
  savePracticeStateNow();
}

function formatOrderTagsSummary(tags) {
  const list = normalizeOrderTags(tags);
  if (!list.length) return t("table.tags.none");
  return list.map(orderTagLabel).join(", ");
}

function renderOrderTagsCell(rec) {
  const catalog = orderTagsCatalog();
  if (!catalog.length) {
    return `<div class="stmt-tags-empty muted">${t("table.tags.empty")} <a href="/patterns.html" class="stmt-tags-manage">${t("table.tags.manage")}</a></div>`;
  }
  const selected = new Set(rec.tags || []);
  const options = catalog
    .map((tg) => {
      const checked = selected.has(tg.id) ? " checked" : "";
      return `<label class="stmt-tag-option">
      <input type="checkbox" data-action="order-tag" data-id="${escAttr(String(rec.id))}" data-tag="${escAttr(tg.id)}"${checked} />
      <span>${escAttr(tg.label || tg.id)}</span>
    </label>`;
    })
    .join("");
  return `<details class="stmt-tags" data-order-id="${escAttr(String(rec.id))}">
    <summary class="stmt-tags-summary">${escAttr(formatOrderTagsSummary(rec.tags))}</summary>
    <div class="stmt-tags-menu" role="group" aria-label="${escAttr(t("table.tags"))}">${options}</div>
  </details>`;
}

function screenshotUrl(filename) {
  return apiUrl(`/api/practice/screenshot/${encodeURIComponent(filename)}`);
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.trimStart().startsWith("<")) {
      throw new Error(t("alert.screenshotNeedRestart"));
    }
    throw new Error(text.slice(0, 160) || res.statusText || `HTTP ${res.status}`);
  }
}

function screenshotApiReady() {
  return state.config?.features?.practice_screenshot === true;
}

async function deleteOrderScreenshot(filename) {
  if (!filename) return;
  try {
    await fetch(screenshotUrl(filename), { method: "DELETE" });
  } catch (e) {
    console.warn("delete screenshot failed", e);
  }
}

const SCREENSHOT_PICK_MIN = 24;

function screenshotRenderScale() {
  return Math.max(2, window.devicePixelRatio || 1);
}

/** html2canvas 克隆节点时同步 canvas 位图，避免高 DPI 下图表只显示一半 */
function syncClonedCanvases(origRoot, cloneRoot) {
  if (!origRoot || !cloneRoot) return;
  const origList = origRoot.querySelectorAll("canvas");
  const cloneList = cloneRoot.querySelectorAll("canvas");
  cloneList.forEach((cloneCanvas, i) => {
    const origCanvas = origList[i];
    if (!origCanvas || !cloneCanvas.getContext) return;
    const ctx = cloneCanvas.getContext("2d");
    if (!ctx) return;
    cloneCanvas.width = origCanvas.width;
    cloneCanvas.height = origCanvas.height;
    ctx.drawImage(origCanvas, 0, 0);
  });
}

const screenshotPickState = {
  active: false,
  orderId: null,
  patternMode: false,
  dragging: false,
  startX: 0,
  startY: 0,
  rect: null,
};

function chartAreaEl() {
  return document.querySelector(".chart-area");
}

function screenshotPickEls() {
  return {
    root: $("screenshotPick"),
    box: $("screenshotPickBox"),
    bar: $("screenshotPickBar"),
    hint: $("screenshotPickHint"),
  };
}

function clientToChartAreaPoint(clientX, clientY) {
  const area = chartAreaEl();
  if (!area) return null;
  const b = area.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(clientX - b.left, b.width)),
    y: Math.max(0, Math.min(clientY - b.top, b.height)),
  };
}

function normalizePickRect(x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return { left, top, width, height };
}

function applyScreenshotPickBox(rect) {
  const { box, bar } = screenshotPickEls();
  if (!box) return;
  if (!rect || rect.width < 1 || rect.height < 1) {
    box.classList.remove("visible");
    bar?.classList.add("hidden");
    return;
  }
  box.classList.add("visible");
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function placeScreenshotPickBar(rect) {
  const { bar } = screenshotPickEls();
  if (!bar || !rect) return;
  bar.classList.remove("hidden");
  const barW = 160;
  let left = rect.left + rect.width - barW;
  let top = rect.top + rect.height + 8;
  const area = chartAreaEl();
  if (area) {
    left = Math.max(8, Math.min(left, area.clientWidth - barW - 8));
    if (top + 40 > area.clientHeight) top = Math.max(8, rect.top - 40);
  }
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}

function endScreenshotPick() {
  screenshotPickState.active = false;
  screenshotPickState.orderId = null;
  screenshotPickState.patternMode = false;
  screenshotPickState.dragging = false;
  screenshotPickState.rect = null;
  const { root, box, bar } = screenshotPickEls();
  root?.classList.add("hidden");
  root?.setAttribute("aria-hidden", "true");
  chartAreaEl()?.classList.remove("screenshot-picking");
  box?.classList.remove("visible");
  bar?.classList.add("hidden");
}

function beginScreenshotPick(orderId) {
  if (typeof html2canvas !== "function") {
    alert(t("alert.screenshotFailed", { msg: "html2canvas" }));
    return;
  }
  if (!screenshotApiReady()) {
    alert(t("alert.screenshotNeedRestart"));
    return;
  }
  pause();
  const { root, hint, bar } = screenshotPickEls();
  if (!root) return;
  screenshotPickState.active = true;
  screenshotPickState.orderId = orderId;
  screenshotPickState.dragging = false;
  screenshotPickState.rect = null;
  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");
  chartAreaEl()?.classList.add("screenshot-picking");
  if (hint) hint.textContent = t("screenshot.pickHint");
  bar?.classList.add("hidden");
  applyScreenshotPickBox(null);
}

async function captureChartAreaDataUrl(rect) {
  const area = chartAreaEl();
  if (!area || !rect) throw new Error("chart");
  const renderScale = screenshotRenderScale();
  const canvas = await html2canvas(area, {
    scale: renderScale,
    useCORS: true,
    backgroundColor: "#0f1115",
    logging: false,
    width: area.offsetWidth,
    height: area.offsetHeight,
    onclone: (doc) => {
      syncClonedCanvases(area, doc.querySelector(".chart-area"));
    },
  });
  const scaleX = canvas.width / area.offsetWidth;
  const scaleY = canvas.height / area.offsetHeight;
  const sx = Math.max(0, Math.round(rect.left * scaleX));
  const sy = Math.max(0, Math.round(rect.top * scaleY));
  const sw = Math.min(canvas.width - sx, Math.max(1, Math.round(rect.width * scaleX)));
  const sh = Math.min(canvas.height - sy, Math.max(1, Math.round(rect.height * scaleY)));
  const crop = document.createElement("canvas");
  crop.width = sw;
  crop.height = sh;
  const ctx = crop.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return crop.toDataURL("image/jpeg", 0.92);
}

async function uploadScreenshotRegion(orderId, rect) {
  const dataUrl = await captureChartAreaDataUrl(rect);
  const res = await fetch(apiUrl("/api/practice/screenshot"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId, image: dataUrl }),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(data.error || res.statusText);
  const rec = state.orderRecords.find((r) => String(r.id) === String(orderId));
  if (rec) {
    rec.screenshot = data.filename;
    renderStatement();
    savePracticeStateNow();
  }
}

async function confirmScreenshotPick() {
  const rect = screenshotPickState.rect;
  if (screenshotPickState.patternMode) {
    if (!rect || rect.width < SCREENSHOT_PICK_MIN || rect.height < SCREENSHOT_PICK_MIN) {
      if (rect) alert(t("screenshot.pickTooSmall"));
      return;
    }
    screenshotPickState.patternMode = false;
    endScreenshotPick();
    try {
      await confirmPatternScreenshotPick(rect);
    } catch (e) {
      alert(t("pattern.alert.captureFailed", { msg: e.message }));
    }
    return;
  }
  const orderId = screenshotPickState.orderId;
  if (!rect || orderId == null) {
    endScreenshotPick();
    return;
  }
  if (rect.width < SCREENSHOT_PICK_MIN || rect.height < SCREENSHOT_PICK_MIN) {
    alert(t("screenshot.pickTooSmall"));
    return;
  }
  endScreenshotPick();
  try {
    await uploadScreenshotRegion(orderId, rect);
  } catch (e) {
    alert(t("alert.screenshotFailed", { msg: e.message }));
  }
}

function setupScreenshotPick() {
  const root = $("screenshotPick");
  if (!root) return;

  const onPickDown = (e) => {
    if (!screenshotPickState.active || e.button !== 0) return;
    if (e.target.closest(".screenshot-pick-bar")) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = clientToChartAreaPoint(e.clientX, e.clientY);
    if (!pt) return;
    screenshotPickState.dragging = true;
    screenshotPickState.startX = pt.x;
    screenshotPickState.startY = pt.y;
    screenshotPickState.rect = { left: pt.x, top: pt.y, width: 0, height: 0 };
    $("screenshotPickBar")?.classList.add("hidden");
    applyScreenshotPickBox(screenshotPickState.rect);
  };

  const onPickMove = (e) => {
    if (!screenshotPickState.active || !screenshotPickState.dragging) return;
    const pt = clientToChartAreaPoint(e.clientX, e.clientY);
    if (!pt) return;
    screenshotPickState.rect = normalizePickRect(
      screenshotPickState.startX,
      screenshotPickState.startY,
      pt.x,
      pt.y
    );
    applyScreenshotPickBox(screenshotPickState.rect);
  };

  const onPickUp = (e) => {
    if (!screenshotPickState.active || !screenshotPickState.dragging) return;
    screenshotPickState.dragging = false;
    const pt = clientToChartAreaPoint(e.clientX, e.clientY);
    if (!pt) return;
    const rect = normalizePickRect(
      screenshotPickState.startX,
      screenshotPickState.startY,
      pt.x,
      pt.y
    );
    screenshotPickState.rect = rect;
    if (rect.width < SCREENSHOT_PICK_MIN || rect.height < SCREENSHOT_PICK_MIN) {
      alert(t("screenshot.pickTooSmall"));
      applyScreenshotPickBox(null);
      screenshotPickState.rect = null;
      return;
    }
    applyScreenshotPickBox(rect);
    placeScreenshotPickBar(rect);
  };

  root.addEventListener("mousedown", onPickDown, true);
  window.addEventListener("mousemove", onPickMove);
  window.addEventListener("mouseup", onPickUp);

  $("screenshotPickOk")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void confirmScreenshotPick();
  });
  $("screenshotPickCancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    endScreenshotPick();
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (!screenshotPickState.active) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endScreenshotPick();
      }
    },
    true
  );
}

function beginOrderScreenshot(orderId) {
  beginScreenshotPick(orderId);
}

function openScreenshotPreview(url) {
  const dlg = $("screenshotPreview");
  const img = $("screenshotPreviewImg");
  if (!dlg || !img || !url) return;
  img.removeAttribute("width");
  img.removeAttribute("height");
  img.style.width = "";
  img.style.height = "";
  img.src = url;
  dlg.showModal();
}

function appendOrderRecord(exitPx, reason, bar) {
  const pos = state.position;
  if (!pos || !bar) return;
  const net = profitUsd(pos.direction, pos.entry, exitPx, pos.lots);
  state.orderRecords.unshift(
    normalizeOrderRecord({
      id: pos.orderId,
      entry_reason: "",
      tp_reason: "",
      sl_reason: "",
      notes: "",
      tags: [],
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
      max_float_profit: pos.maxFloatProfit ?? 0,
      max_float_loss: pos.maxFloatLoss ?? 0,
      excursion_unit: "points",
      excursion_ready: true,
      screenshot: null,
      chartVisible: true,
    })
  );
  state.selectedOrderId = pos.orderId;
  renderStatement();
  updateRrOverlay();
  updateChart({ preserveView: true });
  savePracticeStateNow();
}

function closePositionSilent() {
  state.position = null;
  state.drag = null;
  clearPositionLines();
  updateRrOverlay();
  updatePositionInfoPanel();
  updateChart({ preserveView: true });
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
    maxFloatProfit: 0,
    maxFloatLoss: 0,
  };
  refreshPositionLines();
  updatePositionInfoPanel();
  updateChart({ preserveView: true });
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
  syncPlaybackBarMs();
  state.playing = true;
  $("btnPlay").textContent = t("btn.pause");
  state.lastFrame = performance.now();
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  $("btnPlay").textContent = t("btn.play");
  updateChart({ preserveView: true });
  if (typeof renderDrawings === "function") renderDrawings();
  scheduleReplayTfPrefetch();
  scheduleSavePracticeState();
}

function tick(now) {
  if (!state.playing) return;
  if (now - state.lastFrame >= state.barMs / state.speed) {
    state.lastFrame = now;
    if (state.cursor >= state.allBars.length - 1) {
      pause();
      if (state.replayMode) {
        state.replayMode = false;
        state.replayUntilTime = null;
        state._chartSeriesLen = 0;
        updateChart({ preserveView: true, forceSetData: true });
      }
      return;
    }
    advanceReplayForward({ preserveView: true });
  }
  if (state.playing) requestAnimationFrame(tick);
}

function computeSessionStats() {
  if (typeof computeMt5Report !== "function") return null;
  return computeMt5Report(state.orderRecords);
}

function renderSessionStats() {
  /* Session stats strip removed from the statement panel; report page covers KPIs. */
}

async function deleteOrderRecord(id) {
  const rec = state.orderRecords.find((r) => String(r.id) === String(id));
  if (!rec) return;
  if (!confirm(t("confirm.deleteOrder", { id }))) return;
  if (rec.screenshot) await deleteOrderScreenshot(rec.screenshot);
  state.orderRecords = state.orderRecords.filter((r) => String(r.id) !== String(id));
  if (String(state.selectedOrderId) === String(id)) state.selectedOrderId = null;
  renderStatement();
  updateRrOverlay();
  updateChart({ preserveView: true });
  savePracticeStateNow();
}

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function fmtPts(v) {
  return v != null && Number.isFinite(v) ? v.toFixed(2) : "—";
}

function fmtPtsSigned(v) {
  const n = v ?? 0;
  if (!(n > 0.005)) return "0.00";
  return `+${n.toFixed(2)}`;
}

function fmtPtsMae(v) {
  const n = v ?? 0;
  return n < -0.005 ? n.toFixed(2) : "0.00";
}

function fmtLots(v) {
  const n = v != null && Number.isFinite(Number(v)) ? Number(v) : LOTS;
  return Number.isInteger(n) ? String(n) : String(n);
}

function fmtUsdSigned(v) {
  const n = v ?? 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function renderStatement() {
  const body = $("stmtBody");
  body.innerHTML = "";

  state.orderRecords.forEach((r) => {
    normalizeOrderRecord(r);
    const tr = document.createElement("tr");
    tr.dataset.id = String(r.id);
    tr.classList.toggle("stmt-chart-on", !!r.chartVisible);
    tr.title = t(r.chartVisible ? "orders.chart.hideHint" : "orders.chart.showHint");
    const pnlCls = r.net >= 0 ? "pnl-pos" : "pnl-neg";
    const dirCls = r.direction === "buy" ? "buy" : "sell";
    const exitCls = r.exit === "sl" ? "tag-sl" : r.exit === "tp" ? "tag-tp" : "";
    const winCls = r.is_win ? "pnl-pos" : "pnl-neg";
    const mfe = r.max_float_profit ?? 0;
    const mae = r.max_float_loss ?? 0;
    const closePx =
      r.close != null && Number.isFinite(r.close) ? r.close.toFixed(2) : "—";
    const shotCell = r.screenshot
      ? `<img src="${screenshotUrl(r.screenshot)}" class="stmt-shot-thumb" data-action="preview" data-full-src="${screenshotUrl(r.screenshot)}" alt="" />
         <button type="button" class="btn-shot-retake" data-action="screenshot" data-id="${r.id}">${t("table.screenshot.retake")}</button>`
      : `<button type="button" class="btn-shot-capture" data-action="screenshot" data-id="${r.id}">${t("table.screenshot.capture")}</button>`;
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.open_ts != null ? fmtTime(r.open_ts) : r.open_time || "—"}</td>
      <td>${r.close_ts != null ? fmtTime(r.close_ts) : r.close_time || "—"}</td>
      <td class="${dirCls}">${tDir(r.direction)}</td>
      <td class="stmt-readonly">${fmtLots(r.lots)}</td>
      <td class="stmt-readonly">${r.entry != null ? r.entry.toFixed(2) : "—"}</td>
      <td><input type="text" class="stmt-input stmt-text" data-field="entry_reason" data-id="${r.id}" value="${escAttr(r.entry_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
      <td><input type="text" class="stmt-input stmt-text" data-field="tp_reason" data-id="${r.id}" value="${escAttr(r.tp_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
      <td><input type="text" class="stmt-input stmt-text" data-field="sl_reason" data-id="${r.id}" value="${escAttr(r.sl_reason)}" placeholder="${escAttr(t("table.reason.placeholder"))}" /></td>
      <td class="stmt-readonly">${fmtPts(r.sl_points)}</td>
      <td class="stmt-readonly">${fmtPts(r.tp_points)}</td>
      <td class="stmt-readonly pnl-pos">${fmtPtsSigned(mfe)}</td>
      <td class="stmt-readonly pnl-neg">${fmtPtsMae(mae)}</td>
      <td class="${winCls}">${r.is_win ? t("table.win") : t("table.loss")}</td>
      <td class="stmt-screenshot">${shotCell}</td>
      <td class="stmt-readonly">${closePx}</td>
      <td class="${pnlCls}">${r.net >= 0 ? "+" : ""}${(r.net ?? 0).toFixed(2)}</td>
      <td class="${exitCls}">${tExit(r.exit)}</td>
      <td class="stmt-tags-cell">${renderOrderTagsCell(r)}</td>
      <td><input type="text" class="stmt-input stmt-text stmt-notes" data-field="notes" data-id="${r.id}" value="${escAttr(r.notes)}" placeholder="${escAttr(t("table.notes.placeholder"))}" /></td>
      <td class="stmt-actions">
        <button type="button" class="btn-order-del" data-action="delete" data-id="${r.id}" title="${t("orders.delete.title")}" aria-label="${t("orders.delete.title")}">×</button>
      </td>
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
  if (el.id === "drawTextInput" && el.classList.contains("hidden")) return false;
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
  $("btnJump").addEventListener("click", () => jumpToBacktestDate());
  $("btnRandomStart")?.addEventListener("click", startRandomBacktest);
  $("btnResetData")?.addEventListener("click", () => void resetPracticeData());
  $("stmtBody")?.addEventListener("change", (e) => {
    const tagCb = e.target.closest("input[data-action='order-tag']");
    if (tagCb) {
      toggleOrderTag(tagCb.dataset.id, tagCb.dataset.tag, tagCb.checked);
      return;
    }
    const el = e.target.closest("[data-field]");
    if (!el) return;
    const id = el.dataset.id;
    const field = el.dataset.field;
    if (!id || !field) return;
    updateOrderField(id, field, el.value);
  });
  $("stmtBody")?.addEventListener(
    "toggle",
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("stmt-tags")) {
        return;
      }
      const menu = details.querySelector(".stmt-tags-menu");
      if (!menu) return;
      if (!details.open) {
        menu.classList.remove("stmt-tags-menu-fixed", "stmt-tags-menu-up");
        menu.style.left = "";
        menu.style.top = "";
        menu.style.maxHeight = "";
        return;
      }
      document.querySelectorAll("details.stmt-tags[open]").forEach((d) => {
        if (d !== details) d.open = false;
      });
      const rect = details.querySelector(".stmt-tags-summary")?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const edge = 8;
      const preferMax = 240;
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - edge);
      const spaceAbove = Math.max(0, rect.top - gap - edge);
      const openUp = spaceBelow < 140 && spaceAbove > spaceBelow;
      const avail = openUp ? spaceAbove : spaceBelow;
      const maxH = Math.max(96, Math.min(preferMax, avail));
      menu.classList.add("stmt-tags-menu-fixed");
      menu.classList.toggle("stmt-tags-menu-up", openUp);
      menu.style.left = `${Math.round(rect.left)}px`;
      menu.style.maxHeight = `${Math.round(maxH)}px`;
      if (openUp) {
        menu.style.top = `${Math.round(rect.top - gap - maxH)}px`;
      } else {
        menu.style.top = `${Math.round(rect.bottom + gap)}px`;
      }
    },
    true
  );
  $("stmtBody")?.addEventListener(
    "wheel",
    (e) => {
      if (!e.target.closest(".stmt-tags-menu")) return;
      e.stopPropagation();
    },
    { passive: true }
  );
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".stmt-tags")) return;
    document.querySelectorAll("details.stmt-tags[open]").forEach((d) => {
      d.open = false;
    });
  });
  $("stmtBody")?.addEventListener(
    "blur",
    (e) => {
      const el = e.target.closest("input.stmt-text[data-field]");
      if (!el) return;
      const id = el.dataset.id;
      const field = el.dataset.field;
      if (!id || !field) return;
      updateOrderField(id, field, el.value);
    },
    true
  );
  $("stmtBody")?.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-action='delete']");
    if (delBtn) {
      e.preventDefault();
      const id = delBtn.dataset.id;
      if (id) void deleteOrderRecord(id);
      return;
    }
    const shotBtn = e.target.closest("[data-action='screenshot']");
    if (shotBtn) {
      e.preventDefault();
      const id = shotBtn.dataset.id;
      if (id) beginOrderScreenshot(id);
      return;
    }
    const preview = e.target.closest("[data-action='preview']");
    if (preview) {
      openScreenshotPreview(preview.dataset.fullSrc || preview.currentSrc || preview.src);
      return;
    }
    if (e.target.closest(".stmt-tags")) return;
    if (e.target.closest("input, button, a, select, textarea, label")) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    toggleOrderChartVisible(tr.dataset.id);
  });
  $("btnImportOrders")?.addEventListener("click", () => {
    $("ordersImportFile")?.click();
  });
  $("ordersImportFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void importOrdersFromFile(file);
  });
  $("screenshotPreviewClose")?.addEventListener("click", () => {
    $("screenshotPreview")?.close();
  });
  $("screenshotPreview")?.addEventListener("click", (e) => {
    if (e.target === $("screenshotPreview")) $("screenshotPreview").close();
  });
}

async function init() {
  initChart();
  initI18n();
  setupScreenshotPick();
  setupPatternShortcuts();
  bindEvents();
  state.speed = SPEEDS[0];
  $("btnSpeed").textContent = "1x";

  const cfgRes = await fetch(apiUrl("/api/config"));
  state.config = await cfgRes.json();
  state.timeframe = state.config.default_timeframe || "5m";
  syncPlaybackBarMs();

  try {
    const diskOrders = await fetchOrderRecordsFromDisk();
    await migrateOrderRecordsToDiskIfNeeded(diskOrders);
  } catch (e) {
    console.warn("加载磁盘下单记录失败，尝试本地迁移", e);
    await migrateOrderRecordsToDiskIfNeeded(null).catch((err) =>
      console.warn("迁移下单记录失败", err)
    );
  }

  const saved = loadPracticeSnapshot();
  if (saved?.timeframe) {
    state.timeframe = saved.timeframe;
  }
  setupTimeframeBar();
  renderStatement();
  renderSessionStats();
  updatePositionInfoPanel();
  void migrateExcursionsToPointsIfNeeded();

  if (saved) {
    const staleBars = isStaleBarsSnapshot(saved);
    if (saved.replayMode && !staleBars) {
      state.replayMode = true;
      state.replayUntilTime = saved.replayUntilTime ?? saved.cursorTime ?? null;
    }
    setUiLoading(true, staleBars ? "loading.refresh" : "loading.restore");
    try {
      const barData = await loadBarsFromSnapshot(saved);
      if (!barData.bars?.length) {
        await loadInitialBars();
      } else {
        applyBarsPayload(barData, { replace: true });
        setupJumpDateInputs();
        applyPracticeState(saved);
        if (staleBars) {
          state.replayMode = false;
          state.replayUntilTime = null;
          if ($("jumpDate")) $("jumpDate").value = state.config.last_date;
          goToLatest();
        }
        prefetchOtherTimeframes(state.loadedStart, state.loadedEnd);
      }
    } finally {
      setUiLoading(false);
    }
  } else {
    await loadInitialBars();
    prefetchOtherTimeframes(state.loadedStart, state.loadedEnd);
    savePracticeStateNow();
  }
  try {
    await loadPatternTags();
  } catch (e) {
    console.warn("load order tags catalog failed", e);
  }
  await initPatternJournal();
  renderStatement();
  await handlePatternRestoreFromUrl();
  await handleFocusOrderFromUrl();
}

async function handleFocusOrderFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const focusId = params.get("focusOrder");
  if (!focusId) return;
  const clean = new URL(window.location.href);
  clean.searchParams.delete("focusOrder");
  window.history.replaceState({}, "", clean.pathname + clean.search);
  const rec = state.orderRecords.find((r) => String(r.id) === String(focusId));
  if (!rec) return;
  normalizeOrderRecord(rec);
  rec.chartVisible = true;
  state.selectedOrderId = rec.id;
  renderStatement();
  updateRrOverlay();
  updateChart({ preserveView: true });
  await ensureOrderVisibleOnChart(rec);
  savePracticeStateNow();
}

init().catch((e) => {
  console.error(e);
  $("playTime").textContent = t("error.loadFailed", { msg: e.message });
});
