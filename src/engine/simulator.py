"""M5 逐 bar 模拟成交。"""

import pandas as pd

from src.core.config import strategy_defaults
from src.core.m5 import load_m5_range
from src.core.statement import load_orig_exit_tags, orig_exit_label, parse_statement
from src.core.timezone import statement_to_m5_time

_defaults = strategy_defaults()
RECOMMENDED_SL = _defaults["sl"]
RECOMMENDED_TP = _defaults["tp"]
SL_POINTS = RECOMMENDED_SL
LADDER_TP = _defaults["ladder_tp"]


def profit_usd(direction: str, entry: float, exit_px: float, lots: float) -> float:
    mult = lots / 0.01
    if direction == "buy":
        return (exit_px - entry) * mult
    return (entry - exit_px) * mult


def sl_price(direction: str, entry: float, sl_pts: float) -> float:
    if direction == "buy":
        return entry - sl_pts
    return entry + sl_pts


def tp_price(direction: str, entry: float, tp_pts: float) -> float:
    if direction == "buy":
        return entry + tp_pts
    return entry - tp_pts


def assign_ladder_tp(trades: pd.DataFrame) -> pd.Series:
    df = trades.copy()
    df["ticket"] = df["ticket"].astype(str)
    df["open_min"] = df["open_dt"].dt.floor("min")
    df["grp"] = df.groupby(["open_min", "type"]).ngroup()

    out = pd.Series(index=df.index, dtype=float)
    ladder = list(LADDER_TP)

    for _, g in df.groupby("grp"):
        g = g.sort_values(
            "open_price",
            ascending=(g.iloc[0]["type"] == "sell"),
        )
        for i, idx in enumerate(g.index):
            out[idx] = ladder[min(i, len(ladder) - 1)]
    return out


def simulate_trade(
    trade: pd.Series,
    sl_pts: float = RECOMMENDED_SL,
    tp_pts: float | None = None,
    use_orig_tp: bool = False,
) -> dict:
    direction = trade["type"]
    entry = trade["open_price"]
    lots = trade["size"]
    open_dt = statement_to_m5_time(trade["open_dt"])
    orig_close_dt = statement_to_m5_time(trade["close_dt"])

    sl_px = sl_price(direction, entry, sl_pts)

    tp_px = None
    if tp_pts is not None:
        tp_px = tp_price(direction, entry, tp_pts)
    elif use_orig_tp and trade["orig_tp"] > 0:
        tp_px = trade["orig_tp"]

    bars = load_m5_range(open_dt, orig_close_dt)
    exit_px = None
    exit_reason = None
    exit_dt = None

    for _, bar in bars.iterrows():
        t = bar["timestamps"]
        if t < open_dt:
            continue
        hi, lo = bar["high"], bar["low"]

        if direction == "buy":
            sl_hit = lo <= sl_px
            tp_hit = tp_px is not None and hi >= tp_px
        else:
            sl_hit = hi >= sl_px
            tp_hit = tp_px is not None and lo <= tp_px

        if sl_hit and tp_hit:
            sl_hit, tp_hit = True, False
        if sl_hit:
            exit_px, exit_reason, exit_dt = sl_px, "sl", t
            break
        if tp_hit:
            exit_px, exit_reason, exit_dt = tp_px, "tp", t
            break

    if exit_px is None:
        exit_px = trade["close_price"]
        exit_reason = "time"
        exit_dt = orig_close_dt

    gross = profit_usd(direction, entry, exit_px, lots)
    net = gross + trade["commission"] + trade["swap"]
    orig_net = trade["profit"] + trade["commission"] + trade["swap"]

    return {
        "ticket": str(trade["ticket"]),
        "direction": direction,
        "entry": entry,
        "sl_pts": sl_pts,
        "tp_pts": tp_pts,
        "new_sl": sl_px,
        "new_tp": tp_px,
        "exit_px": exit_px,
        "exit_reason": exit_reason,
        "exit_dt": exit_dt,
        "sim_profit": gross,
        "sim_net": net,
        "orig_profit": trade["profit"],
        "orig_net": orig_net,
        "delta": net - orig_net,
    }


def run_all_simulations(trades: pd.DataFrame) -> pd.DataFrame:
    sl_t, tp_t = load_orig_exit_tags()
    ladder_tp = assign_ladder_tp(trades)

    rows = []
    for idx, tr in trades.iterrows():
        orig_net = tr["profit"] + tr["commission"] + tr["swap"]
        s_sl5_origtp = simulate_trade(tr, sl_pts=RECOMMENDED_SL, use_orig_tp=True)
        s_sl5_tp20 = simulate_trade(tr, sl_pts=RECOMMENDED_SL, tp_pts=RECOMMENDED_TP)
        s_sl5_ladder = simulate_trade(
            tr, sl_pts=RECOMMENDED_SL, tp_pts=float(ladder_tp[idx])
        )
        rows.append(
            {
                "ticket": str(tr["ticket"]),
                "direction": tr["type"],
                "open_time": tr["open_time"],
                "close_time": tr["close_time"],
                "entry": tr["open_price"],
                "orig_sl": tr["orig_sl"],
                "orig_tp": tr["orig_tp"] if tr["orig_tp"] > 0 else None,
                "orig_close": tr["close_price"],
                "orig_net": orig_net,
                "orig_exit": orig_exit_label(tr["ticket"], sl_t, tp_t),
                "sl5_origtp_net": s_sl5_origtp["sim_net"],
                "sl5_origtp_exit": s_sl5_origtp["exit_reason"],
                "sl5_origtp_delta": s_sl5_origtp["delta"],
                "sl5_tp20_net": s_sl5_tp20["sim_net"],
                "sl5_tp20_exit": s_sl5_tp20["exit_reason"],
                "sl5_tp20_delta": s_sl5_tp20["delta"],
                "sl5_ladder_tp_pts": ladder_tp[idx],
                "sl5_ladder_net": s_sl5_ladder["sim_net"],
                "sl5_ladder_delta": s_sl5_ladder["delta"],
                "suggested_sl": s_sl5_tp20["new_sl"],
                "suggested_tp": s_sl5_tp20["new_tp"],
            }
        )
    return pd.DataFrame(rows)
