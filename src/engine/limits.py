"""取消挂单分析：近距踏空、限价偏移模拟。"""

from pathlib import Path

import pandas as pd

from src.core.config import get_paths, strategy_defaults
from src.core.m5 import load_m5_range
from src.core.statement import parse_cancelled_limits
from src.core.timezone import statement_to_m5_time
from src.engine.simulator import (
    RECOMMENDED_SL,
    RECOMMENDED_TP,
    profit_usd,
    sl_price,
    tp_price,
)

_defaults = strategy_defaults()


def _gap_bucket(gap: float | None) -> str:
    if gap is None:
        return "no_data"
    if gap <= 0:
        return "touched"
    if gap <= 1:
        return "0-1"
    if gap <= 2:
        return "1-2"
    if gap <= 5:
        return "2-5"
    if gap <= 10:
        return "5-10"
    if gap <= 20:
        return "10-20"
    return ">20"


def adjusted_limit_price(side: str, limit_price: float, offset: float) -> float:
    if side == "buy":
        return limit_price + offset
    return limit_price - offset


def analyze_bar_fill(
    side: str,
    limit_px: float,
    open_m5: pd.Timestamp,
    close_m5: pd.Timestamp,
    bars: pd.DataFrame,
) -> tuple[bool, float | None, pd.Timestamp | None]:
    if bars.empty:
        return False, None, None
    for _, bar in bars.iterrows():
        t = bar["timestamps"]
        if t < open_m5:
            continue
        if t > close_m5:
            break
        if side == "buy":
            if bar["low"] <= limit_px:
                return True, limit_px, t
        else:
            if bar["high"] >= limit_px:
                return True, limit_px, t
    return False, None, None


def min_gap_during_life(side: str, limit_px: float, bars: pd.DataFrame) -> float | None:
    if bars.empty:
        return None
    if side == "buy":
        return float(bars["low"].min() - limit_px)
    return float(limit_px - bars["high"].max())


def simulate_filled_trade(
    side: str,
    entry: float,
    fill_time_m5: pd.Timestamp,
    size: float,
    sl_pts: float = RECOMMENDED_SL,
    tp_pts: float = RECOMMENDED_TP,
    max_hold_hours: float = 8.0,
) -> dict:
    direction = "buy" if side == "buy" else "sell"
    end_m5 = fill_time_m5 + pd.Timedelta(hours=max_hold_hours)
    bars = load_m5_range(fill_time_m5, end_m5)
    sl_px = sl_price(direction, entry, sl_pts)
    tp_px = tp_price(direction, entry, tp_pts)
    commission = -0.18

    for _, bar in bars.iterrows():
        t = bar["timestamps"]
        if t < fill_time_m5:
            continue
        hi, lo = bar["high"], bar["low"]
        if direction == "buy":
            sl_hit = lo <= sl_px
            tp_hit = hi >= tp_px
        else:
            sl_hit = hi >= sl_px
            tp_hit = lo <= tp_px
        if sl_hit and tp_hit:
            sl_hit, tp_hit = True, False
        if sl_hit:
            gross = profit_usd(direction, entry, sl_px, size)
            return {"exit_reason": "sl", "net": gross + commission, "exit_px": sl_px}
        if tp_hit:
            gross = profit_usd(direction, entry, tp_px, size)
            return {"exit_reason": "tp", "net": gross + commission, "exit_px": tp_px}

    if bars.empty:
        return {"exit_reason": "no_bars", "net": 0.0, "exit_px": entry}
    last = bars.iloc[-1]
    gross = profit_usd(direction, entry, float(last["close"]), size)
    return {"exit_reason": "time", "net": gross + commission, "exit_px": float(last["close"])}


