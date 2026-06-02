#!/usr/bin/env python3
"""本地可视化：K 线 + 原策略 vs 优化 SL5 / SL5+TP20 对比。"""

import json
import re
from datetime import timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd

from backtest_sl7 import (
    RECOMMENDED_SL,
    RECOMMENDED_TP,
    ROOT,
    STATEMENT,
    load_m5_range,
    load_orig_exit_tags,
    orig_exit_label,
    parse_statement,
    simulate_trade,
    tp_price,
    sl_price,
)
from tz_config import BROKER_UTC_OFFSET_HOURS, statement_to_m5_time, to_chart_unix

VIZ_DIR = ROOT / "viz"
TRADES_JSON = VIZ_DIR / "trades.json"
COMPARISON_CSV = ROOT / "backtest_comparison.csv"
LIMITS_CSV = ROOT / "limit_orders_analysis.csv"
LIMITS_SUMMARY_CSV = ROOT / "limit_orders_summary.csv"
LATEST_SUMMARY_CSV = ROOT / "backtest_latest_summary.csv"


def _load_comparison() -> pd.DataFrame | None:
    if COMPARISON_CSV.exists():
        return pd.read_csv(COMPARISON_CSV)
    return None


def build_trades_index() -> list[dict]:
    trades = parse_statement(STATEMENT)
    comp = _load_comparison()
    sl_t, tp_t = load_orig_exit_tags()

    rows = []
    for _, tr in trades.iterrows():
        ticket = str(tr["ticket"])
        orig_exit = orig_exit_label(ticket, sl_t, tp_t)
        orig_net = tr["profit"] + tr["commission"] + tr["swap"]

        if comp is not None and ticket in comp["ticket"].astype(str).values:
            c = comp[comp["ticket"].astype(str) == ticket].iloc[0]
            sim_net = float(c["sl5_tp20_net"])
            delta = float(c["sl5_tp20_delta"])
            sim_exit = c["sl5_tp20_exit"]
        else:
            s = simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=RECOMMENDED_TP)
            sim_net = s["sim_net"]
            delta = s["delta"]
            sim_exit = s["exit_reason"]

        sl_dist = (
            tr["open_price"] - tr["orig_sl"]
            if tr["type"] == "buy"
            else tr["orig_sl"] - tr["open_price"]
        )
        rows.append(
            {
                "ticket": ticket,
                "direction": tr["type"],
                "open_time": tr["open_time"],
                "close_time": tr["close_time"],
                "open_dt": tr["open_dt"].strftime("%Y-%m-%d %H:%M:%S"),
                "close_dt": tr["close_dt"].strftime("%Y-%m-%d %H:%M:%S"),
                "entry": tr["open_price"],
                "orig_sl": tr["orig_sl"],
                "orig_tp": tr["orig_tp"] if tr["orig_tp"] > 0 else None,
                "orig_close": tr["close_price"],
                "sl_dist": round(float(sl_dist), 2),
                "size": tr["size"],
                "orig_exit": orig_exit,
                "orig_profit": tr["profit"],
                "orig_net": orig_net,
                "suggested_sl": sl_price(tr["type"], tr["open_price"], RECOMMENDED_SL),
                "suggested_tp": tp_price(tr["type"], tr["open_price"], RECOMMENDED_TP),
                "sim_net": sim_net,
                "sim_exit_reason": sim_exit,
                "delta": delta,
                "changed": orig_exit != sim_exit,
            }
        )
    rows.sort(key=lambda x: x["open_time"], reverse=True)
    return rows


