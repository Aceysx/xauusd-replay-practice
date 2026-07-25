/* 独立交易报告页：/report.html */

(function () {
  "use strict";

  let equityChartApi = null;
  let equityResizeObs = null;
  /** @type {Array} */
  let allRecords = [];
  /** @type {object|null} */
  let lastReport = null;
  let equityPeriod = "day";

  function $(id) {
    return document.getElementById(id);
  }

  function apiUrl(path) {
    const base = typeof window.__API_BASE__ === "string" ? window.__API_BASE__ : "";
    return `${base}${path}`;
  }

  function fmtSigned(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return "—";
    const s = Math.abs(v).toFixed(digits);
    if (v > 0) return `+${s}`;
    if (v < 0) return `-${s}`;
    return (0).toFixed(digits);
  }

  function pnlClass(v) {
    if (v == null || !Number.isFinite(v) || v === 0) return "";
    return v > 0 ? "pnl-pos" : "pnl-neg";
  }

  function fNum(v, digits = 2) {
    if (typeof formatMt5Number === "function") return formatMt5Number(v, digits);
    if (v == null || !Number.isFinite(v)) return "—";
    if (v === Infinity) return "∞";
    return v.toFixed(digits);
  }

  function pct(v) {
    return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(2)}%`;
  }

  function recordTs(r) {
    const t = Number(r?.close_ts ?? r?.open_ts);
    return Number.isFinite(t) ? t : null;
  }

  function tsToDateKey(ts) {
    if (ts == null) return "";
    if (typeof dateKeyInDisplayTz === "function") return dateKeyInDisplayTz(ts);
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  function dateKeyToStartTs(dateStr) {
    if (!dateStr) return null;
    if (typeof dateKeyToStartTsInDisplayTz === "function") {
      return dateKeyToStartTsInDisplayTz(dateStr);
    }
    const ms = Date.parse(`${dateStr}T00:00:00+08:00`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  function dateKeyToEndTs(dateStr) {
    if (!dateStr) return null;
    if (typeof dateKeyToEndTsInDisplayTz === "function") {
      return dateKeyToEndTsInDisplayTz(dateStr);
    }
    const ms = Date.parse(`${dateStr}T23:59:59.999+08:00`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  function destroyEquityChart() {
    if (equityResizeObs) {
      equityResizeObs.disconnect();
      equityResizeObs = null;
    }
    if (equityChartApi) {
      try {
        equityChartApi.remove();
      } catch (_) {}
    }
    equityChartApi = null;
    const el = $("equityChart");
    if (el) el.innerHTML = "";
  }

  function normalizePointTime(t, fallbackPrev) {
    let n = Number(t);
    if (!Number.isFinite(n) || n < 1_000_000_000) {
      n = (fallbackPrev > 0 ? fallbackPrev : 1_700_000_000) + 86400;
    }
    if (n <= fallbackPrev) n = fallbackPrev + 1;
    return n;
  }

  /** 北京时间周期起点（秒） */
  function periodStartTs(ts, mode) {
    const key = tsToDateKey(ts);
    if (!key) return ts;
    const [ys, ms, ds] = key.split("-");
    const y = Number(ys);
    const m = Number(ms);
    const day = Number(ds);
    if (mode === "month") {
      return dateKeyToStartTs(`${ys}-${ms}-01`);
    }
    if (mode === "week") {
      const start = dateKeyToStartTs(key);
      if (start == null) return ts;
      // Monday-based week in Beijing
      const noon = Date.parse(`${key}T12:00:00+08:00`);
      const dow = new Date(noon).getUTCDay(); // 0=Sun
      const offset = (dow + 6) % 7;
      return start - offset * 86400;
    }
    return dateKeyToStartTs(key) ?? ts;
  }

  function buildTradeEquityData(curve) {
    let lastT = 0;
    const data = [];
    for (const p of curve || []) {
      const t = normalizePointTime(p.time, lastT);
      lastT = t;
      data.push({ time: t, value: p.equity });
    }
    return data;
  }

  /** 取每个周期末的累计净值 */
  function aggregateEquityCurve(curve, mode) {
    if (!mode || mode === "trade") return buildTradeEquityData(curve);
    const map = new Map();
    let lastT = 0;
    for (const p of curve || []) {
      const t = normalizePointTime(p.time, lastT);
      lastT = t;
      const key = periodStartTs(t, mode);
      map.set(key, Number(p.equity) || 0);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
  }

  function formatEquityTick(time, mode) {
    const key = tsToDateKey(time);
    if (!key) return "—";
    const [y, m, day] = key.split("-");
    if (mode === "month") return `${y}-${m}`;
    return `${y}-${m}-${day}`;
  }

  function formatEquityCrosshair(time, mode) {
    const zone = typeof t === "function" ? t("time.beijing") : "北京时间";
    if (mode === "month") {
      if (typeof fmtDisplayTime === "function") {
        const s = fmtDisplayTime(time, { withZone: false });
        return s.slice(0, 7);
      }
      return formatEquityTick(time, "month");
    }
    if (mode === "week" || mode === "day") {
      const day = tsToDateKey(time) || "—";
      return mode === "week" ? `${day} (${t("report.periodWeek")})` : `${day} ${zone}`;
    }
    if (typeof fmtDisplayTime === "function") return fmtDisplayTime(time);
    return `${formatEquityTick(time, "day")} ${zone}`;
  }

  function syncEquityPeriodButtons() {
    document.querySelectorAll(".report-period-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.period === equityPeriod);
    });
  }

  function setEquityPeriod(mode) {
    if (!mode || mode === equityPeriod) return;
    equityPeriod = mode;
    syncEquityPeriodButtons();
    if (lastReport) renderEquityCurve(lastReport);
  }

  function renderEquityCurve(report) {
    const el = $("equityChart");
    if (!el || typeof LightweightCharts === "undefined") return;
    destroyEquityChart();
    const mode = equityPeriod || "day";
    const data = aggregateEquityCurve(report?.equityCurve, mode);
    if (!data.length) return;

    equityChartApi = LightweightCharts.createChart(el, {
      width: el.clientWidth || 640,
      height: el.clientHeight || 360,
      layout: {
        background: { color: "#12161e" },
        textColor: "#8b95a8",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: mode === "trade",
        secondsVisible: false,
        tickMarkFormatter: (time) => formatEquityTick(time, mode),
      },
      localization: {
        locale: typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN",
        timeFormatter: (time) => formatEquityCrosshair(time, mode),
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const series = equityChartApi.addAreaSeries({
      lineColor: "#3dd68c",
      topColor: "rgba(61, 214, 140, 0.32)",
      bottomColor: "rgba(61, 214, 140, 0.02)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    series.setData(data);
    equityChartApi.timeScale().fitContent();

    const resize = () => {
      if (!equityChartApi || !el.isConnected) return;
      equityChartApi.applyOptions({
        width: el.clientWidth,
        height: el.clientHeight || 360,
      });
    };
    equityResizeObs = new ResizeObserver(resize);
    equityResizeObs.observe(el);
    requestAnimationFrame(resize);
  }

  function buildRows(s) {
    return [
      { section: true, label: t("report.resultsTitle") },
      { label: t("report.totalNet"), value: fmtSigned(s.totalNet), cls: pnlClass(s.totalNet) },
      { label: t("report.grossProfit"), value: fmtSigned(s.grossProfit), cls: "pnl-pos" },
      { label: t("report.grossLoss"), value: fmtSigned(s.grossLoss), cls: "pnl-neg" },
      { label: t("report.profitFactor"), value: fNum(s.profitFactor) },
      { label: t("report.payoffRatio"), value: payoffRatioText(s) },
      { label: t("report.expectedPayoff"), value: fmtSigned(s.expectedPayoff) },
      {
        label: t("report.recoveryFactor"),
        value: s.recoveryFactor == null ? "—" : fNum(s.recoveryFactor),
      },
      { label: t("report.sharpe"), value: s.sharpe == null ? "—" : fNum(s.sharpe) },
      { section: true, label: t("report.balanceDd") },
      { label: t("report.absDd"), value: fNum(s.absDrawdown) },
      {
        label: t("report.maxDd"),
        value: `${fNum(s.maxDrawdown)} (${pct(s.maxDrawdownPct)})`,
      },
      {
        label: t("report.relDd"),
        value: `${pct(s.relativeDrawdownPct)} (${fNum(s.relativeDrawdownAmount)})`,
      },
      { section: true, label: t("report.tradesTitle") },
      { label: t("report.totalTrades"), value: String(s.n) },
      { label: t("report.shortTrades"), value: `${s.sellN} (${pct(s.sellWinRate)})` },
      { label: t("report.longTrades"), value: `${s.buyN} (${pct(s.buyWinRate)})` },
      {
        label: t("report.profitTrades"),
        value: `${s.wins} (${pct(s.winRate)})`,
        cls: "pnl-pos",
      },
      {
        label: t("report.lossTrades"),
        value: `${s.losses} (${pct(s.lossRate)})`,
        cls: "pnl-neg",
      },
      {
        label: t("report.largestProfit"),
        value: fmtSigned(s.largestWin),
        cls: "pnl-pos",
      },
      {
        label: t("report.largestLoss"),
        value: fmtSigned(s.largestLoss),
        cls: "pnl-neg",
      },
      { label: t("report.avgProfit"), value: fmtSigned(s.avgWin), cls: "pnl-pos" },
      { label: t("report.avgLoss"), value: fmtSigned(s.avgLoss), cls: "pnl-neg" },
      {
        label: t("report.maxConsecWins"),
        value: `${s.maxConsecWins} (${fmtSigned(s.maxConsecWinsSum)})`,
      },
      {
        label: t("report.maxConsecLosses"),
        value: `${s.maxConsecLosses} (${fmtSigned(s.maxConsecLossesSum)})`,
      },
      {
        label: t("report.maxConsecProfit"),
        value: `${fmtSigned(s.maxConsecProfitSum)} (${s.maxConsecProfitCount})`,
      },
      {
        label: t("report.maxConsecLossAmt"),
        value: `${fmtSigned(s.maxConsecLossSum)} (${s.maxConsecLossCount})`,
      },
      { label: t("report.avgConsecWins"), value: fNum(s.avgConsecWins, 0) },
      { label: t("report.avgConsecLosses"), value: fNum(s.avgConsecLosses, 0) },
    ];
  }

  /** 盈亏比 = 平均盈利 / |平均亏损| */
  function payoffRatio(s) {
    const win = Number(s?.avgWin);
    const loss = Math.abs(Number(s?.avgLoss));
    if (!Number.isFinite(win) || !Number.isFinite(loss) || loss < 1e-9) {
      return win > 0 ? Infinity : null;
    }
    return win / loss;
  }

  function payoffRatioText(s) {
    const r = payoffRatio(s);
    if (r == null) return "—";
    if (r === Infinity) return "∞";
    return r.toFixed(2);
  }

  function renderTable(report) {
    const wrap = $("ordersReportTable");
    if (!wrap) return;
    if (!report) {
      wrap.innerHTML = `<p class="mt5-report-empty">${t("report.empty")}</p>`;
      return;
    }
    const rows = buildRows(report)
      .map((row) => {
        if (row.section) {
          return `<tr class="mt5-section"><th colspan="2">${row.label}</th></tr>`;
        }
        return `<tr><th>${row.label}</th><td class="${row.cls || ""}">${row.value}</td></tr>`;
      })
      .join("");
    wrap.innerHTML = `<table class="mt5-report-table"><tbody>${rows}</tbody></table>`;
  }

  function renderKpi(s) {
    const el = $("reportKpi");
    if (!el) return;
    if (!s) {
      el.innerHTML = "";
      return;
    }
    const pf =
      s.profitFactor === Infinity
        ? "∞"
        : Number.isFinite(s.profitFactor)
          ? s.profitFactor.toFixed(2)
          : "—";
    const cards = [
      {
        label: t("report.totalNet"),
        value: fmtSigned(s.totalNet),
        cls: pnlClass(s.totalNet),
      },
      { label: t("report.kpiTrades"), value: String(s.n) },
      {
        label: t("stat.winRate"),
        value: `${s.winRate.toFixed(1)}%`,
        cls: s.winRate >= 50 ? "pnl-pos" : "",
      },
      { label: t("report.profitFactor"), value: pf },
      { label: t("report.payoffRatio"), value: payoffRatioText(s) },
      {
        label: t("report.maxDd"),
        value: fNum(s.maxDrawdown),
        cls: s.maxDrawdown > 0 ? "pnl-neg" : "",
      },
      {
        label: t("report.expectedPayoff"),
        value: fmtSigned(s.expectedPayoff),
        cls: pnlClass(s.expectedPayoff),
      },
    ];
    el.innerHTML = cards
      .map(
        (c) => `<article class="report-kpi-card">
        <span class="report-kpi-label">${c.label}</span>
        <span class="report-kpi-value ${c.cls || ""}">${c.value}</span>
      </article>`
      )
      .join("");
  }

  function showEmpty(empty) {
    $("reportEmpty")?.classList.toggle("hidden", !empty);
    $("reportContent")?.classList.toggle("hidden", empty);
  }

  function filteredRecords() {
    const fromEl = $("reportDateFrom");
    const toEl = $("reportDateTo");
    const fromTs = dateKeyToStartTs(fromEl?.value || "");
    const toTs = dateKeyToEndTs(toEl?.value || "");
    return allRecords.filter((r) => {
      const ts = recordTs(r);
      if (ts == null) return false;
      if (fromTs != null && ts < fromTs) return false;
      if (toTs != null && ts > toTs) return false;
      return true;
    });
  }

  function updateFilterCount(n, total) {
    const el = $("reportFilterCount");
    if (!el) return;
    el.textContent = t("report.filterCount", { n, total });
  }

  function renderReport() {
    const records = filteredRecords();
    updateFilterCount(records.length, allRecords.length);
    const report =
      typeof computeMt5Report === "function" ? computeMt5Report(records) : null;
    lastReport = report;
    if (!report) {
      destroyEquityChart();
      showEmpty(true);
      const empty = $("reportEmpty");
      if (empty) {
        empty.textContent = allRecords.length
          ? t("report.filterEmpty")
          : t("report.empty");
      }
      return;
    }
    showEmpty(false);
    renderKpi(report);
    renderTable(report);
    syncEquityPeriodButtons();
    requestAnimationFrame(() => renderEquityCurve(report));
  }

  function syncFilterBounds() {
    const filter = $("reportFilter");
    const fromEl = $("reportDateFrom");
    const toEl = $("reportDateTo");
    if (!filter || !fromEl || !toEl) return;

    if (!allRecords.length) {
      filter.hidden = true;
      fromEl.value = "";
      toEl.value = "";
      return;
    }

    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const r of allRecords) {
      const ts = recordTs(r);
      if (ts == null) continue;
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
    }
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) {
      filter.hidden = true;
      return;
    }

    const minDate = tsToDateKey(minTs);
    const maxDate = tsToDateKey(maxTs);
    fromEl.min = minDate;
    fromEl.max = maxDate;
    toEl.min = minDate;
    toEl.max = maxDate;
    if (!fromEl.value) fromEl.value = minDate;
    if (!toEl.value) toEl.value = maxDate;
    if (fromEl.value < minDate) fromEl.value = minDate;
    if (fromEl.value > maxDate) fromEl.value = maxDate;
    if (toEl.value < minDate) toEl.value = minDate;
    if (toEl.value > maxDate) toEl.value = maxDate;
    filter.hidden = false;
  }

  function resetFilterRange() {
    const fromEl = $("reportDateFrom");
    const toEl = $("reportDateTo");
    if (fromEl) fromEl.value = fromEl.min || "";
    if (toEl) toEl.value = toEl.max || "";
    renderReport();
  }

  function onFilterChange() {
    const fromEl = $("reportDateFrom");
    const toEl = $("reportDateTo");
    if (fromEl && toEl && fromEl.value && toEl.value && fromEl.value > toEl.value) {
      // 保持区间合法：以当前改动的一侧为准时，由浏览器顺序触发；这里交换
      const tmp = fromEl.value;
      fromEl.value = toEl.value;
      toEl.value = tmp;
    }
    renderReport();
  }

  async function loadOrders() {
    const res = await fetch(apiUrl("/api/orders"));
    if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.orderRecords) ? data.orderRecords : [];
  }

  function bindFilter() {
    $("reportDateFrom")?.addEventListener("change", onFilterChange);
    $("reportDateTo")?.addEventListener("change", onFilterChange);
    $("reportFilterReset")?.addEventListener("click", resetFilterRange);
    document.querySelectorAll(".report-period-btn").forEach((btn) => {
      btn.addEventListener("click", () => setEquityPeriod(btn.dataset.period));
    });
    syncEquityPeriodButtons();
  }

  window.onLocaleChange = function () {
    if (typeof applyI18n === "function") applyI18n();
    renderReport();
  };

  async function init() {
    if (typeof initI18n === "function") initI18n();
    document.documentElement.dataset.i18nTitle = "report.pageTitle";
    if (typeof applyI18n === "function") applyI18n();
    bindFilter();
    try {
      allRecords = await loadOrders();
      syncFilterBounds();
      renderReport();
    } catch (e) {
      console.warn("load orders for report failed", e);
      allRecords = [];
      syncFilterBounds();
      showEmpty(true);
      const empty = $("reportEmpty");
      if (empty) empty.textContent = e?.message || t("report.empty");
    }
  }

  init().catch((e) => console.error(e));
})();
