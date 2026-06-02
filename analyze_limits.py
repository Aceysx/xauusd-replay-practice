#!/usr/bin/env python3
"""薄 CLI：取消挂单分析。"""

from src.core.config import get_paths
from src.engine.limits import print_report, run_analysis

ROOT = get_paths()["root"]
OUTPUT_CSV = ROOT / "limit_orders_analysis.csv"
OUTPUT_SUMMARY = ROOT / "limit_orders_summary.csv"


def main():
    print("分析取消挂单…")
    detail, summary = run_analysis()
    detail.to_csv(OUTPUT_CSV, index=False)
    summary.to_csv(OUTPUT_SUMMARY, index=False)
    print_report(detail, summary)
    print(f"\n明细: {OUTPUT_CSV}")
    print(f"汇总: {OUTPUT_SUMMARY}")


if __name__ == "__main__":
    main()
