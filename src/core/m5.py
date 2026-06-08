"""M5 K 线加载与多周期聚合。"""

import random
from datetime import timedelta
from pathlib import Path

import pandas as pd

from src.core.config import get_paths
from src.core.timezone import to_chart_unix

TIMEFRAMES: dict[str, dict] = {
    "1m": {"label": "M1", "minutes": 1},
    "5m": {"label": "M5", "minutes": 5},
    "15m": {"label": "M15", "minutes": 15},
    "30m": {"label": "M30", "minutes": 30},
    "1h": {"label": "H1", "minutes": 60},
    "3h": {"label": "H3", "minutes": 180},
    "4h": {"label": "H4", "minutes": 240},
    "1d": {"label": "D1", "minutes": 1440},
}

_RESAMPLE_FREQ = {
    "15m": "15min",
    "30m": "30min",
    "1h": "1h",
    "3h": "3h",
    "4h": "4h",
}


def normalize_timeframe(tf: str | None) -> str:
    if tf and tf in TIMEFRAMES:
        return tf
    return "5m"


def timeframe_minutes(tf: str) -> int:
    return TIMEFRAMES[normalize_timeframe(tf)]["minutes"]


def timeframe_bar_seconds(tf: str) -> int:
    return timeframe_minutes(tf) * 60


def _coerce_until(until: pd.Timestamp | None) -> pd.Timestamp | None:
    if until is None:
        return None
    u = pd.Timestamp(until)
    if u.tzinfo is not None:
        u = u.tz_convert("UTC").tz_localize(None)
    return u


def _bars_until(bars: pd.DataFrame, until: pd.Timestamp | None) -> pd.DataFrame:
    u = _coerce_until(until)
    if u is None or bars.empty:
        return bars
    out = bars[bars["timestamps"] <= u]
    return out.reset_index(drop=True)


def _resample_m5_df(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    df = df.copy().set_index("timestamps")
    if tf == "1d":
        grouped = df.groupby(df.index.date)
        out = grouped.agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
        )
        out.index = pd.to_datetime(out.index)
    else:
        freq = _RESAMPLE_FREQ[tf]
        out = df.resample(freq, label="left", closed="left", origin="start_day").agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
        )
        out = out.dropna(subset=["open"])
    out = out.reset_index(names="timestamps")
    return out.sort_values("timestamps").reset_index(drop=True)


def _cap_resampled_at_until(
    m5: pd.DataFrame, resampled: pd.DataFrame, tf: str, until: pd.Timestamp
) -> pd.DataFrame:
    """保留全部周期 K 线；仅对跨越 until 的当前 K 线按 M5 重算 OHLC。"""
    u = _coerce_until(until)
    if u is None or resampled.empty:
        return resampled
    mins = timeframe_minutes(tf)
    period = pd.Timedelta(minutes=mins)
    bar_end_offset = pd.Timedelta(minutes=5)
    m5 = m5.sort_values("timestamps")
    rows = []
    for _, bar in resampled.iterrows():
        t0 = pd.Timestamp(bar["timestamps"])
        if t0.tzinfo is not None:
            t0 = t0.tz_convert("UTC").tz_localize(None)
        period_end = t0 + period - bar_end_offset
        if u >= period_end:
            rows.append(bar.to_dict())
            continue
        if u < t0:
            rows.append(bar.to_dict())
            continue
        mask = (m5["timestamps"] >= t0) & (m5["timestamps"] <= u)
        chunk = m5.loc[mask]
        if chunk.empty:
            rows.append(bar.to_dict())
        else:
            rows.append(
                {
                    "timestamps": t0,
                    "open": float(chunk.iloc[0]["open"]),
                    "high": float(chunk["high"].max()),
                    "low": float(chunk["low"].min()),
                    "close": float(chunk.iloc[-1]["close"]),
                }
            )
    return pd.DataFrame(rows)


def resample_bars(
    bars: pd.DataFrame, tf: str, until: pd.Timestamp | None = None
) -> pd.DataFrame:
    """将 M5 OHLC 聚合为更高周期。

    M5：until 截断原始 M5。
    更高周期：先聚合全量 M5，until 仅修正未完成 K 线的 OHLC，不删除后续 K 线。
    """
    tf = normalize_timeframe(tf)
    if bars.empty:
        return bars

    df = bars.sort_values("timestamps")
    if tf == "5m":
        if until is None:
            return df.reset_index(drop=True)
        return _bars_until(df, until).reset_index(drop=True)
    df = df.copy()

    full = _resample_m5_df(df, tf)
    u = _coerce_until(until)
    if u is None:
        return full
    return _cap_resampled_at_until(df, full, tf, u)


def ohlc_glob_for_minutes(bar_minutes: int) -> str:
    paths = get_paths()
    if bar_minutes <= 1:
        return paths["m1_glob"]
    return paths["m5_glob"]


def ohlc_scan_glob(bar_minutes: int) -> str:
    """用于 glob 列举已有 CSV 的通配符。"""
    pattern = ohlc_glob_for_minutes(bar_minutes)
    return pattern.replace("{date}", "*")


def ohlc_file_for_date(
    d,
    bar_minutes: int = 5,
    data_dir: Path | None = None,
    pattern: str | None = None,
) -> Path:
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    pattern = pattern or ohlc_glob_for_minutes(bar_minutes)
    return data_dir / pattern.format(date=pd.Timestamp(d).date().isoformat())


