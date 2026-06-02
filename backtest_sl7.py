#!/usr/bin/env python3
"""薄 CLI：交割单 M5 回测（核心在 src.engine）。"""

from pathlib import Path

import pandas as pd

from src.core.config import get_paths
from src.core.statement import parse_statement
from src.engine.simulator import (
    RECOMMENDED_SL,
    RECOMMENDED_TP,
    LADDER_TP,
    SL_POINTS,
    run_all_simulations,
    simulate_trade,
)

ROOT = get_paths()["root"]
STATEMENT = get_paths()["statement"]

# 兼容旧 import
from src.core.m5 import load_m5_range  # noqa: E402
from src.core.statement import load_orig_exit_tags, orig_exit_label  # noqa: E402

__all__ = [
    "ROOT",
    "STATEMENT",
    "RECOMMENDED_SL",
    "RECOMMENDED_TP",
    "LADDER_TP",
    "SL_POINTS",
    "parse_statement",
    "load_m5_range",
    "load_orig_exit_tags",
    "orig_exit_label",
    "simulate_trade",
    "run_all_simulations",
]


def print_summary(comp: pd.DataFrame, trades: pd.DataFrame) -> None:
    orig = comp["orig_net"].sum()
    sl5 = comp["sl5_origtp_net"].sum()
    tp20 = comp["sl5_tp20_net"].sum()
    ladder = comp["sl5_ladder_net"].sum()

    print(f"已解析市价平仓单: {len(comp)} 笔")
    print(f"原交割单净利:     {orig:>10.2f} USD")
    print(f"优化1 SL=5(原TP): {sl5:>10.2f} USD  (Δ {sl5 - orig:+.2f})")
    print(f"优化1+2 SL5+TP20: {tp20:>10.2f} USD  (Δ {tp20 - orig:+.2f})")
    print(f"优化1+2 阶梯TP:   {ladder:>10.2f} USD  (Δ {ladder - orig:+.2f})")
    print()

    for label, exit_col, net_col in [
        ("SL5+原TP", "sl5_origtp_exit", "sl5_origtp_net"),
        ("SL5+TP20", "sl5_tp20_exit", "sl5_tp20_net"),
    ]:
        print(f"--- {label} 出场分布 ---")
        g = comp.groupby(exit_col).agg(n=("ticket", "count"), net=(net_col, "sum"))
        print(g.to_string())
        print()

    print("--- TP 参数扫描 (SL=5) ---")
    for tp in [10, 15, 20, 25, 30]:
        nets = [
            simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=tp)["sim_net"]
            for _, tr in trades.iterrows()
        ]
        wr = sum(1 for n in nets if n > 0) / len(nets)
        print(f"  TP={tp:2d}: 净利 {sum(nets):8.0f}  胜率 {wr:.1%}")

    print()
    print("--- SL 参数扫描 (保留原TP) ---")
    for sl in [3, 4, 5, 6, 7]:
        nets = [
            simulate_trade(tr, sl_pts=sl, use_orig_tp=True)["sim_net"]
            for _, tr in trades.iterrows()
        ]
        print(f"  SL={sl}: 净利 {sum(nets):8.0f}")


def main():
    trades = parse_statement(STATEMENT)
    comp = run_all_simulations(trades)
    print_summary(comp, trades)

    out = ROOT / "backtest_comparison.csv"
    comp.to_csv(out, index=False)
    print(f"\n逐笔对比已写入 {out}")

    sweep = []
    for sl in [4, 5, 6]:
        for tp in [15, 20, 25]:
            net = sum(
                simulate_trade(tr, sl_pts=sl, tp_pts=tp)["sim_net"]
                for _, tr in trades.iterrows()
            )
            sweep.append({"sl": sl, "tp": tp, "net": net})
    pd.DataFrame(sweep).to_csv(ROOT / "backtest_sl_tp_sweep.csv", index=False)
    print("SL×TP 扫描已写入 backtest_sl_tp_sweep.csv")


if __name__ == "__main__":
    main()
