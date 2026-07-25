"""形态档案：服务端 JSON + 截图存储。"""

from __future__ import annotations

import base64
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from src.core.config import writable_data_dir

PATTERN_TIMEFRAMES = ("5m", "15m", "30m", "1h", "4h")
PATTERN_OUTCOMES = ("", "success", "fail")


def _normalize_outcome(raw) -> str:
    v = str(raw or "").strip()
    if v in ("success", "fail"):
        return v
    return ""

_PATTERN_SHOT_RE = re.compile(
    r"^pattern-[a-zA-Z0-9_-]+-(5m|15m|30m|1h|4h)\.jpg$"
)


def pattern_cases_path() -> Path:
    return writable_data_dir() / "pattern_cases.json"


def pattern_screenshots_dir() -> Path:
    d = writable_data_dir() / "pattern_screenshots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def pattern_screenshot_filename(case_id: str, timeframe: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", case_id)
    return f"pattern-{safe}-{timeframe}.jpg"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_store() -> dict:
    fp = pattern_cases_path()
    if not fp.exists():
        return {"version": 3, "types": [], "tags": [], "cases": []}
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"version": 3, "types": [], "tags": [], "cases": []}
    if not isinstance(data.get("types"), list):
        data["types"] = []
    if not isinstance(data.get("tags"), list):
        data["tags"] = []
    if not isinstance(data.get("cases"), list):
        data["cases"] = []
    return data


def _save_store(data: dict) -> None:
    fp = pattern_cases_path()
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _find_case(store: dict, case_id: str) -> dict | None:
    for c in store["cases"]:
        if c.get("id") == case_id:
            return c
    return None


def _pattern_label(pattern_type: str) -> str:
    store = _load_store()
    for pt in store.get("types", []):
        if pt.get("id") == pattern_type:
            return str(pt.get("label") or pattern_type)
    return pattern_type


def list_types() -> list[dict]:
    store = _load_store()
    rows = list(store.get("types") or [])
    rows.sort(key=lambda x: x.get("created_at", ""))
    return rows


def get_type(type_id: str) -> dict | None:
    store = _load_store()
    row = _find_type(store, type_id)
    return dict(row) if row else None


def _find_type(store: dict, type_id: str) -> dict | None:
    for pt in store.get("types") or []:
        if pt.get("id") == type_id:
            return pt
    return None


def create_type(body: dict) -> dict:
    label = str(body.get("label", "")).strip()
    if not label:
        raise ValueError("label required")
    type_id = str(body.get("id") or f"pt-{uuid.uuid4().hex[:10]}")
    now = _now_iso()
    row = {"id": type_id, "label": label, "notes": str(body.get("notes") or ""), "created_at": now, "updated_at": now}
    store = _load_store()
    if _find_type(store, type_id):
        raise ValueError("type id already exists")
    store.setdefault("types", []).append(row)
    _save_store(store)
    return row


def update_type(type_id: str, body: dict) -> dict | None:
    store = _load_store()
    row = _find_type(store, type_id)
    if not row:
        return None
    if "label" in body:
        label = str(body["label"]).strip()
        if not label:
            raise ValueError("label required")
        row["label"] = label
    if "notes" in body:
        row["notes"] = str(body.get("notes") or "")
    row["updated_at"] = _now_iso()
    for case in store.get("cases") or []:
        if case.get("pattern_type") == type_id:
            case["pattern_label"] = row["label"]
    _save_store(store)
    return row


def delete_type(type_id: str) -> bool:
    store = _load_store()
    if not _find_type(store, type_id):
        return False
    for case in store.get("cases") or []:
        if case.get("pattern_type") == type_id:
            raise ValueError("type in use by pattern cases")
    store["types"] = [pt for pt in store.get("types") or [] if pt.get("id") != type_id]
    _save_store(store)
    return True


def _find_tag(store: dict, tag_id: str) -> dict | None:
    for row in store.get("tags") or []:
        if row.get("id") == tag_id:
            return row
    return None