def m5_file_for_date(d, m5_dir: Path | None = None, pattern: str | None = None) -> Path:
    return ohlc_file_for_date(d, bar_minutes=5, data_dir=m5_dir, pattern=pattern)


def list_available_dates(m5_dir: Path | None = None, bar_minutes: int = 5) -> list[str]:
    paths = get_paths()
    data_dir = m5_dir or paths["m5_dir"]
    scan = ohlc_scan_glob(bar_minutes)
    dates = []
    for fp in sorted(data_dir.glob(scan)):
        part = fp.stem.split("_")[-1]
        dates.append(part)
    return dates


def load_ohlc_range(
    start,
    end,
    bar_minutes: int = 5,
    data_dir: Path | None = None,
    pattern: str | None = None,
) -> pd.DataFrame:
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    pattern = pattern or ohlc_glob_for_minutes(bar_minutes)
    pad = timedelta(minutes=bar_minutes)
    frames = []
    d = pd.Timestamp(start).date()
    end_d = pd.Timestamp(end).date()
    while d <= end_d:
        fp = data_dir / pattern.format(date=d.isoformat())
        if fp.exists():
            frames.append(pd.read_csv(fp))
        d += timedelta(days=1)
    if not frames:
        return pd.DataFrame()
    bars = pd.concat(frames, ignore_index=True)
    bars["timestamps"] = pd.to_datetime(bars["timestamps"])
    bars = bars.sort_values("timestamps").drop_duplicates("timestamps")
    mask = (bars["timestamps"] >= pd.Timestamp(start) - pad) & (
        bars["timestamps"] <= pd.Timestamp(end) + pad
    )
    return bars.loc[mask].reset_index(drop=True)


def load_m5_range(start, end, m5_dir: Path | None = None) -> pd.DataFrame:
    return load_ohlc_range(start, end, bar_minutes=5, data_dir=m5_dir)


def load_ohlc_by_date_range(start_date: str, end_date: str, bar_minutes: int = 5) -> pd.DataFrame:
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date) + pd.Timedelta(days=1) - pd.Timedelta(minutes=bar_minutes)
    return load_ohlc_range(start, end, bar_minutes=bar_minutes)


def bars_to_chart_json(bars: pd.DataFrame) -> list[dict]:
    if bars.empty:
        return []
    return [
        {
            "time": to_chart_unix(t),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
        }
        for t, o, h, l, c in zip(
            bars["timestamps"],
            bars["open"],
            bars["high"],
            bars["low"],
            bars["close"],
        )
    ]


_m5_range_cache: dict[tuple[str, str], pd.DataFrame] = {}
_M5_RANGE_CACHE_MAX = 24


def load_m5_by_date_range(start_date: str, end_date: str) -> pd.DataFrame:
    key = (start_date, end_date)
    cached = _m5_range_cache.get(key)
    if cached is not None:
        return cached
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date) + pd.Timedelta(days=1) - pd.Timedelta(minutes=1)
    df = load_m5_range(start, end)
    if len(_m5_range_cache) >= _M5_RANGE_CACHE_MAX:
        _m5_range_cache.pop(next(iter(_m5_range_cache)))
    _m5_range_cache[key] = df
    return df


def default_replay_range(trading_days: int | None = None) -> tuple[str, str]:
    """最近 N 个交易日（有 CSV 的日期，非日历日）。"""
    all_dates = list_available_dates()
    if not all_dates:
        raise FileNotFoundError("Files/ 下未找到 M5 CSV")
    n = trading_days
    if n is None:
        from src.core.config import replay_defaults

        n = replay_defaults()["default_trading_days"]
    selected = all_dates[-n:]
    return selected[0], selected[-1]


def range_before_trading_day(first_loaded: str, trading_days: int) -> tuple[str, str] | None:
    """在已加载最早交易日之前，再取 N 个交易日的区间。"""
    dates = list_available_dates()
    if first_loaded not in dates:
        return None
    i = dates.index(first_loaded)
    if i <= 0:
        return None
    start_i = max(0, i - trading_days)
    return dates[start_i], dates[i - 1]


def load_trading_days_ending(end_date: str, trading_days: int) -> pd.DataFrame:
    dates = list_available_dates()
    if not dates:
        return pd.DataFrame()
    if end_date not in dates:
        end_date = dates[-1]
    i = dates.index(end_date)
    start_i = max(0, i - trading_days + 1)
    return load_m5_by_date_range(dates[start_i], dates[i])


def pick_random_trading_day(min_forward_days: int = 10) -> dict:
    """从有 CSV 的交易日中随机选一天作为回测起点（之后至少留 min_forward_days 个交易日）。"""
    dates = list_available_dates()
    if not dates:
        raise ValueError("Files/ 下未找到 M5 交易日数据")
    n = max(0, int(min_forward_days))
    max_start_i = len(dates) - n - 1
    if max_start_i < 0:
        raise ValueError(
            f"交易日不足：共 {len(dates)} 天，需要起点后至少 {n} 个交易日可练"
        )
    idx = random.randrange(0, max_start_i + 1)
    return {
        "date": dates[idx],
        "first_date": dates[0],
        "last_date": dates[-1],
        "min_forward_days": n,
    }
