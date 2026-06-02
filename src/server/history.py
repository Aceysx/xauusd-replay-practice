"""历史交割单 API：始终从 Statement.htm 实时解析，不读缓存 CSV。"""

from datetime import timedelta

import pandas as pd

from src.core.config import get_paths
from src.core.m5 import bars_to_chart_json, load_m5_range
from src.core.statement import load_orig_exit_tags, orig_exit_label, parse_statement
from src.core.timezone import BROKER_UTC_OFFSET_HOURS, statement_to_m5_time, to_chart_unix
from src.engine.simulator import RECOMMENDED_SL, RECOMMENDED_TP, simulate_trade, sl_price, tp_price

ROOT = get_paths()["root"]
REPORT_MARKET_CSV = ROOT / "report" / "market_trades.csv"


def build_trades_index() -> list[dict]:
    paths = get_paths()
    trades = parse_statement(paths["statement"])
    sl_t, tp_t = load_orig_exit_tags(paths["statement"])

    rows = []
    for _, tr in trades.iterrows():
        ticket = str(tr["ticket"])
        open_m5 = statement_to_m5_time(tr["open_dt"])
        rows.append(
            {
                "ticket": ticket,
                "direction": tr["type"],
                "open_time": tr["open_time"],
                "close_time": tr["close_time"],
                "open_ts": to_chart_unix(open_m5),
                "entry": tr["open_price"],
                "orig_close": tr["close_price"],
                "size": tr["size"],
                "orig_exit": orig_exit_label(ticket, sl_t, tp_t),
                "orig_net": tr["profit"] + tr["commission"] + tr["swap"],
            }
        )
    rows.sort(key=lambda x: x["open_time"], reverse=True)
    return rows


def snap_to_price_bar(bars: pd.DataFrame, target_m5, price: float) -> int:
    ts = to_chart_unix(target_m5)
    if bars.empty:
        return ts
    candidates = bars[(bars["low"] <= price) & (bars["high"] >= price)]
    if candidates.empty:
        return ts
    candidates = candidates.copy()
    candidates["_dist"] = (candidates["timestamps"] - target_m5).abs()
    return to_chart_unix(candidates.loc[candidates["_dist"].idxmin(), "timestamps"])


def trade_detail(ticket: str) -> dict | None:
    paths = get_paths()
    trades = parse_statement(paths["statement"])
    trades["ticket"] = trades["ticket"].astype(str)
    row = trades[trades["ticket"] == ticket]
    if row.empty:
        return None
    tr = row.iloc[0]

    sl_t, tp_t = load_orig_exit_tags()
    orig_exit = orig_exit_label(ticket, sl_t, tp_t)

    sim_origtp = simulate_trade(tr, sl_pts=RECOMMENDED_SL, use_orig_tp=True)
    sim_tp20 = simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=RECOMMENDED_TP)

    open_m5 = statement_to_m5_time(tr["open_dt"])
    close_m5 = statement_to_m5_time(tr["close_dt"])
    sim_exit_m5 = pd.Timestamp(sim_tp20["exit_dt"])
    pad_start = open_m5 - timedelta(hours=2)
    pad_end = max(close_m5, sim_exit_m5) + timedelta(hours=2)
    bars = load_m5_range(pad_start, pad_end)

    entry = tr["open_price"]
    direction = tr["type"]
    suggested_sl = sl_price(direction, entry, RECOMMENDED_SL)
    suggested_tp = tp_price(direction, entry, RECOMMENDED_TP)

    sl_dist = entry - tr["orig_sl"] if direction == "buy" else tr["orig_sl"] - entry

    return {
        "ticket": ticket,
        "direction": direction,
        "size": tr["size"],
        "entry": entry,
        "orig_sl": tr["orig_sl"],
        "orig_tp": tr["orig_tp"] if tr["orig_tp"] > 0 else None,
        "orig_close": tr["close_price"],
        "sl_dist": round(float(sl_dist), 2),
        "orig_exit": orig_exit,
        "orig_net": tr["profit"] + tr["commission"] + tr["swap"],
        "commission": tr["commission"],
        "swap": tr["swap"],
        "suggested_sl": suggested_sl,
        "suggested_tp": suggested_tp,
        "sl_pts": RECOMMENDED_SL,
        "tp_pts": RECOMMENDED_TP,
        "sim_sl5_origtp": {
            "net": sim_origtp["sim_net"],
            "exit_reason": sim_origtp["exit_reason"],
            "exit_px": sim_origtp["exit_px"],
            "delta": sim_origtp["delta"],
            "new_sl": sim_origtp["new_sl"],
            "new_tp": sim_origtp["new_tp"],
        },
        "sim_sl5_tp20": {
            "net": sim_tp20["sim_net"],
            "exit_reason": sim_tp20["exit_reason"],
            "exit_px": sim_tp20["exit_px"],
            "delta": sim_tp20["delta"],
            "new_sl": sim_tp20["new_sl"],
            "new_tp": sim_tp20["new_tp"],
        },
        "broker_offset_hours": BROKER_UTC_OFFSET_HOURS,
        "open_time_broker": tr["open_dt"].strftime("%Y-%m-%d %H:%M:%S"),
        "close_time_broker": tr["close_dt"].strftime("%Y-%m-%d %H:%M:%S"),
        "open_ts": snap_to_price_bar(bars, open_m5, entry),
        "close_ts": snap_to_price_bar(bars, close_m5, tr["close_price"]),
        "sim_exit_ts": snap_to_price_bar(bars, sim_exit_m5, sim_tp20["exit_px"]),
        "bars": bars_to_chart_json(bars),
    }


def report_summary() -> dict:
    report_dir = ROOT / "report"
    md_files = sorted(report_dir.glob("backtest_report_*.md"), reverse=True)
    summary = {"reports": [], "market_csv": REPORT_MARKET_CSV.exists()}
    for fp in md_files[:5]:
        summary["reports"].append({"name": fp.name, "path": f"/report/{fp.name}"})
    if REPORT_MARKET_CSV.exists():
        df = pd.read_csv(REPORT_MARKET_CSV, nrows=0)
        summary["market_columns"] = list(df.columns)
    return summary
