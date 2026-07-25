/* 独立交易报告页：/report.html */

(function () {
  "use strict";

  let equityChartApi = null;
  let equityResizeObs = null;

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

  function buildEquityData(curve) {
    let lastT = 0;
    const data = [];
    for (const p of curve || []) {
      let t = Number(p.time);
      if (!Number.isFinite(t) || t < 1_000_000_000) {
        t = (lastT > 0 ? lastT : 1_700_000_000) + 86400;
      }
      if (t <= lastT) t = lastT + 1;
      lastT = t;
      data.push({ time: t, value: p.equity });
    }
    return data;
  }

  function renderEquityCurve(report) {
    const el = $("equityChart");
    if (!el || typeof LightweightCharts === "undefined") return;
    destroyEquityChart();
    const data = buildEquityData(report?.equityCurve);
    if (!data.length) return;

    const fmtEquityTime = (time) => {
      const d = new Date(time * 1000);
      const locale = typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN";
      return (
        d.toLocaleString(locale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }) + " UTC"
      );
    };

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
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => new Date(time * 1000).toISOString().slice(0, 10),
      },
      localization: {
        locale: typeof getLocale === "function" && getLocale() === "en" ? "en-GB" : "zh-CN",
        timeFormatter: fmtEquityTime,
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

  function renderReport(records) {
    const report =
      typeof computeMt5Report === "function" ? computeMt5Report(records || []) : null;
    if (!report) {
      destroyEquityChart();
      showEmpty(true);
      return;
    }
    showEmpty(false);
    renderKpi(report);
    renderTable(report);
    requestAnimationFrame(() => renderEquityCurve(report));
  }

  async function loadOrders() {
    const res = await fetch(apiUrl("/api/orders"));
    if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.orderRecords) ? data.orderRecords : [];
  }

  window.onLocaleChange = function () {
    if (typeof applyI18n === "function") applyI18n();
    if (window.__reportRecords) renderReport(window.__reportRecords);
  };

  async function init() {
    if (typeof initI18n === "function") initI18n();
    document.documentElement.dataset.i18nTitle = "report.pageTitle";
    if (typeof applyI18n === "function") applyI18n();
    try {
      const records = await loadOrders();
      window.__reportRecords = records;
      renderReport(records);
    } catch (e) {
      console.warn("load orders for report failed", e);
      window.__reportRecords = [];
      showEmpty(true);
      const empty = $("reportEmpty");
      if (empty) empty.textContent = e?.message || t("report.empty");
    }
  }

  init().catch((e) => console.error(e));
})();
