#!/usr/bin/env python3
"""
最新策略回测对比：
  - 市价单：SL5 + TP20（三单同组用阶梯 TP 10/20/30）
  - 挂单：限价向市价近 2 点，原挂单窗口内触及成交 → SL5 + 阶梯/固定 TP
  - 对比：原交割单 / 仅优化市价 / 完整最新策略
"""

from pathlib import Path

import pandas as pd

from analyze_limits import (
    adjusted_limit_price,
    analyze_bar_fill,
    parse_cancelled_limits,
    simulate_filled_trade,
)
from backtest_sl7 import (
    LADDER_TP,
    RECOMMENDED_SL,
    RECOMMENDED_TP,
    ROOT,
    STATEMENT,
    assign_ladder_tp,
    load_orig_exit_tags,
    orig_exit_label,
    parse_statement,
    run_all_simulations,
    simulate_trade,
)
from tz_config import statement_to_m5_time

OUTPUT_COMPARISON = ROOT / "backtest_latest_comparison.csv"
OUTPUT_LIMITS = ROOT / "backtest_latest_limits.csv"

# 最新策略参数
LIMIT_OFFSET_PTS = 2.0
USE_LADDER_ON_MARKET = True
USE_LADDER_ON_LIMITS = True


def simulate_market_latest(trades: pd.DataFrame) -> pd.DataFrame:
    """市价单：SL5 + TP20；同分钟同向三单用阶梯 TP。"""
    sl_t, tp_t = load_orig_exit_tags()
    ladder = assign_ladder_tp(trades) if USE_LADDER_ON_MARKET else None

    rows = []
    for idx, tr in trades.iterrows():
        tp_pts = (
            float(ladder[idx])
            if USE_LADDER_ON_MARKET and ladder is not None
            else RECOMMENDED_TP
        )
        sim = simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=tp_pts)
        orig_net = tr["profit"] + tr["commission"] + tr["swap"]
        rows.append(
            {
                "ticket": str(tr["ticket"]),
                "source": "market",
                "direction": tr["type"],
                "open_time": tr["open_time"],
                "entry": tr["open_price"],
                "tp_pts_used": tp_pts,
                "orig_net": orig_net,
                "latest_net": sim["sim_net"],
                "latest_exit": sim["exit_reason"],
                "delta": sim["sim_net"] - orig_net,
                "orig_exit": orig_exit_label(tr["ticket"], sl_t, tp_t),
            }
        )
    return pd.DataFrame(rows)


def simulate_limits_latest(
    limits: pd.DataFrame,
    offset: float = LIMIT_OFFSET_PTS,
) -> pd.DataFrame:
    """取消挂单：近 offset 点成交后 SL5+TP（三单阶梯）。"""
    limits = limits.copy()
    limits["open_min"] = limits["open_dt"].dt.floor("min")
    limits["grp"] = limits.groupby(["open_min", "side"]).ngroup()

    # 组内排序分配阶梯 TP
    limits["tp_pts"] = RECOMMENDED_TP
    if USE_LADDER_ON_LIMITS:
        for _, g in limits.groupby("grp"):
            g = g.sort_values(
                "limit_price",
                ascending=(g.iloc[0]["side"] == "sell"),
            )
            for i, idx in enumerate(g.index):
                limits.loc[idx, "tp_pts"] = LADDER_TP[min(i, len(LADDER_TP) - 1)]

    rows = []
    for i, r in limits.iterrows():
        if i > 0 and i % 150 == 0:
            print(f"  挂单 {i}/{len(limits)}…")

        open_m5 = statement_to_m5_time(r["open_dt"])
        close_m5 = (
            statement_to_m5_time(r["close_dt"])
            if pd.notna(r["close_dt"])
            else open_m5 + pd.Timedelta(hours=12)
        )
        from backtest_sl7 import load_m5_range

        bars = load_m5_range(open_m5, close_m5)
        adj_px = adjusted_limit_price(r["side"], r["limit_price"], offset)
        filled, fill_px, fill_t = analyze_bar_fill(
            r["side"], adj_px, open_m5, close_m5, bars
        )

        orig_net = 0.0  # 取消挂单原盈亏为 0
        if filled and fill_t is not None:
            sim = simulate_filled_trade(
                r["side"],
                fill_px,
                fill_t,
                r["size"] or 0.01,
                sl_pts=RECOMMENDED_SL,
                tp_pts=float(r["tp_pts"]),
            )
            latest_net = sim["net"]
            latest_exit = sim["exit_reason"]
        else:
            latest_net = 0.0
            latest_exit = "no_fill"

        rows.append(
            {
                "ticket": r["ticket"],
                "source": "limit",
                "direction": r["side"],
                "open_time": r["open_time"],
                "entry": adj_px if filled else r["limit_price"],
                "limit_offset": offset,
                "filled": filled,
                "tp_pts_used": r["tp_pts"] if filled else None,
                "orig_net": orig_net,
                "latest_net": latest_net,
                "latest_exit": latest_exit,
                "delta": latest_net - orig_net,
            }
        )
    return pd.DataFrame(rows)