def trade_detail(ticket: str) -> dict | None:
    trades = parse_statement(STATEMENT)
    trades["ticket"] = trades["ticket"].astype(str)
    row = trades[trades["ticket"] == ticket]
    if row.empty:
        return None
    tr = row.iloc[0]

    sl_t, tp_t = load_orig_exit_tags()
    orig_exit = orig_exit_label(ticket, sl_t, tp_t)

    sim_origtp = simulate_trade(tr, sl_pts=RECOMMENDED_SL, use_orig_tp=True)
    sim_tp20 = simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=RECOMMENDED_TP)

    sim_exit_dt = pd.Timestamp(sim_tp20["exit_dt"])
    open_m5 = statement_to_m5_time(tr["open_dt"])
    close_m5 = statement_to_m5_time(tr["close_dt"])
    sim_exit_m5 = pd.Timestamp(sim_tp20["exit_dt"])
    pad_start = open_m5 - timedelta(hours=2)
    pad_end = max(close_m5, sim_exit_m5) + timedelta(hours=2)
    bars = load_m5_range(pad_start, pad_end)

    ohlc = []
    if not bars.empty:
        for _, b in bars.iterrows():
            ohlc.append(
                {
                    "time": to_chart_unix(b["timestamps"]),
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                }
            )

    def snap_to_price_bar(target_m5, price):
        ts = to_chart_unix(target_m5)
        if bars.empty:
            return ts
        candidates = bars[(bars["low"] <= price) & (bars["high"] >= price)]
        if candidates.empty:
            return ts
        candidates = candidates.copy()
        candidates["_dist"] = (candidates["timestamps"] - target_m5).abs()
        return to_chart_unix(candidates.loc[candidates["_dist"].idxmin(), "timestamps"])

    entry = tr["open_price"]
    direction = tr["type"]
    suggested_sl = sl_price(direction, entry, RECOMMENDED_SL)
    suggested_tp = tp_price(direction, entry, RECOMMENDED_TP)

    sl_dist = (
        entry - tr["orig_sl"] if direction == "buy" else tr["orig_sl"] - entry
    )

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
        "open_ts": snap_to_price_bar(open_m5, entry),
        "close_ts": snap_to_price_bar(close_m5, tr["close_price"]),
        "sim_exit_ts": snap_to_price_bar(sim_exit_m5, sim_tp20["exit_px"]),
        "bars": ohlc,
    }


class VizHandler(SimpleHTTPRequestHandler):
    _trades_cache: list[dict] | None = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(VIZ_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if args and "200" in str(args[1] if len(args) > 1 else ""):
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/trades":
            self._send_json(self._get_trades())
            return
        if path.startswith("/api/trade/"):
            ticket = path.split("/")[-1]
            detail = trade_detail(ticket)
            if detail is None:
                self.send_error(404, "trade not found")
                return
            self._send_json(detail)
            return
        if path == "/api/limits/summary":
            self._send_limits_summary()
            return
        if path == "/api/limits/near_miss":
            self._send_limits_near_miss()
            return
        if path == "/api/latest/summary":
            if not LATEST_SUMMARY_CSV.exists():
                self._send_json({"error": "请先运行 python3 backtest_latest_strategy.py"})
                return
            df = pd.read_csv(LATEST_SUMMARY_CSV)
            self._send_json(df.to_dict(orient="records"))
            return
        return super().do_GET()

    def _send_limits_summary(self):
        if not LIMITS_SUMMARY_CSV.exists():
            self._send_json({"error": "请先运行 python3 analyze_limits.py"})
            return
        df = pd.read_csv(LIMITS_SUMMARY_CSV)
        self._send_json(df.to_dict(orient="records"))

    def _send_limits_near_miss(self):
        if not LIMITS_CSV.exists():
            self._send_json([])
            return
        df = pd.read_csv(LIMITS_CSV)
        nm = df[df["near_miss_2pt"] == True].sort_values("min_gap_pts")  # noqa: E712
        cols = [
            "ticket", "type", "open_time", "limit_price", "min_gap_pts",
            "fill_off0", "fill_off2", "net_off0", "net_off2",
        ]
        cols = [c for c in cols if c in nm.columns]
        self._send_json(nm[cols].head(200).to_dict(orient="records"))

    def _get_trades(self) -> list[dict]:
        VizHandler._trades_cache = build_trades_index()
        return VizHandler._trades_cache

    def _send_json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    VIZ_DIR.mkdir(exist_ok=True)
    if not LIMITS_CSV.exists():
        print("正在分析挂单…")
        from analyze_limits import run_analysis, print_report

        d, s = run_analysis()
        d.to_csv(LIMITS_CSV, index=False)
        s.to_csv(LIMITS_SUMMARY_CSV, index=False)
        print_report(d, s)

    print("正在生成回测对比…")
    from backtest_sl7 import run_all_simulations, print_summary

    trades = parse_statement(STATEMENT)
    comp = run_all_simulations(trades)
    comp.to_csv(COMPARISON_CSV, index=False)
    print_summary(comp, trades)

    print("\n正在生成交易索引…")
    trades_list = build_trades_index()
    TRADES_JSON.write_text(
        json.dumps(trades_list, ensure_ascii=False), encoding="utf-8"
    )
    print(f"已写入 {TRADES_JSON} ({len(trades_list)} 笔)")

    port = 8765
    for try_port in range(8765, 8770):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", try_port), VizHandler)
            port = try_port
            break
        except OSError as e:
            if e.errno != 48:
                raise
    else:
        raise SystemExit("8765-8769 端口均被占用，请先结束旧进程")

    print(f"\n可视化已启动 → http://127.0.0.1:{port}/")
    print("对比：原 SL/TP vs 建议 SL5 + TP20\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
