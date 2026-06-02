"""时区：交割单为经纪商时间，M5 CSV 为 UTC。"""

from src.core.config import timezone_config

_cfg = timezone_config()
BROKER_UTC_OFFSET_HOURS = _cfg["broker_utc_offset_hours"]
M5_TIMEZONE = _cfg["m5_timezone"]


def statement_to_m5_time(dt):
    import pandas as pd

    return pd.Timestamp(dt) - pd.to_timedelta(BROKER_UTC_OFFSET_HOURS, unit="h")


def to_chart_unix(dt) -> int:
    import pandas as pd

    ts = pd.Timestamp(dt)
    if ts.tzinfo is None:
        ts = ts.tz_localize(M5_TIMEZONE)
    else:
        ts = ts.tz_convert(M5_TIMEZONE)
    return int(ts.timestamp())