def build_summary(
    market: pd.DataFrame,
    limits: pd.DataFrame,
    limits_offset1: pd.DataFrame | None = None,
) -> pd.DataFrame:
    m_orig = market["orig_net"].sum()
    m_latest = market["latest_net"].sum()
    l_filled = limits[limits["filled"]]
    l_latest = limits["latest_net"].sum()

    rows = [
        {
            "strategy": "原交割单（市价成交）",
            "trades": len(market),
            "total_net_usd": round(m_orig, 2),
            "win_rate_pct": round(100 * (market["orig_net"] > 0).mean(), 1),
            "note": "挂单取消不计入",
        },
        {
            "strategy": "原交割单（市价+挂单记录）",
            "trades": len(market) + len(limits),
            "total_net_usd": round(m_orig, 2),
            "win_rate_pct": None,
            "note": "687 笔取消挂单原盈亏≈0",
        },
        {
            "strategy": "最新-仅市价 SL5+TP(阶梯)",
            "trades": len(market),
            "total_net_usd": round(m_latest, 2),
            "win_rate_pct": round(100 * (market["latest_net"] > 0).mean(), 1),
            "note": f"SL={RECOMMENDED_SL} TP阶梯{LADDER_TP}",
        },
        {
            "strategy": f"最新-仅挂单 近{LIMIT_OFFSET_PTS}点成交+SL5+TP",
            "trades": len(l_filled),
            "total_net_usd": round(l_latest, 2),
            "win_rate_pct": round(100 * (l_filled["latest_net"] > 0).mean(), 1)
            if len(l_filled)
            else None,
            "note": f"可成交 {len(l_filled)}/{len(limits)}",
        },
        {
            "strategy": f"最新-合并 市价+挂单(近{LIMIT_OFFSET_PTS}点)",
            "trades": len(market) + len(l_filled),
            "total_net_usd": round(m_latest + l_latest, 2),
            "win_rate_pct": None,
            "note": "市价全回放+挂单模拟成交",
        },
    ]

    if limits_offset1 is not None:
        l1 = limits_offset1[limits_offset1["filled"]]
        rows.insert(
            -1,
            {
                "strategy": "最新-仅挂单 近1点成交+SL5+TP",
                "trades": len(l1),
                "total_net_usd": round(l1["latest_net"].sum(), 2),
                "win_rate_pct": round(100 * (l1["latest_net"] > 0).mean(), 1)
                if len(l1)
                else None,
                "note": f"可成交 {len(l1)}/{len(limits_offset1)}",
            },
        )

    # 固定 TP20 市价（无阶梯）作参照
    return pd.DataFrame(rows)


def main():
    print("=" * 60)
    print("最新策略参数")
    print(f"  止损: {RECOMMENDED_SL} 点（从成交价计，不随挂单近点而加到7）")
    print(f"  市价止盈: 阶梯 {LADDER_TP} 点（同组三单）")
    print(f"  挂单: 限价近 {LIMIT_OFFSET_PTS} 点成交，止损仍 {RECOMMENDED_SL} 点")
    print("=" * 60)

    trades = parse_statement(STATEMENT)
    limits = parse_cancelled_limits(STATEMENT)

    print("\n[1/3] 市价单回测…")
    market = simulate_market_latest(trades)

    print("\n[2/3] 挂单回测（近 2 点）…")
    limits2 = simulate_limits_latest(limits, offset=LIMIT_OFFSET_PTS)

    print("\n[3/3] 挂单回测（近 1 点，对照）…")
    limits1 = simulate_limits_latest(limits, offset=1.0)

    summary = build_summary(market, limits2, limits1)

    # 合并明细
    all_detail = pd.concat([market, limits2], ignore_index=True)
    all_detail.to_csv(OUTPUT_COMPARISON, index=False)
    limits2.to_csv(OUTPUT_LIMITS, index=False)
    summary.to_csv(ROOT / "backtest_latest_summary.csv", index=False)

    print("\n" + "=" * 60)
    print("回测对比汇总")
    print("=" * 60)
    print(summary.to_string(index=False))

    m_orig = market["orig_net"].sum()
    m_lat = market["latest_net"].sum()
    l2 = limits2[limits2["filled"]]
    combined = m_lat + l2["latest_net"].sum()

    print("\n--- 关键差额 ---")
    print(f"市价：原 {m_orig:.2f} → 最新 {m_lat:.2f}  (Δ {m_lat - m_orig:+.2f})")
    print(
        f"挂单：原 ~0 → 最新(近2点成交{l2.shape[0]}笔) {l2['latest_net'].sum():.2f}"
    )
    print(f"合并最新策略总净利（模拟）: {combined:.2f} USD")
    print(f"较原市价策略提升: {combined - m_orig:+.2f} USD")

    print("\n--- 市价：阶梯 TP vs 统一 TP20 ---")
    flat20 = sum(
        simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=RECOMMENDED_TP)["sim_net"]
        for _, tr in trades.iterrows()
    )
    print(f"  统一 TP20: {flat20:.2f}")
    print(f"  阶梯 TP:   {m_lat:.2f}")

    print(f"\n明细: {OUTPUT_COMPARISON}")
    print(f"汇总: {ROOT / 'backtest_latest_summary.csv'}")


if __name__ == "__main__":
    main()
