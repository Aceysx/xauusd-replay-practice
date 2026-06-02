"""解析 MT Statement.htm 交割单。"""

import re
from pathlib import Path

import pandas as pd

from src.core.config import get_paths


def parse_statement(path: Path | None = None) -> pd.DataFrame:
    path = path or get_paths()["statement"]
    html = path.read_text(encoding="utf-8", errors="replace")
    section = re.search(
        r"Closed Transactions:.*?(?=Working Orders:|Summary:)",
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if not section:
        raise ValueError("找不到 Closed Transactions 段")
    body = section.group(0)
    rows = []
    for m in re.finditer(r"<tr[^>]*>(.*?)</tr>", body, re.DOTALL | re.IGNORECASE):
        tr = m.group(1)
        if "cancelled" in tr.lower():
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.DOTALL | re.IGNORECASE)
        if len(cells) < 14:
            continue
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in cells]
        if cells[0].lower() == "ticket":
            continue
        typ = cells[2].lower()
        if typ not in ("buy", "sell"):
            continue
        try:
            profit = float(cells[13].replace(",", ""))
        except ValueError:
            continue
        rows.append(
            {
                "ticket": cells[0],
                "open_time": cells[1],
                "type": typ,
                "size": float(cells[3]),
                "open_price": float(cells[5].replace(",", "")),
                "orig_sl": float(cells[6].replace(",", "")),
                "orig_tp": float(cells[7].replace(",", "")),
                "close_time": cells[8],
                "close_price": float(cells[9].replace(",", "")),
                "commission": float(cells[10].replace(",", "")),
                "swap": float(cells[12].replace(",", "")),
                "profit": profit,
            }
        )
    df = pd.DataFrame(rows)
    df["open_dt"] = pd.to_datetime(df["open_time"], format="%Y.%m.%d %H:%M:%S")
    df["close_dt"] = pd.to_datetime(df["close_time"], format="%Y.%m.%d %H:%M:%S")
    return df


def parse_cancelled_limits(path: Path | None = None) -> pd.DataFrame:
    path = path or get_paths()["statement"]
    html = path.read_text(encoding="utf-8", errors="replace")
    section = re.search(
        r"Closed Transactions:.*?(?=Working Orders:|Summary:)",
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if not section:
        raise ValueError("找不到 Closed Transactions 段")
    rows = []
    for m in re.finditer(r"<tr[^>]*>(.*?)</tr>", section.group(0), re.DOTALL | re.IGNORECASE):
        tr = m.group(1)
        if "limit" not in tr.lower() or "cancelled" not in tr.lower():
            continue
        cells = [
            re.sub(r"<[^>]+>", "", c).strip()
            for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.DOTALL | re.IGNORECASE)
        ]
        if len(cells) < 10:
            continue
        typ = cells[2].lower()
        rows.append(
            {
                "ticket": cells[0],
                "open_time": cells[1],
                "type": typ,
                "size": float(cells[3]) if cells[3] else 0.01,
                "limit_price": float(cells[5].replace(",", "")),
                "orig_sl": float(cells[6].replace(",", "")),
                "orig_tp": float(cells[7].replace(",", "")) if cells[7] else 0.0,
                "close_time": cells[8],
                "market_at_cancel": float(cells[9].replace(",", "")),
            }
        )
    df = pd.DataFrame(rows)
    df["open_dt"] = pd.to_datetime(df["open_time"], format="%Y.%m.%d %H:%M:%S")
    df["close_dt"] = pd.to_datetime(df["close_time"], format="%Y.%m.%d %H:%M:%S", errors="coerce")
    df["side"] = df["type"].apply(lambda t: "buy" if "buy" in t else "sell")
    return df


def load_orig_exit_tags(path: Path | None = None) -> tuple[set[str], set[str]]:
    path = path or get_paths()["statement"]
    html = path.read_text(encoding="utf-8", errors="replace")
    sl_t = set(re.findall(r'title="\[sl\]">(\d+)', html))
    tp_t = set(re.findall(r'title="\[tp\]">(\d+)', html))
    return sl_t, tp_t


def orig_exit_label(ticket: str, sl_t: set[str], tp_t: set[str]) -> str:
    t = str(ticket)
    if t in sl_t:
        return "sl"
    if t in tp_t:
        return "tp"
    return "other"
