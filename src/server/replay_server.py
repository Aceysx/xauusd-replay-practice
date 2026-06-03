#!/usr/bin/env python3
"""回测复盘练习工具 — K 线回放 + 模拟下单 HTTP 服务。"""

import json
import mimetypes
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from src.core.config import get_config, get_paths, replay_defaults, strategy_defaults, timezone_config
from src.core.m5 import (
    bars_to_chart_json,
    default_replay_range,
    list_available_dates,
    load_m5_by_date_range,
    load_trading_days_ending,
    normalize_timeframe,
    range_before_trading_day,
    resample_bars,
    timeframe_bar_seconds,
)
from src.server.history import build_trades_index, report_summary, trade_detail

ROOT = get_paths()["root"]
WEB_DIR = ROOT / "web"
LEGACY_DIR = ROOT / "web" / "legacy"
REPORT_DIR = ROOT / "report"


class ReplayHandler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]) == "200":
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/config":
            self._send_json(self._api_config())
            return
        if path == "/api/bars":
            self._send_json(self._api_bars(qs))
            return
        if path == "/api/dates":
            self._send_json({"dates": list_available_dates()})
            return
        if path in ("/api/history/trades", "/api/trades"):
            self._send_json(self._get_trades())
            return
        if path.startswith("/api/history/trade/") or path.startswith("/api/trade/"):
            ticket = path.rsplit("/", 1)[-1].split("?")[0]
            detail = trade_detail(ticket)
            if detail is None:
                self.send_error(404, "trade not found")
                return
            self._send_json(detail)
            return
        if path == "/api/report/summary":
            self._send_json(report_summary())
            return
        if path == "/api/limits/summary":
            self._send_limits_summary()
            return
        if path == "/api/limits/near_miss":
            self._send_limits_near_miss()
            return
        if path == "/api/latest/summary":
            self._send_latest_summary()
            return
        if path.startswith("/report/"):
            self._serve_report_file(path)
            return
        if path.startswith("/legacy/"):
            self._serve_legacy(path)
            return
        if path in ("", "/"):
            self._serve_file(WEB_DIR / "index.html")
            return
        return super().do_GET()

    def _api_config(self) -> dict:
        dates = list_available_dates()
        replay = replay_defaults()
        start, end = default_replay_range(replay["initial_trading_days"])
        strat = strategy_defaults()
        tz = timezone_config()
        return {
            "api_version": 2,
            "default_sl": strat["sl"],
            "default_tp": strat["tp"],
            "default_range": {"start": start, "end": end},
            "first_date": dates[0] if dates else start,
            "last_date": dates[-1] if dates else end,
            "chart_visible_bars": replay["chart_visible_bars"],
            "initial_trading_days": replay["initial_trading_days"],
            "load_chunk_trading_days": replay["load_chunk_trading_days"],
            "bar_ms_per_candle_at_1x": replay["bar_ms_per_candle_at_1x"],
            "default_timeframe": replay["default_timeframe"],
            "timeframes": replay["timeframes"],
        }

    def _api_bars(self, qs: dict) -> dict:
        tf = normalize_timeframe(qs.get("tf", [None])[0] or qs.get("timeframe", [None])[0])
        start = qs.get("start", [None])[0]
        end = qs.get("end", [None])[0]
        days = qs.get("days", [None])[0]
        before = qs.get("before", [None])[0]

        if before and days:
            n = int(days)
            span = range_before_trading_day(before, n)
            if span is None:
                return self._bars_payload(pd.DataFrame(), before, before, tf=tf, has_more=False)
            start, end = span
            bars = resample_bars(load_m5_by_date_range(start, end), tf)
            dates = list_available_dates()
            has_more = dates.index(start) > 0 if start in dates else False
            return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

        if days and not start:
            n = int(days)
            dates = list_available_dates()
            end = end or dates[-1]
            bars = resample_bars(load_trading_days_ending(end, n), tf)
            i = dates.index(end) if end in dates else len(dates) - 1
            start = dates[max(0, i - n + 1)]
            has_more = start != dates[0]
            return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

        if not start or not end:
            start, end = default_replay_range()
        bars = resample_bars(load_m5_by_date_range(start, end), tf)
        dates = list_available_dates()
        has_more = start != dates[0] if dates else False
        return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

    def _bars_payload(
        self, bars, start: str, end: str, tf: str = "5m", has_more: bool = False
    ) -> dict:
        ohlc = bars_to_chart_json(bars)
        times = [b["time"] for b in ohlc]
        return {
            "start": start,
            "end": end,
            "timeframe": tf,
            "bar_seconds": timeframe_bar_seconds(tf),
            "count": len(ohlc),
            "bars": ohlc,
            "first_ts": times[0] if times else None,
            "last_ts": times[-1] if times else None,
            "has_more_before": has_more,
        }

    def _get_trades(self) -> list[dict]:
        return build_trades_index()

    def _serve_report_file(self, path: str):
        name = path.split("/report/", 1)[-1]
        fp = REPORT_DIR / name
        if not fp.exists() or not fp.is_file():
            self.send_error(404)
            return
        self._serve_file(fp)

    def _serve_legacy(self, path: str):
        name = path.replace("/legacy/", "", 1)
        fp = LEGACY_DIR / name
        if not fp.exists():
            # fallback to old viz/
            fp = ROOT / "viz" / name
        if not fp.exists():
            self.send_error(404)
            return
        self._serve_file(fp)

    def _serve_file(self, fp: Path):
        content = fp.read_bytes()
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def _send_limits_summary(self):
        fp = ROOT / "limit_orders_summary.csv"
        if not fp.exists():
            self._send_json({"error": "请先运行 python analyze_limits.py"})
            return
        import pandas as pd

        self._send_json(pd.read_csv(fp).to_dict(orient="records"))

    def _send_limits_near_miss(self):
        fp = ROOT / "limit_orders_analysis.csv"
        if not fp.exists():
            self._send_json([])
            return
        import pandas as pd

        df = pd.read_csv(fp)
        nm = df[df["near_miss_2pt"] == True].sort_values("min_gap_pts")  # noqa: E712
        cols = [
            "ticket",
            "type",
            "open_time",
            "limit_price",
            "min_gap_pts",
            "fill_off0",
            "fill_off2",
            "net_off0",
            "net_off2",
        ]
        cols = [c for c in cols if c in nm.columns]
        self._send_json(nm[cols].head(200).to_dict(orient="records"))

    def _send_latest_summary(self):
        fp = ROOT / "backtest_latest_summary.csv"
        if not fp.exists():
            self._send_json({"error": "请先运行 python backtest_latest_strategy.py"})
            return
        import pandas as pd

        self._send_json(pd.read_csv(fp).to_dict(orient="records"))

    def _send_json(self, data):
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)


def main():
    WEB_DIR.mkdir(exist_ok=True)
    LEGACY_DIR.mkdir(parents=True, exist_ok=True)

    cfg = get_config()
    host = cfg.get("server", {}).get("host", "0.0.0.0")
    env_port = os.environ.get("PORT")
    if env_port:
        ports_to_try = [int(env_port)]
    else:
        base_port = replay_defaults()["port"]
        ports_to_try = range(base_port, base_port + 5)

    for try_port in ports_to_try:
        try:
            server = ThreadingHTTPServer((host, try_port), ReplayHandler)
            port = try_port
            break
        except OSError as e:
            if getattr(e, "errno", None) != 48:
                raise
    else:
        raise SystemExit("端口均被占用，请设置 PORT 或修改 config.yaml 中 replay.port")

    print(f"\n复盘练习工具 → http://{host}:{port}/")
    print("  历史回测报告 → /legacy/index.html")
    print("  报告摘要页   → /report.html\n")
    server.serve_forever()


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    main()
