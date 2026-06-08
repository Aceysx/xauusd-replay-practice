#!/usr/bin/env python3
"""北京时间 0–4 点 Donchian/ATR 区间高抛低吸回测 CLI（默认 M1）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.m5 import list_available_dates, timeframe_minutes
from src.engine.range_reversion import RangeReversionParams, format_summary, run_backtest


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="北京时间时段区间回归回测")
    p.add_argument("--tf", default="1m", choices=["1m", "5m"], help="K 线周期（默认 M1）")
    p.add_argument("--start", default=None, help="起始交易日 YYYY-MM-DD")
    p.add_argument("--end", default=None, help="结束交易日 YYYY-MM-DD")
    p.add_argument("--hour-start", type=int, default=0, help="北京时间起始小时 (含)")
    p.add_argument("--hour-end", type=int, default=4, help="北京时间结束小时 (不含)")
    p.add_argument("--donchian", type=int, default=None, help="Donchian 周期（根数，默认按时长自动换算）")
    p.add_argument("--min-range", type=float, default=5.0, help="最小区间宽度 USD")
    p.add_argument("--max-range", type=float, default=40.0, help="最大区间宽度 USD")
    p.add_argument("--min-range-atr", type=float, default=2.0, help="区间宽度 / ATR 下限")
    p.add_argument("--max-range-atr", type=float, default=15.0, help="区间宽度 / ATR 上限")
    p.add_argument("--max-adx", type=float, default=45.0, help="ADX 上限（震荡过滤）")
    p.add_argument("--max-er", type=float, default=0.55, help="方向效率上限")
    p.add_argument("--lots", type=float, default=0.01, help="固定手数")
    p.add_argument(
        "--out",
        default="report/range_reversion_trades.csv",
        help="成交明细 CSV 路径",
    )
    p.add_argument("--no-csv", action="store_true", help="不写 CSV")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    bar_minutes = timeframe_minutes(args.tf)
    dates = list_available_dates(bar_minutes=bar_minutes)

    overrides = {
        "session_start_hour": args.hour_start,
        "session_end_hour": args.hour_end,
        "min_range_usd": args.min_range,
        "max_range_usd": args.max_range,
        "min_range_atr": args.min_range_atr,
        "max_range_atr": args.max_range_atr,
        "max_adx": args.max_adx,
        "max_efficiency_ratio": args.max_er,
        "lots": args.lots,
    }
    if args.donchian is not None:
        overrides["donchian_period"] = args.donchian

    params = RangeReversionParams.for_bar_minutes(bar_minutes, **overrides)
    start = args.start or (dates[0] if dates else None)
    end = args.end or (dates[-1] if dates else None)

    trades, summary = run_backtest(start, end, params)
    print(format_summary(summary))

    if not args.no_csv and not trades.empty:
        out = ROOT / args.out
        out.parent.mkdir(parents=True, exist_ok=True)
        trades.to_csv(out, index=False)
        print(f"\n成交明细: {out}")

    sessions_out = ROOT / "report/range_reversion_sessions.csv"
    if not args.no_csv and not summary["sessions_df"].empty:
        summary["sessions_df"].to_csv(sessions_out, index=False)
        print(f"时段汇总: {sessions_out}")


if __name__ == "__main__":
    main()
