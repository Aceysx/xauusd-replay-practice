"""M5 K 线加载。"""

from datetime import timedelta
from pathlib import Path

import pandas as pd

from src.core.config import get_paths
from src.core.timezone import to_chart_unix


def m5_file_for_date(d, m5_dir: Path | None = None, pattern: str | None = None) -> Path:
    paths = get_paths()
    m5_dir = m5_dir or paths["m5_dir"]
    pattern = pattern or paths["m5_glob"]
    return m5_dir / pattern.format(date=pd.Timestamp(d).date().isoformat())


def list_available_dates(m5_dir: Path | None = None) -> list[str]:
    paths = get_paths()
    m5_dir = m5_dir or paths["m5_dir"]
    dates = []
    for fp in sorted(m5_dir.glob("xauusd_xauusdm_m5_*.csv")):
        # xauusd_xauusdm_m5_2026-05-26.csv
        part = fp.stem.split("_")[-1]
        dates.append(part)
    return dates


def load_m5_range(start, end, m5_dir: Path | None = None) -> pd.DataFrame:
    paths = get_paths()
    m5_dir = m5_dir or paths["m5_dir"]
    pattern = paths["m5_glob"]
    frames = []
    d = pd.Timestamp(start).date()
    end_d = pd.Timestamp(end).date()
    while d <= end_d:
        fp = m5_dir / pattern.format(date=d.isoformat())
        if fp.exists():
            frames.append(pd.read_csv(fp))
        d += timedelta(days=1)
    if not frames:
        return pd.DataFrame()
    bars = pd.concat(frames, ignore_index=True)
    bars["timestamps"] = pd.to_datetime(bars["timestamps"])
    bars = bars.sort_values("timestamps").drop_duplicates("timestamps")
    mask = (bars["timestamps"] >= pd.Timestamp(start) - timedelta(minutes=5)) & (
        bars["timestamps"] <= pd.Timestamp(end) + timedelta(minutes=5)
    )
    return bars.loc[mask].reset_index(drop=True)


def bars_to_chart_json(bars: pd.DataFrame) -> list[dict]:
    if bars.empty:
        return []
    out = []
    for _, b in bars.iterrows():
        out.append(
            {
                "time": to_chart_unix(b["timestamps"]),
                "open": float(b["open"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "close": float(b["close"]),
            }
        )
    return out


def load_m5_by_date_range(start_date: str, end_date: str) -> pd.DataFrame:
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date) + pd.Timedelta(days=1) - pd.Timedelta(minutes=1)
    return load_m5_range(start, end)


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
