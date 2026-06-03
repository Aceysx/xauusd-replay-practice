"""加载 config.yaml。"""

from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "config.yaml"


@lru_cache(maxsize=1)
def get_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def get_paths() -> dict:
    cfg = get_config()
    paths = cfg.get("paths", {})
    root = ROOT / paths.get("root", ".")
    return {
        "root": root.resolve(),
        "statement": (root / paths.get("statement", "Statement.htm")).resolve(),
        "m5_dir": (root / paths.get("m5_dir", "Files")).resolve(),
        "m5_glob": paths.get("m5_glob", "xauusd_xauusdm_m5_{date}.csv"),
    }


def strategy_defaults() -> dict:
    s = get_config().get("strategy", {})
    return {
        "sl": float(s.get("default_sl", 5)),
        "tp": float(s.get("default_tp", 20)),
        "limit_offset": float(s.get("limit_offset", 2)),
        "ladder_tp": tuple(s.get("ladder_tp", [10, 20, 30])),
    }


def replay_defaults() -> dict:
    from src.core.m5 import TIMEFRAMES, normalize_timeframe

    r = get_config().get("replay", {})
    initial = int(r.get("initial_trading_days", r.get("default_trading_days", 15)))
    chunk = int(r.get("load_chunk_trading_days", initial))
    base_ms = int(r.get("bar_ms_per_candle_at_1x", 300))
    default_tf = normalize_timeframe(r.get("default_timeframe", "5m"))
    timeframes = []
    for tf_id, meta in TIMEFRAMES.items():
        minutes = meta["minutes"]
        timeframes.append(
            {
                "id": tf_id,
                "label": meta["label"],
                "minutes": minutes,
                "bar_ms_at_1x": int(base_ms * minutes / 5),
            }
        )
    return {
        "port": int(r.get("port", 8765)),
        "chart_visible_bars": int(r.get("chart_visible_bars", 800)),
        "initial_trading_days": initial,
        "load_chunk_trading_days": chunk,
        "default_trading_days": int(r.get("default_trading_days", initial)),
        "bar_ms_per_candle_at_1x": base_ms,
        "default_timeframe": default_tf,
        "timeframes": timeframes,
    }


def timezone_config() -> dict:
    t = get_config().get("timezone", {})
    return {
        "broker_utc_offset_hours": int(t.get("broker_utc_offset_hours", 3)),
        "m5_timezone": t.get("m5_timezone", "UTC"),
    }
