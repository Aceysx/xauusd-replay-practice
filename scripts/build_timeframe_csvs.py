#!/usr/bin/env python3
"""从 M5 CSV 预聚合 15m / 30m / 1h / 4h / 1d，写入 Files/ 按日 CSV。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.m5 import (
    PERSISTED_TIMEFRAMES,
    build_timeframe_csvs_from_m5,
    list_available_dates,
    normalize_timeframe,
)


def main() -> None:
    ap = argparse.ArgumentParser(description="从 M5 生成并持久化更高周期 CSV")
    ap.add_argument(
        "--tf",
        default=",".join(PERSISTED_TIMEFRAMES),
        help=f"逗号分隔，默认: {','.join(PERSISTED_TIMEFRAMES)}",
    )
    ap.add_argument("--start", default=None, help="起始交易日 YYYY-MM-DD")
    ap.add_argument("--end", default=None, help="结束交易日 YYYY-MM-DD")
    ap.add_argument(
        "--force",
        action="store_true",
        help="覆盖已存在的目标 CSV",
    )
    args = ap.parse_args()

    tfs = [normalize_timeframe(x.strip()) for x in args.tf.split(",") if x.strip()]
    for tf in tfs:
        if tf not in PERSISTED_TIMEFRAMES:
            ap.error(f"不支持预聚合周期: {tf}，可选: {', '.join(PERSISTED_TIMEFRAMES)}")

    dates = list_available_dates(bar_minutes=5)
    start = args.start or dates[0]
    end = args.end or dates[-1]
    print(f"M5 源数据: {dates[0]} ~ {dates[-1]} ({len(dates)} 天)")
    print(f"聚合区间: {start} ~ {end}")
    print(f"周期: {', '.join(tfs)}  force={args.force}\n")

    written = build_timeframe_csvs_from_m5(
        timeframes=tfs,
        start_date=start,
        end_date=end,
        force=args.force,
    )
    for tf, n in written.items():
        print(f"  {tf}: 写入 {n} 个 CSV")
    print("\n完成。回放/回测将直接从对应周期 CSV 读取。")


if __name__ == "__main__":
    main()