def list_tags() -> list[dict]:
    store = _load_store()
    rows = list(store.get("tags") or [])
    rows.sort(key=lambda x: x.get("created_at", ""))
    return rows


def get_tag(tag_id: str) -> dict | None:
    store = _load_store()
    row = _find_tag(store, tag_id)
    return dict(row) if row else None


def create_tag(body: dict) -> dict:
    label = str(body.get("label", "")).strip()
    if not label:
        raise ValueError("label required")
    tag_id = str(body.get("id") or f"tg-{uuid.uuid4().hex[:10]}")
    now = _now_iso()
    row = {"id": tag_id, "label": label, "created_at": now, "updated_at": now}
    store = _load_store()
    if _find_tag(store, tag_id):
        raise ValueError("tag id already exists")
    for existing in store.get("tags") or []:
        if str(existing.get("label", "")).strip().lower() == label.lower():
            raise ValueError("tag label already exists")
    store.setdefault("tags", []).append(row)
    _save_store(store)
    return row


def update_tag(tag_id: str, body: dict) -> dict | None:
    store = _load_store()
    row = _find_tag(store, tag_id)
    if not row:
        return None
    if "label" in body:
        label = str(body["label"]).strip()
        if not label:
            raise ValueError("label required")
        for existing in store.get("tags") or []:
            if existing.get("id") != tag_id and str(existing.get("label", "")).strip().lower() == label.lower():
                raise ValueError("tag label already exists")
        row["label"] = label
    row["updated_at"] = _now_iso()
    _save_store(store)
    return row


def delete_tag(tag_id: str) -> bool:
    store = _load_store()
    if not _find_tag(store, tag_id):
        return False
    store["tags"] = [tg for tg in store.get("tags") or [] if tg.get("id") != tag_id]
    for case in store.get("cases") or []:
        tags = case.get("tags")
        if isinstance(tags, list) and tag_id in tags:
            case["tags"] = [t for t in tags if t != tag_id]
    _save_store(store)
    return True


def _normalize_case_tags(raw, store: dict | None = None) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        return []
    store = store or _load_store()
    valid = {t.get("id") for t in store.get("tags") or [] if t.get("id")}
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        tid = str(item).strip()
        if tid and tid in valid and tid not in seen:
            out.append(tid)
            seen.add(tid)
    return out


def _public_case(case: dict, store: dict | None = None) -> dict:
    row = dict(case)
    row["tags"] = _normalize_case_tags(row.get("tags"), store)
    return row


def list_cases(
    *,
    pattern_type: str | None = None,
    status: str | None = None,
    outcome: str | None = None,
    tag: str | None = None,
    anchor_from: int | None = None,
    anchor_to: int | None = None,
) -> list[dict]:
    store = _load_store()
    rows = []
    for c in store["cases"]:
        if pattern_type and c.get("pattern_type") != pattern_type:
            continue
        if status and c.get("status") != status:
            continue
        case_outcome = _normalize_outcome(c.get("outcome"))
        if outcome == "unset":
            if case_outcome:
                continue
        elif outcome and case_outcome != outcome:
            continue
        if tag and tag not in (c.get("tags") or []):
            continue
        ts = c.get("anchor_ts")
        if anchor_from is not None and (ts is None or ts < anchor_from):
            continue
        if anchor_to is not None and (ts is None or ts > anchor_to):
            continue
        rows.append(_public_case(c, store))
    rows.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return rows


def get_case(case_id: str) -> dict | None:
    store = _load_store()
    c = _find_case(store, case_id)
    return _public_case(c, store) if c else None