def run_analysis(
    offsets: list[float] | None = None,
    statement_path: Path | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if offsets is None:
        offsets = [0, 1, 2, 3, 5, 10]

    limits = parse_cancelled_limits(statement_path)
    limits["hold_hours"] = (limits["close_dt"] - limits["open_dt"]).dt.total_seconds() / 3600
    detail_rows = []

    for i, r in limits.iterrows():
        if i > 0 and i % 100 == 0:
            print(f"  处理挂单 {i}/{len(limits)}…")

        open_m5 = statement_to_m5_time(r["open_dt"])
        close_m5 = (
            statement_to_m5_time(r["close_dt"])
            if pd.notna(r["close_dt"])
            else open_m5 + pd.Timedelta(hours=12)
        )
        bars = load_m5_range(open_m5, close_m5)

        gap = min_gap_during_life(r["side"], r["limit_price"], bars)
        cancel_gap = (
            r["market_at_cancel"] - r["limit_price"]
            if r["side"] == "buy"
            else r["limit_price"] - r["market_at_cancel"]
        )

        row = {
            "ticket": r["ticket"],
            "type": r["type"],
            "open_time": r["open_time"],
            "close_time": r["close_time"],
            "limit_price": r["limit_price"],
            "market_at_cancel": r["market_at_cancel"],
            "hold_hours": round(r["hold_hours"], 2) if pd.notna(r["hold_hours"]) else None,
            "min_gap_pts": round(gap, 2) if gap is not None else None,
            "cancel_gap_pts": round(cancel_gap, 2),
            "near_miss_2pt": gap is not None and 0 < gap <= 2,
            "near_miss_5pt": gap is not None and 0 < gap <= 5,
            "gap_bucket": _gap_bucket(gap),
            "m5_touched_orig": gap is not None and gap <= 0,
        }

        for off in offsets:
            adj_px = adjusted_limit_price(r["side"], r["limit_price"], off)
            filled, fill_px, fill_t = analyze_bar_fill(
                r["side"], adj_px, open_m5, close_m5, bars
            )
            key = f"off{int(off)}" if off == int(off) else f"off{off}"
            row[f"fill_{key}"] = filled
            if filled and fill_t is not None:
                sim = simulate_filled_trade(r["side"], fill_px, fill_t, r["size"] or 0.01)
                row[f"net_{key}"] = round(sim["net"], 2)
                row[f"exit_{key}"] = sim["exit_reason"]
            else:
                row[f"net_{key}"] = None
                row[f"exit_{key}"] = None

        detail_rows.append(row)

    detail = pd.DataFrame(detail_rows)

    summary_rows = []
    n = len(detail)
    for off in offsets:
        key = f"off{int(off)}" if off == int(off) else f"off{off}"
        fill_col = f"fill_{key}"
        net_col = f"net_{key}"
        fills = detail[fill_col].sum()
        filled_df = detail[detail[fill_col]]
        summary_rows.append(
            {
                "offset_pts": off,
                "fills": int(fills),
                "fill_rate_pct": round(100 * fills / n, 1) if n else 0,
                "total_net_sl5_tp20": round(filled_df[net_col].sum(), 2),
                "avg_net_per_fill": round(filled_df[net_col].mean(), 2) if len(filled_df) else None,
                "win_rate_pct": round(100 * (filled_df[net_col] > 0).mean(), 1) if len(filled_df) else None,
            }
        )

    near2 = detail[detail["near_miss_2pt"]]
    summary_rows.append(
        {
            "offset_pts": "near_miss_≤2pt_count",
            "fills": len(near2),
            "fill_rate_pct": round(100 * len(near2) / n, 1) if n else 0,
            "total_net_sl5_tp20": None,
            "avg_net_per_fill": None,
            "win_rate_pct": None,
        }
    )

    return detail, pd.DataFrame(summary_rows)


def print_report(detail: pd.DataFrame, summary: pd.DataFrame) -> None:
    n = len(detail)
    print(f"取消挂单总数: {n}")
    print(f"M5 曾触及原挂单价: {detail['m5_touched_orig'].sum()} ({detail['m5_touched_orig'].mean():.1%})")
    print(f"近距踏空 (0,2] 点: {detail['near_miss_2pt'].sum()} ({detail['near_miss_2pt'].mean():.1%})")
    print(f"较近 (0,5] 点: {detail['near_miss_5pt'].sum()} ({detail['near_miss_5pt'].mean():.1%})")
    print(f"存续期最近距离中位数: {detail['min_gap_pts'].median():.2f} 点")
    print(f"撤单时距离中位数: {detail['cancel_gap_pts'].median():.2f} 点")
    print()
    print("=== 限价向市价偏移后的模拟成交 (原挂单窗口内触及即成交 + SL5+TP20) ===")
    print(summary.to_string(index=False))
