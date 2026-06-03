/* 国际化 */
const LOCALES = {
  "zh-CN": {
    "app.title": "回测练习",
    "lang.zh": "中文",
    "lang.en": "English",
    "loading.default": "加载中…",
    "loading.restore": "恢复练习盘面…",
    "loading.earlier": "加载更早数据…",
    "loading.jump": "跳转回测加载中…",
    "error.loadBars": "加载 K 线失败",
    "error.restartServer": "请重启: python3 -m src.server.replay_server",
    "error.loadFailed": "加载失败: {msg}",
    "panel.resize": "上下拖动调整下单区高度",
    "btn.buy": "Buy",
    "btn.buy.title": "买入 (B)",
    "btn.sell": "Sell",
    "btn.sell.title": "卖出 (S)",
    "btn.close": "平仓",
    "btn.close.title": "平仓 (C)",
    "btn.stepPrev.title": "上一根 K (←)",
    "btn.stepNext.title": "下一根 K (→)",
    "btn.play": "播放",
    "btn.pause": "暂停",
    "btn.play.title": "播放/暂停 (Space)",
    "btn.speed.title": "播放倍速",
    "timeframe.label": "K 线周期",
    "loading.timeframe": "切换周期…",
    "btn.jump": "跳转回测",
    "btn.reset": "重置数据",
    "btn.reset.title": "清除本地保存的练习数据",
    "draw.toolbar": "画图工具",
    "draw.cursor.title": "选择/编辑画线",
    "draw.hline.title": "水平线（含十字辅助线）",
    "draw.trend.title": "趋势线（两点）",
    "draw.fib.title": "斐波那契（两点）",
    "draw.clear.title": "清除所有画线",
    "orders.title": "下单记录",
    "orders.count": "({n} 笔)",
    "orders.empty": "暂无平仓记录",
    "table.id": "#",
    "table.open": "开仓",
    "table.dir": "方向",
    "table.entry": "入场",
    "table.close": "平仓",
    "table.pnl": "盈亏",
    "table.exit": "出场",
    "dir.buy": "buy",
    "dir.sell": "sell",
    "exit.sl": "sl",
    "exit.tp": "tp",
    "exit.manual": "manual",
    "position.none": "无持仓",
    "position.float": "浮盈",
    "position.rr": "盈亏比",
    "alert.pickDate": "请选择日期",
    "alert.noBars": "该日无 K 线",
    "alert.closeFirst": "请先平仓",
    "confirm.reset": "将清除本地保存的下单记录、画线、持仓与回放进度，且不可恢复。是否继续？",
    "marker.openLong": "开多",
    "marker.openShort": "开空",
    "marker.holdLong": "持多",
    "marker.holdShort": "持空",
    "marker.win": "盈",
    "marker.loss": "损",
    "marker.flat": "平",
    "rr.target": "目标",
    "rr.stop": "止损",
    "rr.long": "做多",
    "rr.short": "做空",
    "rr.float": "浮盈",
    "rr.dragHint": "↓↑拖出 SL/TP",
    "rr.riskReward": "风险回报",
    "rr.exitSl": "止损",
    "rr.exitTp": "止盈",
    "rr.exitManual": "平仓",
    "stat.totalPnl": "总盈亏",
    "stat.trades": "笔数",
    "stat.winRate": "胜率",
    "stat.maxDd": "最大回撤",
    "stat.avgWin": "均盈",
    "stat.avgLoss": "均亏",
    "stat.profitFactor": "盈亏比",
    "stat.plannedRr": "计划RR",
    "stat.consecLoss": "连亏 {n} 笔",
    "stat.daily": "按日",
  },
  en: {
    "app.title": "Replay Practice",
    "lang.zh": "中文",
    "lang.en": "English",
    "loading.default": "Loading…",
    "loading.restore": "Restoring session…",
    "loading.earlier": "Loading earlier bars…",
    "loading.jump": "Loading backtest…",
    "error.loadBars": "Failed to load bars",
    "error.restartServer": "Restart: python3 -m src.server.replay_server",
    "error.loadFailed": "Load failed: {msg}",
    "panel.resize": "Drag to resize panel height",
    "btn.buy": "Buy",
    "btn.buy.title": "Buy (B)",
    "btn.sell": "Sell",
    "btn.sell.title": "Sell (S)",
    "btn.close": "Close",
    "btn.close.title": "Close (C)",
    "btn.stepPrev.title": "Previous bar (←)",
    "btn.stepNext.title": "Next bar (→)",
    "btn.play": "Play",
    "btn.pause": "Pause",
    "btn.play.title": "Play / Pause (Space)",
    "btn.speed.title": "Playback speed",
    "timeframe.label": "Timeframe",
    "loading.timeframe": "Switching timeframe…",
    "btn.jump": "Jump to date",
    "btn.reset": "Reset data",
    "btn.reset.title": "Clear saved practice data",
    "draw.toolbar": "Drawing tools",
    "draw.cursor.title": "Select / edit drawings",
    "draw.hline.title": "Horizontal line (cross guides)",
    "draw.trend.title": "Trend line (2 points)",
    "draw.fib.title": "Fibonacci (2 points)",
    "draw.clear.title": "Clear all drawings",
    "orders.title": "Orders",
    "orders.count": "({n} trades)",
    "orders.empty": "No closed trades yet",
    "table.id": "#",
    "table.open": "Open",
    "table.dir": "Side",
    "table.entry": "Entry",
    "table.close": "Close",
    "table.pnl": "P/L",
    "table.exit": "Exit",
    "dir.buy": "buy",
    "dir.sell": "sell",
    "exit.sl": "sl",
    "exit.tp": "tp",
    "exit.manual": "manual",
    "position.none": "No position",
    "position.float": "Unrealized",
    "position.rr": "R:R",
    "alert.pickDate": "Please select a date",
    "alert.noBars": "No bars on this date",
    "alert.closeFirst": "Close position first",
    "confirm.reset":
      "This will clear saved orders, drawings, position and replay progress. Continue?",
    "marker.openLong": "Long",
    "marker.openShort": "Short",
    "marker.holdLong": "Long",
    "marker.holdShort": "Short",
    "marker.win": "TP",
    "marker.loss": "SL",
    "marker.flat": "Exit",
    "rr.target": "Target",
    "rr.stop": "Stop",
    "rr.long": "Long",
    "rr.short": "Short",
    "rr.float": "Unrealized",
    "rr.dragHint": "↓↑ drag SL/TP",
    "rr.riskReward": "Risk/Reward",
    "rr.exitSl": "Stop loss",
    "rr.exitTp": "Take profit",
    "rr.exitManual": "Manual close",
    "stat.totalPnl": "Total P/L",
    "stat.trades": "Trades",
    "stat.winRate": "Win rate",
    "stat.maxDd": "Max drawdown",
    "stat.avgWin": "Avg win",
    "stat.avgLoss": "Avg loss",
    "stat.profitFactor": "Profit factor",
    "stat.plannedRr": "Planned R:R",
    "stat.consecLoss": "Max streak {n}",
    "stat.daily": "By day",
  },
};

