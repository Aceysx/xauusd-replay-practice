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

# 由 M5 预聚合持久化的周期（读取时不再从 M5 实时 resample）
PERSISTED_TIMEFRAMES: tuple[str, ...] = ("15m", "30m", "1h", "4h", "1d")

_OHLC_GLOB_KEYS: dict[int, str] = {
    1: "m1_glob",
    5: "m5_glob",
    15: "m15_glob",
    30: "m30_glob",
    60: "h1_glob",
    240: "h4_glob",
    1440: "d1_glob",
}

_OHLC_GLOB_DEFAULTS: dict[int, str] = {
    1: "xauusd_xauusdm_m1_{date}.csv",
    5: "xauusd_xauusdm_m5_{date}.csv",
    15: "xauusd_xauusdm_m15_{date}.csv",
    30: "xauusd_xauusdm_m30_{date}.csv",
    60: "xauusd_xauusdm_h1_{date}.csv",
    240: "xauusd_xauusdm_h4_{date}.csv",
    1440: "xauusd_xauusdm_d1_{date}.csv",
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


def _sort_by_timestamps(df: pd.DataFrame) -> pd.DataFrame:
    """稳定排序，保证 drop_duplicates(keep='last') 保留后写入的数据。"""
    if df.empty:
        return df
    return df.sort_values("timestamps", kind="mergesort")


_OHLC_COLS = ("timestamps", "open", "high", "low", "close", "volume", "amount")


def _concat_ohlc_frames(frames: list[pd.DataFrame]) -> pd.DataFrame:
    """拼接 OHLC CSV，跳过空表避免 pandas concat FutureWarning。"""
    parts = [f for f in frames if f is not None and not f.empty]
    if not parts:
        return pd.DataFrame(columns=list(_OHLC_COLS))
    return pd.concat(parts, ignore_index=True)


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


def bars_until(bars: pd.DataFrame, until: pd.Timestamp | None) -> pd.DataFrame:
    return _bars_until(bars, until)


def load_bars_for_timeframe(
    start_date: str,
    end_date: str,
    tf: str,
    until: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """加载指定周期 K 线：各周期 CSV 优先；3h 等未持久化周期从 M5 resample。"""
    tf = normalize_timeframe(tf)
    mins = timeframe_minutes(tf)

    if tf == "5m":
        return resample_bars(load_m5_by_date_range(start_date, end_date), tf, until=until)

    if tf == "1m":
        if timeframe_has_csv(tf):
            bars = load_ohlc_by_date_range(start_date, end_date, bar_minutes=1)
            if until is not None:
                return bars_until(bars, until)
            return bars
        return pd.DataFrame()

    if is_persisted_timeframe(tf) and timeframe_has_csv(tf):
        # 持久化 CSV 含完整区间 K 线；回放揭示由前端 cursor 控制。
        return load_ohlc_by_date_range(start_date, end_date, bar_minutes=mins)

    if tf in _RESAMPLE_FREQ or tf == "1d":
        return resample_bars(load_m5_by_date_range(start_date, end_date), tf, until=until)

    return pd.DataFrame()


def _resample_m5_assign_files(
    dates: list[str],
    tf: str,
    data_dir: Path,
    m5_pattern: str,
) -> dict[str, pd.DataFrame]:
    """全局 resample M5，每根 K 线归入末根 M5 所在日文件（与 M5 按日读取一致）。"""
    chunks: list[pd.DataFrame] = []
    for d in dates:
        fp = data_dir / m5_pattern.format(date=d)
        if not fp.exists():
            continue
        day = pd.read_csv(fp)
        if day.empty:
            continue
        day["timestamps"] = pd.to_datetime(day["timestamps"])
        day["_file_date"] = d
        chunks.append(day)
    if not chunks:
        return {}

    m5 = (
        _concat_ohlc_frames(chunks)
        .pipe(_sort_by_timestamps)
        .drop_duplicates("timestamps", keep="last")
    )
    m5 = m5.set_index("timestamps")

    by_file: dict[str, list[dict]] = {}

    if tf == "1d":
        for day_val, grp in m5.groupby(m5.index.date):
            if grp.empty:
                continue
            file_d = grp["_file_date"].iloc[-1]
            by_file.setdefault(file_d, []).append(
                {
                    "timestamps": pd.Timestamp(day_val),
                    "open": float(grp["open"].iloc[0]),
                    "high": float(grp["high"].max()),
                    "low": float(grp["low"].min()),
                    "close": float(grp["close"].iloc[-1]),
                }
            )
    else:
        freq = _RESAMPLE_FREQ[tf]
        for ts, grp in m5.groupby(
            pd.Grouper(freq=freq, label="left", closed="left", origin="start_day")
        ):
            if grp.empty or grp["open"].isna().all():
                continue
            file_d = str(grp["_file_date"].iloc[-1])
            by_file.setdefault(file_d, []).append(
                {
                    "timestamps": pd.Timestamp(ts),
                    "open": float(grp["open"].iloc[0]),
                    "high": float(grp["high"].max()),
                    "low": float(grp["low"].min()),
                    "close": float(grp["close"].iloc[-1]),
                }
            )

    return {d: pd.DataFrame(rows).sort_values("timestamps").reset_index(drop=True) for d, rows in by_file.items()}


def _write_ohlc_csv(path: Path, df: pd.DataFrame) -> None:
    out = df.sort_values("timestamps").copy()
    out["timestamps"] = pd.to_datetime(out["timestamps"]).dt.strftime("%Y-%m-%d %H:%M:%S")
    if "volume" not in out.columns:
        out["volume"] = 0
    if "amount" not in out.columns:
        out["amount"] = 0
    cols = ["timestamps", "open", "high", "low", "close", "volume", "amount"]
    out[cols].to_csv(path, index=False)


def build_timeframe_csvs_from_m5(
    timeframes: list[str] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    force: bool = False,
) -> dict[str, int]:
    """从 M5 聚合写入各周期按日 CSV。返回 {tf: 写入文件数}。"""
    tfs = timeframes or list(PERSISTED_TIMEFRAMES)
    for tf in tfs:
        if tf not in TIMEFRAMES:
            raise ValueError(f"未知周期: {tf}")

    dates = list_available_dates(bar_minutes=5)
    if not dates:
        raise FileNotFoundError("Files/ 下未找到 M5 CSV")
    start_date = start_date or dates[0]
    end_date = end_date or dates[-1]
    if start_date not in dates:
        start_date = dates[0]
    if end_date not in dates:
        end_date = dates[-1]
    span = [d for d in dates if start_date <= d <= end_date]
    if not span:
        raise ValueError(f"区间 {start_date} ~ {end_date} 无 M5 数据")

    paths = get_paths()
    data_dir = paths["m5_dir"]
    m5_pattern = paths["m5_glob"]
    written: dict[str, int] = {}

    for tf in tfs:
        if tf == "5m":
            continue
        by_date = _resample_m5_assign_files(span, tf, data_dir, m5_pattern)
        mins = timeframe_minutes(tf)
        pattern = ohlc_glob_for_minutes(mins)
        count = 0
        write_dates = span if force else sorted(by_date.keys())
        for d in write_dates:
            chunk = by_date.get(d)
            if chunk is None:
                chunk = pd.DataFrame(
                    columns=["timestamps", "open", "high", "low", "close", "volume", "amount"]
                )
            fp = data_dir / pattern.format(date=d)
            if fp.exists() and not force:
                continue
            _write_ohlc_csv(fp, chunk)
            count += 1
        written[tf] = count
    return written


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
    if tf == "1m":
        return pd.DataFrame()
    df = df.copy()

    full = _resample_m5_df(df, tf)
    u = _coerce_until(until)
    if u is None:
        return full
    return _cap_resampled_at_until(df, full, tf, u)


def ohlc_glob_for_minutes(bar_minutes: int) -> str:
    paths = get_paths()
    key = _OHLC_GLOB_KEYS.get(bar_minutes)
    if key:
        return paths[key]
    if bar_minutes <= 1:
        return paths["m1_glob"]
    return paths["m5_glob"]


def is_persisted_timeframe(tf: str) -> bool:
    return normalize_timeframe(tf) in PERSISTED_TIMEFRAMES


def timeframe_has_csv(tf: str, data_dir: Path | None = None) -> bool:
    """该周期是否已有至少一个持久化 CSV。"""
    mins = timeframe_minutes(tf)
    if mins not in _OHLC_GLOB_KEYS:
        return False
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    scan = ohlc_scan_glob(mins)
    return any(data_dir.glob(scan))


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
    *,
    extra_file_days_before: int = 0,
    start_pad: timedelta | None = None,
    end_pad: timedelta | None = None,
) -> pd.DataFrame:
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    pattern = pattern or ohlc_glob_for_minutes(bar_minutes)
    pad_start = start_pad if start_pad is not None else timedelta(minutes=bar_minutes)
    pad_end = end_pad if end_pad is not None else timedelta(minutes=bar_minutes)
    frames = []
    d = pd.Timestamp(start).date() - timedelta(days=max(0, int(extra_file_days_before)))
    end_d = pd.Timestamp(end).date()
    while d <= end_d:
        fp = data_dir / pattern.format(date=d.isoformat())
        if fp.exists():
            day = pd.read_csv(fp)
            if not day.empty:
                frames.append(day)
        d += timedelta(days=1)
    if not frames:
        return pd.DataFrame()
    bars = _concat_ohlc_frames(frames)
    bars["timestamps"] = pd.to_datetime(bars["timestamps"])
    bars = _sort_by_timestamps(bars).drop_duplicates("timestamps", keep="last")
    mask = (bars["timestamps"] >= pd.Timestamp(start) - pad_start) & (
        bars["timestamps"] <= pd.Timestamp(end) + pad_end
    )
    return bars.loc[mask].reset_index(drop=True)


def load_m5_range(start, end, m5_dir: Path | None = None) -> pd.DataFrame:
    return load_ohlc_range(start, end, bar_minutes=5, data_dir=m5_dir)


def load_ohlc_by_date_range(start_date: str, end_date: str, bar_minutes: int = 5) -> pd.DataFrame:
    """按交易日文件名区间加载。

    MT5 按日 CSV：D 日文件通常从 UTC D-1 23:55 起；UTC D-1 23:00–23:50
    （≈ 北京 D 日 07:00–07:50）仍在 D-1 文件。因此多读前一日文件，
    并把起点时间窗向前扩 2 小时，避免 UTC+8 早盘被裁掉。
    """
    start = pd.Timestamp(start_date)
    end = pd.Timestamp(end_date) + pd.Timedelta(days=1) - pd.Timedelta(minutes=bar_minutes)
    return load_ohlc_range(
        start,
        end,
        bar_minutes=bar_minutes,
        extra_file_days_before=1,
        start_pad=timedelta(hours=2),
    )


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
    # 走按日加载（含前一日文件 + 早盘时间窗），避免 UTC+8 07:00–07:50 被裁掉
    df = load_ohlc_by_date_range(start_date, end_date, bar_minutes=5)
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


def parse_mt5_m5_export(
    path: Path | str,
    *,
    broker_offset_hours: int = 0,
) -> pd.DataFrame:
    """解析 MT5 历史中心导出：date,time,OHLCV（无表头）或标准 timestamps CSV。"""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)

    with path.open(encoding="utf-8", errors="replace") as f:
        first = f.readline().strip().lower()

    if first.startswith("timestamp") or first.startswith("date,"):
        df = pd.read_csv(path)
        if "timestamps" not in df.columns:
            raise ValueError(f"{path} 缺少 timestamps 列")
    else:
        df = pd.read_csv(
            path,
            header=None,
            names=["date", "time", "open", "high", "low", "close", "volume"],
        )
        date_s = df["date"].astype(str).str.replace(".", "-", regex=False)
        time_s = df["time"].astype(str)
        df["timestamps"] = pd.to_datetime(date_s + " " + time_s, errors="coerce")

    df["timestamps"] = pd.to_datetime(df["timestamps"])
    if broker_offset_hours:
        df["timestamps"] = df["timestamps"] - pd.to_timedelta(broker_offset_hours, unit="h")

    df = df.dropna(subset=["timestamps"])
    for col in ("open", "high", "low", "close"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "volume" in df.columns:
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype(int)
    else:
        df["volume"] = 0
    if "amount" not in df.columns:
        df["amount"] = 0

    return (
        df[["timestamps", "open", "high", "low", "close", "volume", "amount"]]
        .pipe(_sort_by_timestamps)
        .drop_duplicates("timestamps", keep="last")
        .reset_index(drop=True)
    )


def merge_ohlc_frames(frames: list[pd.DataFrame], *, keep: str = "last") -> pd.DataFrame:
    merged = _concat_ohlc_frames(frames)
    if merged.empty:
        return merged
    merged["timestamps"] = pd.to_datetime(merged["timestamps"])
    return _sort_by_timestamps(merged).drop_duplicates("timestamps", keep=keep).reset_index(drop=True)


def default_m5_file_date(ts) -> str:
    """MT5 按日文件默认规则：23:55 归入下一交易日文件。"""
    t = pd.Timestamp(ts)
    if t.hour == 23 and t.minute == 55:
        return (t + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return t.strftime("%Y-%m-%d")


def build_m5_file_date_lookup(
    m5_dir: Path | None = None,
    dates: list[str] | None = None,
) -> dict[pd.Timestamp, str]:
    """从现有按日 CSV 建立 timestamp → 文件日期 映射。"""
    paths = get_paths()
    data_dir = m5_dir or paths["m5_dir"]
    pattern = paths["m5_glob"]
    file_dates = dates or list_available_dates(data_dir, bar_minutes=5)
    lookup: dict[pd.Timestamp, str] = {}
    for d in file_dates:
        fp = data_dir / pattern.format(date=d)
        if not fp.exists():
            continue
        for ts in pd.read_csv(fp, usecols=["timestamps"])["timestamps"]:
            lookup[pd.Timestamp(ts)] = d
    return lookup


def assign_m5_file_date(ts, lookup: dict[pd.Timestamp, str] | None = None) -> str:
    t = pd.Timestamp(ts)
    if lookup and t in lookup:
        return lookup[t]
    return default_m5_file_date(t)


def load_m5_daily_files(
    file_dates: list[str],
    data_dir: Path | None = None,
    pattern: str | None = None,
) -> pd.DataFrame:
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    pattern = pattern or paths["m5_glob"]
    frames: list[pd.DataFrame] = []
    for d in file_dates:
        fp = data_dir / pattern.format(date=d)
        if fp.exists():
            frames.append(pd.read_csv(fp))
    return merge_ohlc_frames(frames, keep="first")


def write_m5_daily_csvs(
    df: pd.DataFrame,
    *,
    data_dir: Path | None = None,
    pattern: str | None = None,
    lookup: dict[pd.Timestamp, str] | None = None,
    only_dates: list[str] | None = None,
    dry_run: bool = False,
) -> list[str]:
    """按 MT5 按日规则写回 M5 CSV，返回写入的文件日期列表。"""
    if df.empty:
        return []

    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    pattern = pattern or paths["m5_glob"]
    data_dir.mkdir(parents=True, exist_ok=True)

    work = df.copy()
    work["timestamps"] = pd.to_datetime(work["timestamps"])
    work["_file_date"] = work["timestamps"].map(lambda t: assign_m5_file_date(t, lookup))

    written: list[str] = []
    for file_date, chunk in work.groupby("_file_date", sort=True):
        if only_dates is not None and file_date not in only_dates:
            continue
        out = chunk.drop(columns="_file_date").reset_index(drop=True)
        fp = data_dir / pattern.format(date=file_date)
        if dry_run:
            written.append(file_date)
            continue
        _write_ohlc_csv(fp, out)
        written.append(file_date)
    return written


def merge_m5_export_into_files(
    source: Path | str,
    *,
    data_dir: Path | None = None,
    broker_offset_hours: int = 0,
    keep: str = "last",
    dry_run: bool = False,
) -> dict:
    """把 MT5 导出 CSV 合并进 Files/ 按日 M5，重复时间戳保留 keep 侧。"""
    paths = get_paths()
    data_dir = data_dir or paths["m5_dir"]
    incoming = parse_mt5_m5_export(source, broker_offset_hours=broker_offset_hours)
    if incoming.empty:
        raise ValueError("导入文件无有效 K 线")

    lookup = build_m5_file_date_lookup(data_dir)
    affected_dates = sorted({assign_m5_file_date(ts, lookup) for ts in incoming["timestamps"]})
    existing = load_m5_daily_files(affected_dates, data_dir=data_dir)
    before = len(existing)
    overlap = 0
    if not existing.empty:
        overlap = incoming["timestamps"].isin(existing["timestamps"]).sum()

    merged = merge_ohlc_frames([existing, incoming], keep=keep)
    written = write_m5_daily_csvs(
        merged,
        data_dir=data_dir,
        lookup=lookup,
        only_dates=affected_dates,
        dry_run=dry_run,
    )

    new_bars = max(0, len(merged) - before)
    return {
        "source_bars": len(incoming),
        "existing_bars": before,
        "merged_bars": len(merged),
        "overlap_bars": int(overlap),
        "new_bars": new_bars,
        "affected_dates": affected_dates,
        "written_dates": written,
        "source_start": incoming["timestamps"].iloc[0],
        "source_end": incoming["timestamps"].iloc[-1],
    }
