"""练习下单记录：服务端 JSON 持久化。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from src.core.config import writable_data_dir


def order_records_path() -> Path:
    return writable_data_dir() / "order_records.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_store() -> dict:
    return {"version": 1, "updated_at": None, "nextOrderId": 1, "orderRecords": []}


def load_order_store() -> dict:
    fp = order_records_path()
    if not fp.exists():
        return _empty_store()
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty_store()
    if not isinstance(data, dict):
        return _empty_store()
    if not isinstance(data.get("orderRecords"), list):
        data["orderRecords"] = []
    try:
        next_id = int(data.get("nextOrderId") or 1)
    except (TypeError, ValueError):
        next_id = 1
    data["nextOrderId"] = max(1, next_id)
    data["version"] = 1
    return data


def save_order_store(body: dict | None) -> dict:
    """整表覆盖写入；返回规范化后的 store。"""
    body = body if isinstance(body, dict) else {}
    records = body.get("orderRecords")
    if not isinstance(records, list):
        records = []
    try:
        next_id = int(body.get("nextOrderId") or 1)
    except (TypeError, ValueError):
        next_id = 1
    for r in records:
        if not isinstance(r, dict):
            continue
        try:
            rid = int(r.get("id"))
            if rid >= next_id:
                next_id = rid + 1
        except (TypeError, ValueError):
            pass
    store = {
        "version": 1,
        "updated_at": _now_iso(),
        "nextOrderId": max(1, next_id),
        "orderRecords": [r for r in records if isinstance(r, dict)],
    }
    fp = order_records_path()
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    return store


def clear_order_store() -> dict:
    return save_order_store(_empty_store())
