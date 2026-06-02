#!/usr/bin/env python3
"""生成报告：市价 SL5+TP20 + 挂单近2点成交+SL5+TP20。"""

from datetime import datetime
from pathlib import Path

import pandas as pd

from analyze_limits import (
    adjusted_limit_price,
    analyze_bar_fill,
    parse_cancelled_limits,
    simulate_filled_trade,
)
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
    sl_price,
    tp_price,
)
from tz_config import statement_to_m5_time

REPORT_DIR = ROOT / "report"
SL = RECOMMENDED_SL
TP = RECOMMENDED_TP
LIMIT_OFFSET = 2.0


def build_market_trades() -> pd.DataFrame:
    trades = parse_statement(STATEMENT)
    sl_t, tp_t = load_orig_exit_tags()
    rows = []
    for _, tr in trades.iterrows():
        sim = simulate_trade(tr, sl_pts=SL, tp_pts=TP)
        orig_net = tr["profit"] + tr["commission"] + tr["swap"]
        rows.append(
            {
                "ticket": str(tr["ticket"]),
                "source": "market",
                "direction": tr["type"],
                "open_time": tr["open_time"],
                "close_time": tr["close_time"],
                "open_dt": tr["open_dt"],
                "entry": tr["open_price"],
                "exit_px": sim["exit_px"],
                "sl_price": sim["new_sl"],
                "tp_price": sim["new_tp"],
                "size": tr["size"],
                "orig_net": orig_net,
                "sim_net": sim["sim_net"],
                "delta": sim["sim_net"] - orig_net,
                "exit_reason": sim["exit_reason"],
                "orig_exit": orig_exit_label(tr["ticket"], sl_t, tp_t),
                "hold_min": (tr["close_dt"] - tr["open_dt"]).total_seconds() / 60,
            }
        )
    return pd.DataFrame(rows)


def build_limit_trades() -> pd.DataFrame:
    limits = parse_cancelled_limits(STATEMENT)
    rows = []
    for i, r in limits.iterrows():
        if i > 0 and i % 200 == 0:
            print(f"  挂单 {i}/{len(limits)}…")
        open_m5 = statement_to_m5_time(r["open_dt"])
        close_m5 = (
            statement_to_m5_time(r["close_dt"])
            if pd.notna(r["close_dt"])
            else open_m5 + pd.Timedelta(hours=12)
        )
        bars = load_m5_range(open_m5, close_m5)
        orig_limit = r["limit_price"]
        adj_limit = adjusted_limit_price(r["side"], orig_limit, LIMIT_OFFSET)
        filled, fill_px, fill_t = analyze_bar_fill(
            r["side"], adj_limit, open_m5, close_m5, bars
        )

        if filled and fill_t is not None:
            sim = simulate_filled_trade(
                r["side"], fill_px, fill_t, r["size"] or 0.01, sl_pts=SL, tp_pts=TP
            )
            sim_net = sim["net"]
            exit_reason = sim["exit_reason"]
            exit_px = sim["exit_px"]
            entry = fill_px
            fill_time = fill_t
        else:
            sim_net = 0.0
            exit_reason = "no_fill"
            exit_px = None
            entry = adj_limit
            fill_time = pd.NaT

        rows.append(
            {
                "ticket": r["ticket"],
                "source": "limit",
                "direction": r["side"],
                "open_time": r["open_time"],
                "close_time": r["close_time"],
                "open_dt": r["open_dt"],
                "orig_limit_price": orig_limit,
                "entry": entry,
                "limit_offset": LIMIT_OFFSET,
                "filled": filled,
                "fill_time_m5": fill_time,
                "exit_px": exit_px,
                "sl_price": sl_price(r["side"], entry, SL) if filled else None,
                "tp_price": tp_price(r["side"], entry, TP) if filled else None,
                "size": r["size"] or 0.01,
                "orig_net": 0.0,
                "sim_net": sim_net,
                "delta": sim_net,
                "exit_reason": exit_reason,
                "hold_hours": r["hold_hours"],
            }
        )
    return pd.DataFrame(rows)