def create_case(body: dict) -> dict:
    pattern_type = str(body.get("pattern_type", "")).strip()
    if not pattern_type:
        raise ValueError("pattern_type required")
    anchor_ts = int(body["anchor_ts"])
    primary_tf = str(body.get("primary_tf", "5m"))
    if primary_tf not in PATTERN_TIMEFRAMES:
        primary_tf = "5m"
    case_id = body.get("id") or f"pc-{uuid.uuid4().hex[:12]}"
    now = _now_iso()
    case = {
        "id": case_id,
        "pattern_type": pattern_type,
        "pattern_label": str(body.get("pattern_label") or _pattern_label(pattern_type)),
        "anchor_ts": anchor_ts,
        "primary_tf": primary_tf,
        "notes": str(body.get("notes") or ""),
        "outcome": _normalize_outcome(body.get("outcome")),
        "tags": _normalize_case_tags(body.get("tags")),
        "status": "draft",
        "created_at": now,
        "updated_at": now,
        "frames": {},
    }
    store = _load_store()
    if _find_case(store, case_id):
        raise ValueError("case id already exists")
    case["tags"] = _normalize_case_tags(case.get("tags"), store)
    store["cases"].append(case)
    _save_store(store)
    return _public_case(case, store)


def update_case(case_id: str, body: dict) -> dict | None:
    store = _load_store()
    case = _find_case(store, case_id)
    if not case:
        return None
    if "pattern_type" in body:
        case["pattern_type"] = str(body["pattern_type"])
        case["pattern_label"] = str(
            body.get("pattern_label") or _pattern_label(case["pattern_type"])
        )
    elif "pattern_label" in body:
        case["pattern_label"] = str(body["pattern_label"])
    if "notes" in body:
        case["notes"] = str(body["notes"] or "")
    if "outcome" in body:
        case["outcome"] = _normalize_outcome(body["outcome"])
    if "tags" in body:
        case["tags"] = _normalize_case_tags(body["tags"], store)
    if "status" in body and body["status"] in ("draft", "complete"):
        case["status"] = body["status"]
    case["updated_at"] = _now_iso()
    _save_store(store)
    return _public_case(case, store)


def delete_case(case_id: str) -> bool:
    store = _load_store()
    case = _find_case(store, case_id)
    if not case:
        return False
    frames = case.get("frames") or {}
    for frame in frames.values():
        fn = frame.get("screenshot")
        if fn:
            fp = pattern_screenshots_dir() / fn
            if fp.is_file():
                fp.unlink()
    store["cases"] = [c for c in store["cases"] if c.get("id") != case_id]
    _save_store(store)
    return True


def upload_frame(case_id: str, body: dict) -> dict | None:
    store = _load_store()
    case = _find_case(store, case_id)
    if not case:
        return None

    timeframe = str(body.get("timeframe", ""))
    if timeframe not in PATTERN_TIMEFRAMES:
        raise ValueError(f"invalid timeframe: {timeframe}")

    image = str(body.get("image", ""))
    if "," in image:
        image = image.split(",", 1)[1]
    img_bytes = base64.b64decode(image)
    if len(img_bytes) > 5_000_000:
        raise ValueError("image too large")

    fn = pattern_screenshot_filename(case_id, timeframe)
    old = (case.get("frames") or {}).get(timeframe, {})
    old_fn = old.get("screenshot")
    if old_fn and old_fn != fn:
        old_fp = pattern_screenshots_dir() / old_fn
        if old_fp.is_file():
            old_fp.unlink()

    (pattern_screenshots_dir() / fn).write_bytes(img_bytes)

    frame = {
        "timeframe": timeframe,
        "cursor_ts": int(body.get("cursor_ts", case.get("anchor_ts"))),
        "screenshot": fn,
        "view": body.get("view"),
        "captured_at": _now_iso(),
    }
    if not isinstance(case.get("frames"), dict):
        case["frames"] = {}
    case["frames"][timeframe] = frame
    case["updated_at"] = _now_iso()
    _save_store(store)
    return {
        "case": _public_case(case, store),
        "frame": frame,
        "url": f"/api/patterns/screenshot/{fn}",
    }


def is_valid_pattern_screenshot(name: str) -> bool:
    return bool(_PATTERN_SHOT_RE.match(name))
