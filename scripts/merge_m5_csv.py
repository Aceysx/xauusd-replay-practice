#!/usr/bin/env python3
"""把 MT5 导出的 M5 CSV 合并进 Files/ 按日数据（自动去重，新数据优先）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.config import get_paths, timezone_config
from src.core.m5 import (
    build_timeframe_csvs_from_m5,
    list_available_dates,
    merge_m5_export_into_files,
)


def main() -> None:
    tz = timezone_config()
    ap = argparse.ArgumentParser(
        description="合并 MT5 M5 导出 CSV 到 Files/（重复时间戳默认保留新数据）"
    )
    ap.add_argument(
        "source",
        type=Path,
        nargs="?",
        default=Path.home() / "Downloads" / "XAUUSD5.csv",
        help="MT5 导出文件（默认 ~/Downloads/XAUUSD5.csv）",
    )
    ap.add_argument(
        "--files-dir",
        type=Path,
        default=None,
        help="目标目录（默认 config paths.m5_dir）",
    )
    ap.add_argument(
        "--broker-offset",
        type=int,
        default=None,
        help="导出时间为经纪商时间时，减去的 UTC 偏移小时数（默认 0=已是 UTC；"
        f"也可用 config 值 {tz['broker_utc_offset_hours']}）",
    )
    ap.add_argument(
        "--keep",
        choices=("last", "first"),
        default="last",
        help="重复时间戳保留哪一侧（默认 last=新导入）",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="只统计，不写文件",
    )
    ap.add_argument(
        "--rebuild-tf",
        action="store_true",
        help="合并后重建 15m/30m/1h/4h/1d 预聚合 CSV",
    )
    ap.add_argument(
        "--tf",
        default="15m,30m,1h,4h,1d",
        help="--rebuild-tf 时重建的周期，逗号分隔",
    )
    args = ap.parse_args()

    source = args.source.expanduser().resolve()
    if not source.is_file():
        ap.error(f"找不到导入文件: {source}")

    files_dir = args.files_dir or get_paths()["m5_dir"]
    broker_offset = args.broker_offset
    if broker_offset is None:
        broker_offset = 0

    print(f"源文件: {source}")
    print(f"目标目录: {files_dir}")
    print(f"时区偏移: -{broker_offset}h（0=导出时间已是 UTC）")
    print(f"去重策略: keep={args.keep}")
    if args.dry_run:
        print("模式: dry-run（不写盘）\n")
    else:
        print()

    stats = merge_m5_export_into_files(
        source,
        data_dir=files_dir,
        broker_offset_hours=broker_offset,
        keep=args.keep,
        dry_run=args.dry_run,
    )

    print(f"导入 K 线: {stats['source_bars']}")
    print(
        f"时间范围: {stats['source_start']} .. {stats['source_end']}"
    )
    print(f"涉及交易日: {len(stats['affected_dates'])} 个")
    print(f"  {stats['affected_dates'][0]} .. {stats['affected_dates'][-1]}")
    print(f"已有 K 线（这些文件内）: {stats['existing_bars']}")
    print(f"重复时间戳: {stats['overlap_bars']}")
    print(f"合并后 K 线: {stats['merged_bars']}")
    print(f"净增 K 线: {stats['new_bars']}")
    if args.dry_run:
        print(f"\n[dry-run] 将写入 {len(stats['written_dates'])} 个文件")
    else:
        print(f"\n已写入 {len(stats['written_dates'])} 个 M5 文件")

    if args.rebuild_tf and not args.dry_run:
        from src.core.m5 import normalize_timeframe

        tfs = [normalize_timeframe(x.strip()) for x in args.tf.split(",") if x.strip()]
        start = stats["affected_dates"][0]
        end = stats["affected_dates"][-1]
        all_dates = list_available_dates(files_dir, bar_minutes=5)
        if end not in all_dates:
            end = all_dates[-1]
        print(f"\n重建更高周期: {start} .. {end}  ({', '.join(tfs)})")
        written = build_timeframe_csvs_from_m5(
            timeframes=tfs,
            start_date=start,
            end_date=end,
            force=True,
        )
        for tf, n in written.items():
            print(f"  {tf}: {n} 个文件")
        print("更高周期 CSV 已更新。")
    elif args.rebuild_tf and args.dry_run:
        print("\n[dry-run] 跳过更高周期重建")


if __name__ == "__main__":
    main()