def equity_stats(net_series: pd.Series) -> dict:
    cum = net_series.cumsum()
    peak = cum.cummax()
    dd = cum - peak
    return {
        "total_net": net_series.sum(),
        "trades": len(net_series),
        "wins": (net_series > 0).sum(),
        "losses": (net_series <= 0).sum(),
        "win_rate_pct": 100 * (net_series > 0).mean() if len(net_series) else 0,
        "avg_win": net_series[net_series > 0].mean() if (net_series > 0).any() else 0,
        "avg_loss": net_series[net_series <= 0].mean() if (net_series <= 0).any() else 0,
        "max_win": net_series.max(),
        "max_loss": net_series.min(),
        "max_drawdown": dd.min(),
        "profit_factor": abs(net_series[net_series > 0].sum() / net_series[net_series < 0].sum())
        if (net_series < 0).any() and net_series[net_series < 0].sum() != 0
        else None,
    }


def monthly_pnl(df: pd.DataFrame, dt_col: str = "open_dt") -> pd.DataFrame:
    d = df.copy()
    d["month"] = pd.to_datetime(d[dt_col]).dt.to_period("M").astype(str)
    return (
        d.groupby("month")
        .agg(trades=("sim_net", "count"), net=("sim_net", "sum"), wins=("sim_net", lambda x: (x > 0).sum()))
        .assign(win_rate=lambda x: (100 * x["wins"] / x["trades"]).round(1))
    )