const LOCALE_STORAGE_KEY = "replay_locale";
let currentLocale = "zh-CN";

function t(key, vars = {}) {
  const pack = LOCALES[currentLocale] || LOCALES["zh-CN"];
  const fallback = LOCALES["zh-CN"][key];
  let str = pack[key] ?? fallback ?? key;
  Object.entries(vars).forEach(([k, v]) => {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  });
  return str;
}

function getLocale() {
  return currentLocale;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey);
}

function setLocale(locale) {
  if (!LOCALES[locale]) locale = "zh-CN";
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  applyI18n();
  const sel = document.getElementById("localeSelect");
  if (sel) sel.value = locale;
  if (typeof onLocaleChange === "function") onLocaleChange();
}

function initI18n() {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  const browser = (navigator.language || "zh-CN").toLowerCase();
  let locale = "zh-CN";
  if (saved && LOCALES[saved]) locale = saved;
  else if (browser.startsWith("en")) locale = "en";
  document.documentElement.dataset.i18nTitle = "app.title";
  setLocale(locale);
  const sel = document.getElementById("localeSelect");
  if (sel) {
    sel.innerHTML = `
      <option value="zh-CN">${LOCALES["zh-CN"]["lang.zh"]}</option>
      <option value="en">${LOCALES.en["lang.en"]}</option>
    `;
    sel.value = locale;
    sel.addEventListener("change", () => setLocale(sel.value));
  }
}
