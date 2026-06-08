"""北京时间时段内的 Donchian + ATR 区间高抛低吸回测。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

from src.core.m5 import list_available_dates, load_ohlc_by_date_range
from src.engine.simulator import profit_usd

DEFAULT_TZ = "Asia/Shanghai"

# 指标窗口按「分钟」定义，再换算成各周期 K 线根数
LOOKBACK_MINUTES = 240
DONCHIAN_MINUTES = 180
WARMUP_MINUTES = 300
ATR_MINUTES = 70
ADX_MINUTES = 70


def _bars_for_minutes(minutes: int, bar_minutes: int) -> int:
    return max(1, round(minutes / bar_minutes))


@dataclass
class RangeReversionParams:
    """区间回归策略参数。"""

    bar_minutes: int = 1
    session_start_hour: int = 0
    session_end_hour: int = 4
    timezone: str = DEFAULT_TZ
    lookback_bars: int = 240
    donchian_period: int = 180
    atr_period: int = 70
    adx_period: int = 70
    min_range_usd: float = 5.0
    max_range_usd: float = 40.0
    min_range_atr: float = 2.0
    max_range_atr: float = 15.0
    max_adx: float = 45.0
    max_efficiency_ratio: float = 0.55
    entry_buffer_usd: float = 0.5
    sl_atr_mult: float = 0.35
    sl_min_usd: float = 3.0
    tp_target: Literal["mid", "edge_ratio"] = "mid"
    tp_edge_ratio: float = 0.55
    breakout_atr_mult: float = 0.25
    lots: float = 0.01
    one_position_at_a_time: bool = True
    warmup_bars: int = 300

    @classmethod
    def for_bar_minutes(cls, bar_minutes: int = 1, **overrides) -> RangeReversionParams:
        """按 K 线周期换算指标窗口（保持与原先 M5 版相同的实际时长）。"""
        bm = max(1, int(bar_minutes))
        defaults = {
            "bar_minutes": bm,
            "lookback_bars": _bars_for_minutes(LOOKBACK_MINUTES, bm),
            "donchian_period": _bars_for_minutes(DONCHIAN_MINUTES, bm),
            "warmup_bars": _bars_for_minutes(WARMUP_MINUTES, bm),
            "atr_period": _bars_for_minutes(ATR_MINUTES, bm),
            "adx_period": _bars_for_minutes(ADX_MINUTES, bm),
        }
        defaults.update(overrides)
        return cls(**defaults)


@dataclass
class RangeState:
    top: float
    bottom: float
    mid: float
    width: float
    atr: float
    adx: float
    efficiency_ratio: float
    valid: bool


@dataclass
class Position:
    direction: Literal["buy", "sell"]
    entry: float
    sl: float
    tp: float
    open_ts: pd.Timestamp
    range_top: float
    range_bottom: float


@dataclass
class TradeRecord:
    session_date: str
    direction: str
    entry: float
    exit_px: float
    sl: float
    tp: float
    range_top: float
    range_bottom: float
    range_width: float
    open_ts: pd.Timestamp
    close_ts: pd.Timestamp
    exit_reason: str
    gross_usd: float


def _true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    prev_close = close.shift(1)
    return pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)


def _wilder_smooth(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def compute_atr(bars: pd.DataFrame, period: int) -> float | None:
    if len(bars) < period + 1:
        return None
    tr = _true_range(bars["high"], bars["low"], bars["close"])
    atr = _wilder_smooth(tr, period)
    val = atr.iloc[-1]
    return None if pd.isna(val) else float(val)


def compute_adx(bars: pd.DataFrame, period: int) -> float | None:
    if len(bars) < period * 2:
        return None
    high = bars["high"]
    low = bars["low"]
    close = bars["close"]

    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    tr = _true_range(high, low, close)
    atr = _wilder_smooth(tr, period)
    plus_di = 100 * _wilder_smooth(pd.Series(plus_dm, index=bars.index), period) / atr
    minus_di = 100 * _wilder_smooth(pd.Series(minus_dm, index=bars.index), period) / atr
    dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
    adx = _wilder_smooth(dx, period)
    val = adx.iloc[-1]
    return None if pd.isna(val) else float(val)


def compute_efficiency_ratio(bars: pd.DataFrame, period: int) -> float | None:
    if len(bars) < period + 1:
        return None
    window = bars["close"].iloc[-period - 1 :]
    net = abs(window.iloc[-1] - window.iloc[0])
    path = window.diff().abs().sum()
    if path <= 0:
        return 1.0
    return float(net / path)


def detect_range(hist: pd.DataFrame, params: RangeReversionParams) -> RangeState | None:
    if len(hist) < max(params.lookback_bars, params.donchian_period, params.atr_period) + 1:
        return None

    window = hist.tail(params.lookback_bars)
    channel = window.tail(params.donchian_period)
    top = float(channel["high"].max())
    bottom = float(channel["low"].min())
    width = top - bottom
    mid = (top + bottom) / 2

    atr = compute_atr(window, params.atr_period)
    adx = compute_adx(window, params.adx_period)
    er = compute_efficiency_ratio(window, params.donchian_period)
    if atr is None or adx is None or er is None or atr <= 0:
        return None

    width_ok = params.min_range_usd <= width <= params.max_range_usd
    atr_ratio = width / atr
    atr_ok = params.min_range_atr <= atr_ratio <= params.max_range_atr
    regime_ok = adx <= params.max_adx and er <= params.max_efficiency_ratio
    valid = width_ok and atr_ok and regime_ok

    return RangeState(
        top=top,
        bottom=bottom,
        mid=mid,
        width=width,
        atr=atr,
        adx=adx,
        efficiency_ratio=er,
        valid=valid,
    )


def _sl_buffer(params: RangeReversionParams, atr: float) -> float:
    return max(params.sl_min_usd, params.sl_atr_mult * atr)


def _breakout_buffer(params: RangeReversionParams, atr: float) -> float:
    return params.breakout_atr_mult * atr


def _tp_price(direction: str, entry: float, rng: RangeState, params: RangeReversionParams) -> float:
    if params.tp_target == "mid":
        return rng.mid
    span = rng.top - rng.bottom
    if direction == "buy":
        return entry + span * params.tp_edge_ratio
    return entry - span * params.tp_edge_ratio


def _check_exit(pos: Position, bar: pd.Series) -> tuple[bool, float, str]:
    hi, lo = float(bar["high"]), float(bar["low"])
    if pos.direction == "buy":
        sl_hit = lo <= pos.sl
        tp_hit = hi >= pos.tp
    else:
        sl_hit = hi >= pos.sl
        tp_hit = lo <= pos.tp

    if sl_hit and tp_hit:
        return True, pos.sl, "sl"
    if sl_hit:
        return True, pos.sl, "sl"
    if tp_hit:
        return True, pos.tp, "tp"
    return False, 0.0, ""


def _try_open(
    bar: pd.Series,
    rng: RangeState,
    params: RangeReversionParams,
    position: Position | None,
) -> Position | None:
    if position is not None and params.one_position_at_a_time:
        return None

    hi, lo = float(bar["high"]), float(bar["low"])
    buf = _sl_buffer(params, rng.atr)
    entry_buf = params.entry_buffer_usd

    buy_touch = lo <= rng.bottom + entry_buf
    sell_touch = hi >= rng.top - entry_buf

    if buy_touch and sell_touch:
        # 同 bar 双边触达：保守起见不做新单
        return None
    if buy_touch:
        entry = min(float(bar["open"]), rng.bottom + entry_buf)
        return Position(
            direction="buy",
            entry=entry,
            sl=rng.bottom - buf,
            tp=_tp_price("buy", entry, rng, params),
            open_ts=pd.Timestamp(bar["timestamps"]),
            range_top=rng.top,
            range_bottom=rng.bottom,
        )
    if sell_touch:
        entry = max(float(bar["open"]), rng.top - entry_buf)
        return Position(
            direction="sell",
            entry=entry,
            sl=rng.top + buf,
            tp=_tp_price("sell", entry, rng, params),
            open_ts=pd.Timestamp(bar["timestamps"]),
            range_top=rng.top,
            range_bottom=rng.bottom,
        )
    return None


def _annotate_bars(bars: pd.DataFrame, tz: str) -> pd.DataFrame:
    out = bars.sort_values("timestamps").reset_index(drop=True).copy()
    ts = pd.to_datetime(out["timestamps"], utc=True)
    local = ts.dt.tz_convert(tz)
    out["ts_utc"] = ts
    out["ts_local"] = local
    out["local_date"] = local.dt.date
    out["local_hour"] = local.dt.hour
    return out


def _session_slices(
    bars: pd.DataFrame,
    params: RangeReversionParams,
) -> list[tuple[str, pd.DataFrame]]:
    annotated = _annotate_bars(bars, params.timezone)
    sessions: list[tuple[str, pd.DataFrame]] = []

    for session_date, day_bars in annotated.groupby("local_date"):
        mask = (day_bars["local_hour"] >= params.session_start_hour) & (
            day_bars["local_hour"] < params.session_end_hour
        )
        session = day_bars.loc[mask]
        if session.empty:
            continue

        first_i = session.index.min()
        start_i = max(0, first_i - params.warmup_bars)
        chunk = annotated.iloc[start_i : session.index.max() + 1].copy()
        sessions.append((str(session_date), chunk))

    return sessions


def simulate_session(
    session_date: str,
    bars: pd.DataFrame,
    params: RangeReversionParams,
) -> list[TradeRecord]:
    trades: list[TradeRecord] = []
    position: Position | None = None
    session_disabled = False
    last_range: RangeState | None = None

    session_mask = (bars["local_hour"] >= params.session_start_hour) & (
        bars["local_hour"] < params.session_end_hour
    )
    session_indices = bars.index[session_mask]
    if len(session_indices) == 0:
        return trades

    for i in bars.index:
        if i not in session_indices:
            continue

        hist = bars.iloc[:i]
        bar = bars.iloc[i]
        rng = detect_range(hist, params)
        if rng is not None:
            last_range = rng

        if position is not None:
            hit, exit_px, reason = _check_exit(position, bar)
            if hit:
                gross = profit_usd(position.direction, position.entry, exit_px, params.lots)
                width = position.range_top - position.range_bottom
                trades.append(
                    TradeRecord(
                        session_date=session_date,
                        direction=position.direction,
                        entry=position.entry,
                        exit_px=exit_px,
                        sl=position.sl,
                        tp=position.tp,
                        range_top=position.range_top,
                        range_bottom=position.range_bottom,
                        range_width=width,
                        open_ts=position.open_ts,
                        close_ts=pd.Timestamp(bar["timestamps"]),
                        exit_reason=reason,
                        gross_usd=gross,
                    )
                )
                position = None
                continue

        if rng is None:
            continue

        close_px = float(bar["close"])
        breakout_buf = _breakout_buffer(params, rng.atr)
        breakout = close_px > rng.top + breakout_buf or close_px < rng.bottom - breakout_buf
        if breakout:
            if position is not None:
                gross = profit_usd(position.direction, position.entry, close_px, params.lots)
                width = position.range_top - position.range_bottom
                trades.append(
                    TradeRecord(
                        session_date=session_date,
                        direction=position.direction,
                        entry=position.entry,
                        exit_px=close_px,
                        sl=position.sl,
                        tp=position.tp,
                        range_top=position.range_top,
                        range_bottom=position.range_bottom,
                        range_width=width,
                        open_ts=position.open_ts,
                        close_ts=pd.Timestamp(bar["timestamps"]),
                        exit_reason="breakout",
                        gross_usd=gross,
                    )
                )
                position = None
            session_disabled = True
            continue

        if session_disabled or not rng.valid:
            continue

        if position is None:
            opened = _try_open(bar, rng, params, position)
            if opened is not None:
                position = opened
                hit, exit_px, reason = _check_exit(position, bar)
                if hit:
                    gross = profit_usd(position.direction, position.entry, exit_px, params.lots)
                    width = position.range_top - position.range_bottom
                    trades.append(
                        TradeRecord(
                            session_date=session_date,
                            direction=position.direction,
                            entry=position.entry,
                            exit_px=exit_px,
                            sl=position.sl,
                            tp=position.tp,
                            range_top=position.range_top,
                            range_bottom=position.range_bottom,
                            range_width=width,
                            open_ts=position.open_ts,
                            close_ts=pd.Timestamp(bar["timestamps"]),
                            exit_reason=reason,
                            gross_usd=gross,
                        )
                    )
                    position = None

    if position is not None and last_range is not None:
        last_bar = bars.iloc[session_indices[-1]]
        exit_px = float(last_bar["close"])
        gross = profit_usd(position.direction, position.entry, exit_px, params.lots)
        width = position.range_top - position.range_bottom
        trades.append(
            TradeRecord(
                session_date=session_date,
                direction=position.direction,
                entry=position.entry,
                exit_px=exit_px,
                sl=position.sl,
                tp=position.tp,
                range_top=position.range_top,
                range_bottom=position.range_bottom,
                range_width=width,
                open_ts=position.open_ts,
                close_ts=pd.Timestamp(last_bar["timestamps"]),
                exit_reason="session_end",
                gross_usd=gross,
            )
        )

    return trades


def run_backtest(
    start_date: str | None = None,
    end_date: str | None = None,
    params: RangeReversionParams | None = None,
) -> tuple[pd.DataFrame, dict]:
    params = params or RangeReversionParams.for_bar_minutes(1)
    dates = list_available_dates(bar_minutes=params.bar_minutes)
    if not dates:
        label = f"M{params.bar_minutes}" if params.bar_minutes < 60 else f"{params.bar_minutes}m"
        raise FileNotFoundError(f"Files/ 下未找到 {label} CSV（请放置与 config.yaml 中 m1_glob 匹配的文件）")

    start_date = start_date or dates[0]
    end_date = end_date or dates[-1]
    bars = load_ohlc_by_date_range(start_date, end_date, bar_minutes=params.bar_minutes)
    if bars.empty:
        raise ValueError(f"区间 {start_date} ~ {end_date} 无 K 线数据")

    annotated = _annotate_bars(bars, params.timezone)
    all_trades: list[TradeRecord] = []
    session_stats = []

    for session_date, chunk in _session_slices(annotated, params):
        chunk = chunk.reset_index(drop=True)
        session_trades = simulate_session(session_date, chunk, params)
        all_trades.extend(session_trades)

        sess_bars = chunk[
            (chunk["local_hour"] >= params.session_start_hour)
            & (chunk["local_hour"] < params.session_end_hour)
        ]
        if not sess_bars.empty:
            sess_range = float(sess_bars["high"].max() - sess_bars["low"].min())
            session_stats.append(
                {
                    "session_date": session_date,
                    "bars": len(sess_bars),
                    "session_range_usd": round(sess_range, 2),
                    "trades": len(session_trades),
                    "session_pnl": round(sum(t.gross_usd for t in session_trades), 2),
                }
            )

    trade_rows = [
        {
            "session_date": t.session_date,
            "direction": t.direction,
            "entry": round(t.entry, 2),
            "exit_px": round(t.exit_px, 2),
            "sl": round(t.sl, 2),
            "tp": round(t.tp, 2),
            "range_top": round(t.range_top, 2),
            "range_bottom": round(t.range_bottom, 2),
            "range_width": round(t.range_width, 2),
            "open_ts": t.open_ts,
            "close_ts": t.close_ts,
            "exit_reason": t.exit_reason,
            "gross_usd": round(t.gross_usd, 2),
        }
        for t in all_trades
    ]
    trades_df = pd.DataFrame(trade_rows)

    summary = summarize_trades(trades_df, session_stats, params)
    return trades_df, summary


def summarize_trades(
    trades: pd.DataFrame,
    session_stats: list[dict],
    params: RangeReversionParams,
) -> dict:
    sessions_df = pd.DataFrame(session_stats)
    if trades.empty:
        return {
            "params": params,
            "sessions": len(sessions_df),
            "sessions_with_trades": 0,
            "trades": 0,
            "total_pnl": 0.0,
            "win_rate": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "exit_breakdown": {},
            "sessions_df": sessions_df,
        }

    pnl = trades["gross_usd"]
    wins = pnl[pnl > 0]
    losses = pnl[pnl < 0]
    equity = pnl.cumsum()
    peak = equity.cummax()
    dd = peak - equity

    gross_win = wins.sum()
    gross_loss = abs(losses.sum())
    pf = gross_win / gross_loss if gross_loss > 0 else float("inf")

    return {
        "params": params,
        "sessions": len(sessions_df),
        "sessions_with_trades": int(sessions_df["trades"].gt(0).sum()) if not sessions_df.empty else 0,
        "trades": len(trades),
        "total_pnl": float(pnl.sum()),
        "win_rate": float((pnl > 0).mean()),
        "avg_win": float(wins.mean()) if len(wins) else 0.0,
        "avg_loss": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": pf,
        "max_drawdown": float(dd.max()),
        "exit_breakdown": trades["exit_reason"].value_counts().to_dict(),
        "sessions_df": sessions_df,
    }


def format_summary(summary: dict) -> str:
    p = summary["params"]
    tf = f"M{p.bar_minutes}" if p.bar_minutes < 60 else f"{p.bar_minutes}m"
    lines = [
        "=== 区间高抛低吸回测（北京时间时段） ===",
        f"K线: {tf}  时段: {p.timezone} {p.session_start_hour:02d}:00–{p.session_end_hour:02d}:00",
        f"Donchian={p.donchian_period}  ATR={p.atr_period}  区间宽度 ${p.min_range_usd}–${p.max_range_usd}",
        f"ADX≤{p.max_adx}  ER≤{p.max_efficiency_ratio}",
        "",
        f"交易时段数: {summary['sessions']}",
        f"有成交时段: {summary['sessions_with_trades']}",
        f"总成交笔数: {summary['trades']}",
        f"净利 (USD, {p.lots} 手): {summary['total_pnl']:+.2f}",
        f"胜率: {summary['win_rate']:.1%}",
        f"平均盈利: {summary.get('avg_win', 0):+.2f}  平均亏损: {summary.get('avg_loss', 0):+.2f}",
        f"盈亏比 (Profit Factor): {summary['profit_factor']:.2f}"
        if summary["profit_factor"] != float("inf")
        else "盈亏比 (Profit Factor): ∞",
        f"最大回撤 (累计): {summary['max_drawdown']:.2f}",
    ]
    if summary["exit_breakdown"]:
        lines.append("")
        lines.append("出场分布:")
        for reason, n in summary["exit_breakdown"].items():
            lines.append(f"  {reason}: {n}")
    return "\n".join(lines)