def write_report(
    market: pd.DataFrame,
    limits: pd.DataFrame,
    filled: pd.DataFrame,
) -> Path:
    REPORT_DIR.mkdir(exist_ok=True)
    market = market.assign(segment="市价")
    filled = filled.assign(segment="挂单")
    combined = pd.concat([market, filled], ignore_index=True)
    combined_sorted = combined.sort_values("open_dt")
    combined_sorted["cum_net"] = combined_sorted["sim_net"].cumsum()

    m_stats = equity_stats(market["sim_net"])
    f_stats = equity_stats(filled["sim_net"]) if len(filled) else {}
    c_stats = equity_stats(combined_sorted["sim_net"])

    orig_market = market["orig_net"].sum()
    m_exit = market.groupby("exit_reason")["sim_net"].agg(["count", "sum"])
    m_dir = market.groupby("direction")["sim_net"].agg(["count", "sum"])
    m_month = monthly_pnl(market)

    fill_rate = limits["filled"].mean() * 100
    lim_near = limits.copy()
    # min_gap from prior analysis if exists
    gap_csv = ROOT / "limit_orders_analysis.csv"
    if gap_csv.exists():
        g = pd.read_csv(gap_csv)[["ticket", "min_gap_pts", "near_miss_2pt"]]
        g["ticket"] = g["ticket"].astype(str)
        limits["ticket"] = limits["ticket"].astype(str)
        lim_near = limits.merge(g, on="ticket", how="left")

    lines = [
        "# 策略回测详细报告",
        "",
        f"**生成时间**：{datetime.now().strftime('%Y-%m-%d %H:%M')}  ",
        f"**数据**：Statement.htm + Files/ M5（经纪商 UTC+3 → M5 UTC）",
        "",
        "---",
        "",
        "## 1. 策略定义",
        "",
        "| 项目 | 规则 |",
        "|------|------|",
        f"| 止损 SL | **{SL:.0f} 点**（从成交价计；挂单近 2 点不改为 7） |",
        f"| 止盈 TP | **{TP:.0f} 点**（市价、挂单成交后相同） |",
        f"| 市价单 | 622 笔已成交市价，按 SL+TP 重放 |",
        f"| 挂单 | 687 笔原取消限价单，限价**近 {LIMIT_OFFSET:.0f} 点**后在原挂单窗口内 M5 触及即成交 |",
        "| 同 K 线 | SL 与 TP 同时触及 → **先 SL**（保守） |",
        "| 未含 | 滑点、拒单、库存费变化 |",
        "",
        "---",
        "",
        "## 2. 执行摘要",
        "",
        "| 指标 | 原交割单(市价) | 本策略 | 变化 |",
        "|------|----------------|--------|------|",
        f"| 市价部分净利 | {orig_market:.2f} | {m_stats['total_net']:.2f} | {m_stats['total_net']-orig_market:+.2f} |",
        f"| 挂单部分净利 | 0.00 | {f_stats.get('total_net', 0):.2f} | +{f_stats.get('total_net', 0):.2f} |",
        f"| **合计** | **{orig_market:.2f}** | **{c_stats['total_net']:.2f}** | **{c_stats['total_net']-orig_market:+.2f}** |",
        "",
        f"- 有效交易笔数：**{c_stats['trades']}**（市价 {m_stats['trades']} + 挂单成交 {len(filled)}）",
        f"- 挂单成交率：**{fill_rate:.1f}%**（{len(filled)}/{len(limits)}）",
        f"- 合并胜率：**{c_stats['win_rate_pct']:.1f}%**",
        f"- 合并最大回撤：**{c_stats['max_drawdown']:.2f} USD**",
        f"- 盈亏比（Profit Factor）：**{c_stats['profit_factor']:.2f}**"
        if c_stats["profit_factor"]
        else "- 盈亏比：—",
        "",
        "---",
        "",
        "## 3. 市价单（SL5 + TP20）",
        "",
        "### 3.1 总览",
        "",
        f"| 指标 | 数值 |",
        f"|------|------|",
        f"| 笔数 | {m_stats['trades']} |",
        f"| 总净利 | {m_stats['total_net']:.2f} USD |",
        f"| 胜率 | {m_stats['win_rate_pct']:.1f}% |",
        f"| 盈利笔 / 亏损笔 | {m_stats['wins']} / {m_stats['losses']} |",
        f"| 平均盈利 | {m_stats['avg_win']:.2f} USD |",
        f"| 平均亏损 | {m_stats['avg_loss']:.2f} USD |",
        f"| 最大单笔盈/亏 | {m_stats['max_win']:.2f} / {m_stats['max_loss']:.2f} |",
        f"| 最大回撤 | {m_stats['max_drawdown']:.2f} USD |",
        "",
        "### 3.2 出场原因",
        "",
        "| 出场 | 笔数 | 净利 USD |",
        "|------|------|----------|",
    ]
    for reason, row in m_exit.iterrows():
        lines.append(f"| {reason} | {int(row['count'])} | {row['sum']:.2f} |")

    lines.extend(
        [
            "",
            "### 3.3 方向",
            "",
            "| 方向 | 笔数 | 净利 USD |",
            "|------|------|----------|",
        ]
    )
    for d, row in m_dir.iterrows():
        lines.append(f"| {d} | {int(row['count'])} | {row['sum']:.2f} |")

    lines.extend(["", "### 3.4 按月净利（市价）", "", "| 月份 | 笔数 | 净利 | 胜率% |", "|------|------|------|-------|"])
    for month, row in m_month.iterrows():
        lines.append(f"| {month} | {int(row['trades'])} | {row['net']:.2f} | {row['win_rate']} |")

    lines.extend(
        [
            "",
            "### 3.5 原出场 → 模拟出场（市价）",
            "",
        ]
    )
    cross = pd.crosstab(market["orig_exit"], market["exit_reason"], margins=True)
    lines.append("```")
    lines.append(cross.to_string())
    lines.append("```")

    if len(filled):
        lines.extend(
            [
                "",
                "---",
                "",
                "## 4. 挂单（近 2 点 + SL5 + TP20）",
                "",
                f"| 指标 | 数值 |",
                f"|------|------|",
                f"| 原取消挂单 | {len(limits)} |",
                f"| 模拟成交 | {len(filled)} ({fill_rate:.1f}%) |",
                f"| 成交部分净利 | {f_stats['total_net']:.2f} USD |",
                f"| 成交部分胜率 | {f_stats['win_rate_pct']:.1f}% |",
                f"| 平均单笔（成交） | {f_stats['total_net']/len(filled):.2f} USD |",
                "",
                "### 4.1 成交单出场原因",
                "",
            ]
        )
        f_exit = filled.groupby("exit_reason")["sim_net"].agg(["count", "sum"])
        lines.append("| 出场 | 笔数 | 净利 |")
        lines.append("|------|------|------|")
        for reason, row in f_exit.iterrows():
            lines.append(f"| {reason} | {int(row['count'])} | {row['sum']:.2f} |")

        if "min_gap_pts" in lim_near.columns:
            nm2 = lim_near["near_miss_2pt"].sum()
            lines.extend(
                [
                    "",
                    "### 4.2 踏空结构（原挂单）",
                    "",
                    f"- 近距踏空 (0,2] 点未成交：**{int(nm2)}** 笔",
                    f"- 本策略通过近 **{LIMIT_OFFSET:.0f} 点** 额外成交 **{len(filled)}** 笔",
                ]
            )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 5. 合并账户曲线",
            "",
            f"| 指标 | 数值 |",
            f"|------|------|",
            f"| 累计净利终点 | {c_stats['total_net']:.2f} USD |",
            f"| 最大回撤 | {c_stats['max_drawdown']:.2f} USD |",
            f"| 胜率 | {c_stats['win_rate_pct']:.1f}% |",
            "",
            "按时间排序的累计净利见 `report/equity_curve.csv`。",
            "",
            "---",
            "",
            "## 6. 极值交易（合并）",
            "",
            "### 6.1 模拟盈利 Top 10",
            "",
        ]
    )
    top = combined.nlargest(10, "sim_net")[
        ["ticket", "segment", "direction", "open_time", "sim_net", "exit_reason"]
    ]
    lines.append("| Ticket | 类型 | 方向 | 开仓 | 净利 | 出场 |")
    lines.append("|--------|------|------|------|------|------|")
    for _, r in top.iterrows():
        lines.append(
            f"| {r['ticket']} | {r['segment']} | {r['direction']} | {r['open_time']} | {r['sim_net']:.2f} | {r['exit_reason']} |"
        )

    lines.extend(["", "### 6.2 模拟亏损 Top 10", ""])
    bot = combined.nsmallest(10, "sim_net")[
        ["ticket", "segment", "direction", "open_time", "sim_net", "exit_reason"]
    ]
    lines.append("| Ticket | 类型 | 方向 | 开仓 | 净利 | 出场 |")
    lines.append("|--------|------|------|------|------|------|")
    for _, r in bot.iterrows():
        lines.append(
            f"| {r['ticket']} | {r['segment']} | {r['direction']} | {r['open_time']} | {r['sim_net']:.2f} | {r['exit_reason']} |"
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 7. 风险与局限",
            "",
            "1. **样本内优化**：参数 SL5/TP20/近2点 均基于同一段历史。",
            "2. **挂单成交**：M5 触及挂单价即视为成交，实盘可能因点差、排队未成交。",
            "3. **与实盘差异**：原 622 笔市价被整体重放，不是「只改未平仓单」。",
            "4. **加仓**：同分钟多笔市价仍分别模拟，未限制组内总风险。",
            "5. **冬夏令时**：时区按 UTC+3 固定，换季需复核。",
            "",
            "---",
            "",
            "## 8. 附件",
            "",
            "| 文件 | 说明 |",
            "|------|------|",
            "| `report/market_trades.csv` | 市价逐笔 |",
            "| `report/limit_trades.csv` | 挂单逐笔 |",
            "| `report/combined_trades.csv` | 合并逐笔 |",
            "| `report/equity_curve.csv` | 累计净值 |",
            "| `report/monthly_summary.csv` | 按月汇总 |",
        ]
    )

    path = REPORT_DIR / "backtest_report_SL5_TP20_limit2.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def main():
    print("构建市价交易…")
    market = build_market_trades()
    print("构建挂单交易…")
    limits = build_limit_trades()
    filled = limits[limits["filled"]].copy()

    REPORT_DIR.mkdir(exist_ok=True)
    market.to_csv(REPORT_DIR / "market_trades.csv", index=False)
    limits.to_csv(REPORT_DIR / "limit_trades.csv", index=False)
    market_out = market.assign(segment="市价")
    filled_out = filled.assign(segment="挂单")
    combined = pd.concat([market_out, filled_out], ignore_index=True).sort_values("open_dt")
    combined.to_csv(REPORT_DIR / "combined_trades.csv", index=False)
    combined["cum_net"] = combined["sim_net"].cumsum()
    combined[["open_dt", "ticket", "segment", "sim_net", "cum_net"]].to_csv(
        REPORT_DIR / "equity_curve.csv", index=False
    )

    m_month = monthly_pnl(market)
    f_month = monthly_pnl(filled) if len(filled) else pd.DataFrame()
    m_month.to_csv(REPORT_DIR / "monthly_market.csv")
    if len(f_month):
        f_month.to_csv(REPORT_DIR / "monthly_limits.csv")
    combined.groupby(combined["open_dt"].dt.to_period("M").astype(str))["sim_net"].sum().to_csv(
        REPORT_DIR / "monthly_summary.csv", header=["net"]
    )

    report_path = write_report(market, limits, filled)
    print(f"\n报告已生成: {report_path}")
    print(f"附件目录: {REPORT_DIR}/")


if __name__ == "__main__":
    main()
