#!/usr/bin/env python3
"""回测复盘练习工具 — K 线回放 + 模拟下单 HTTP 服务。"""

import base64
import json
import mimetypes
import os
import re
import sys
from collections import OrderedDict
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from src.core.config import get_config, get_paths, replay_defaults, strategy_defaults, timezone_config, writable_data_dir
from src.core.m5 import (
    bars_to_chart_json,
    default_replay_range,
    list_available_dates,
    load_bars_for_timeframe,
    normalize_timeframe,
    pick_random_trading_day,
    range_before_trading_day,
    timeframe_bar_seconds,
)
from src.server.order_records import clear_order_store, load_order_store, save_order_store
from src.server.pattern_cases import (
    create_case,
    create_tag,
    create_type,
    delete_case,
    delete_tag,
    delete_type,
    get_case,
    get_tag,
    get_type,
    is_valid_pattern_screenshot,
    list_cases,
    list_tags,
    list_types,
    pattern_screenshots_dir,
    update_case,
    update_tag,
    update_type,
    upload_frame,
)


def _parse_until(qs: dict) -> pd.Timestamp | None:
    raw = qs.get("until", [None])[0]
    if not raw:
        return None
    try:
        return pd.Timestamp(int(raw), unit="s")
    except (TypeError, ValueError):
        return None


_API_BARS_CACHE: OrderedDict[tuple, pd.DataFrame] = OrderedDict()
_API_BARS_CACHE_MAX = 48


def _load_bars_resampled(start: str, end: str, tf: str, until: pd.Timestamp | None) -> pd.DataFrame:
    ukey = int(until.timestamp()) if until is not None else None
    key = (start, end, tf, ukey)
    cached = _API_BARS_CACHE.get(key)
    if cached is not None:
        _API_BARS_CACHE.move_to_end(key)
        return cached
    bars = load_bars_for_timeframe(start, end, tf, until=until)
    _API_BARS_CACHE[key] = bars
    _API_BARS_CACHE.move_to_end(key)
    while len(_API_BARS_CACHE) > _API_BARS_CACHE_MAX:
        _API_BARS_CACHE.popitem(last=False)
    return bars


def replay_root() -> Path:
    return get_paths()["root"]


def web_dir() -> Path:
    return replay_root() / "web"


def practice_screenshots_dir() -> Path:
    return writable_data_dir() / "practice_screenshots"


_SCREENSHOT_NAME_RE = re.compile(r"^order-\d+\.jpg$")


def practice_screenshot_filename(order_id: int) -> str:
    return f"order-{int(order_id)}.jpg"


class ReplayHandler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(web_dir()), **kwargs)

    def log_message(self, fmt, *args):
        if len(args) > 1 and str(args[1]) == "200":
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/config":
            self._send_json(self._api_config())
            return
        if path == "/api/bars":
            self._send_json(self._api_bars(qs))
            return
        if path == "/api/random_replay_start":
            self._handle_random_replay_start(qs)
            return
        if path == "/api/dates":
            self._send_json({"dates": list_available_dates()})
            return
        if path.startswith("/api/practice/screenshot/"):
            name = path.rsplit("/", 1)[-1]
            self._serve_practice_screenshot(name)
            return
        if path == "/api/orders":
            self._send_json(load_order_store())
            return
        if path == "/api/pattern-types":
            self._handle_pattern_types_list()
            return
        if path.startswith("/api/pattern-types/"):
            type_id = path[len("/api/pattern-types/") :].split("?")[0].strip("/")
            if type_id:
                row = get_type(type_id)
                if row is None:
                    self.send_error(404, "pattern type not found")
                    return
                self._send_json(row)
                return
        if path == "/api/pattern-tags":
            self._handle_pattern_tags_list()
            return
        if path.startswith("/api/pattern-tags/"):
            tag_id = path[len("/api/pattern-tags/") :].split("?")[0].strip("/")
            if tag_id:
                row = get_tag(tag_id)
                if row is None:
                    self.send_error(404, "pattern tag not found")
                    return
                self._send_json(row)
                return
        if path == "/api/patterns":
            self._handle_patterns_list(qs)
            return
        if path.startswith("/api/patterns/screenshot/"):
            name = path.rsplit("/", 1)[-1].split("?")[0]
            self._serve_pattern_screenshot(name)
            return
        if path.startswith("/api/patterns/"):
            case_id = path[len("/api/patterns/") :].split("?")[0].strip("/")
            if case_id:
                detail = get_case(case_id)
                if detail is None:
                    self.send_error(404, "pattern case not found")
                    return
                self._send_json(detail)
                return
        if path in ("", "/"):
            self._serve_file(web_dir() / "index.html")
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/practice/screenshot":
            self._handle_practice_screenshot_upload()
            return
        if parsed.path == "/api/pattern-types":
            self._handle_pattern_type_create()
            return
        if parsed.path == "/api/pattern-tags":
            self._handle_pattern_tag_create()
            return
        if parsed.path == "/api/patterns":
            self._handle_pattern_create()
            return
        m = re.match(r"^/api/patterns/([^/]+)/frames$", parsed.path)
        if m:
            self._handle_pattern_frame_upload(m.group(1))
            return
        self.send_error(405, "Method Not Allowed")

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/orders":
            self._handle_orders_save()
            return
        m = re.match(r"^/api/pattern-types/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_type_update(m.group(1))
            return
        m = re.match(r"^/api/pattern-tags/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_tag_update(m.group(1))
            return
        m = re.match(r"^/api/patterns/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_update(m.group(1))
            return
        self.send_error(405, "Method Not Allowed")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/orders":
            self._send_json(clear_order_store())
            return
        if parsed.path.startswith("/api/practice/screenshot/"):
            name = parsed.path.rsplit("/", 1)[-1]
            self._handle_practice_screenshot_delete(name)
            return
        m = re.match(r"^/api/pattern-types/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_type_delete(m.group(1))
            return
        m = re.match(r"^/api/pattern-tags/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_tag_delete(m.group(1))
            return
        m = re.match(r"^/api/patterns/([^/]+)$", parsed.path)
        if m:
            self._handle_pattern_delete(m.group(1))
            return
        self.send_error(405, "Method Not Allowed")

    def _handle_orders_save(self) -> None:
        try:
            body = self._read_json_body()
            store = save_order_store(body)
            self._send_json(store)
        except (TypeError, ValueError, json.JSONDecodeError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _serve_practice_screenshot(self, name: str) -> None:
        if not _SCREENSHOT_NAME_RE.match(name):
            self.send_error(400)
            return
        fp = practice_screenshots_dir() / name
        if not fp.exists() or not fp.is_file():
            self.send_error(404)
            return
        self._serve_file(fp)

    def _handle_practice_screenshot_upload(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            order_id = int(data["order_id"])
            image = str(data.get("image", ""))
            if "," in image:
                image = image.split(",", 1)[1]
            img_bytes = base64.b64decode(image)
            if len(img_bytes) > 5_000_000:
                self._send_json_error(413, {"error": "image too large"})
                return
            fn = practice_screenshot_filename(order_id)
            d = practice_screenshots_dir()
            d.mkdir(parents=True, exist_ok=True)
            (d / fn).write_bytes(img_bytes)
            self._send_json({"filename": fn, "url": f"/api/practice/screenshot/{fn}"})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_practice_screenshot_delete(self, name: str) -> None:
        if not _SCREENSHOT_NAME_RE.match(name):
            self.send_error(400)
            return
        fp = practice_screenshots_dir() / name
        if fp.exists() and fp.is_file():
            fp.unlink()
        self._send_json({"ok": True})

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _handle_pattern_types_list(self) -> None:
        self._send_json({"types": list_types()})

    def _handle_pattern_type_create(self) -> None:
        try:
            body = self._read_json_body()
            row = create_type(body)
            self._send_json(row, status=201)
        except (TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_type_update(self, type_id: str) -> None:
        try:
            body = self._read_json_body()
            row = update_type(type_id, body)
            if row is None:
                self.send_error(404, "pattern type not found")
                return
            self._send_json(row)
        except (TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_type_delete(self, type_id: str) -> None:
        try:
            if not delete_type(type_id):
                self.send_error(404, "pattern type not found")
                return
            self._send_json({"ok": True})
        except ValueError as e:
            self._send_json_error(409, {"error": str(e)})

    def _handle_pattern_tags_list(self) -> None:
        self._send_json({"tags": list_tags()})

    def _handle_pattern_tag_create(self) -> None:
        try:
            body = self._read_json_body()
            row = create_tag(body)
            self._send_json(row, status=201)
        except (TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_tag_update(self, tag_id: str) -> None:
        try:
            body = self._read_json_body()
            row = update_tag(tag_id, body)
            if row is None:
                self.send_error(404, "pattern tag not found")
                return
            self._send_json(row)
        except (TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_tag_delete(self, tag_id: str) -> None:
        if not delete_tag(tag_id):
            self.send_error(404, "pattern tag not found")
            return
        self._send_json({"ok": True})

    def _handle_patterns_list(self, qs: dict) -> None:
        pattern_type = qs.get("type", [None])[0]
        status = qs.get("status", [None])[0]
        outcome = qs.get("outcome", [None])[0]
        tag = qs.get("tag", [None])[0]
        anchor_from = qs.get("anchor_from", [None])[0]
        anchor_to = qs.get("anchor_to", [None])[0]
        try:
            af = int(anchor_from) if anchor_from else None
            at = int(anchor_to) if anchor_to else None
        except ValueError:
            self._send_json_error(400, {"error": "invalid anchor_from/anchor_to"})
            return
        cases = list_cases(
            pattern_type=pattern_type,
            status=status,
            outcome=outcome,
            tag=tag,
            anchor_from=af,
            anchor_to=at,
        )
        self._send_json({"cases": cases})

    def _handle_pattern_create(self) -> None:
        try:
            body = self._read_json_body()
            case = create_case(body)
            self._send_json(case, status=201)
        except (KeyError, TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_update(self, case_id: str) -> None:
        try:
            body = self._read_json_body()
            case = update_case(case_id, body)
            if case is None:
                self.send_error(404, "pattern case not found")
                return
            self._send_json(case)
        except (TypeError, ValueError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _handle_pattern_delete(self, case_id: str) -> None:
        if not delete_case(case_id):
            self.send_error(404, "pattern case not found")
            return
        self._send_json({"ok": True})

    def _handle_pattern_frame_upload(self, case_id: str) -> None:
        try:
            body = self._read_json_body()
            result = upload_frame(case_id, body)
            if result is None:
                self.send_error(404, "pattern case not found")
                return
            self._send_json(result)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
            self._send_json_error(400, {"error": str(e)})

    def _serve_pattern_screenshot(self, name: str) -> None:
        if not is_valid_pattern_screenshot(name):
            self.send_error(400)
            return
        fp = pattern_screenshots_dir() / name
        if not fp.exists() or not fp.is_file():
            self.send_error(404)
            return
        self._serve_file(fp)

    def _api_config(self) -> dict:
        dates = list_available_dates()
        replay = replay_defaults()
        start, end = default_replay_range(replay["initial_trading_days"])
        strat = strategy_defaults()
        tz = timezone_config()
        return {
            "api_version": 3,
            "features": {
                "practice_screenshot": True,
                "pattern_journal": True,
                "order_records_disk": True,
            },
            "pattern_timeframes": ["5m", "15m", "30m", "1h", "4h"],
            "default_sl": strat["sl"],
            "default_tp": strat["tp"],
            "default_range": {"start": start, "end": end},
            "first_date": dates[0] if dates else start,
            "last_date": dates[-1] if dates else end,
            "chart_visible_bars": replay["chart_visible_bars"],
            "initial_trading_days": replay["initial_trading_days"],
            "load_chunk_trading_days": replay["load_chunk_trading_days"],
            "bar_ms_per_candle_at_1x": replay["bar_ms_per_candle_at_1x"],
            "default_timeframe": replay["default_timeframe"],
            "timeframes": replay["timeframes"],
            "random_backtest_min_forward_days": replay["random_backtest_min_forward_days"],
            "broker_utc_offset_hours": tz["broker_utc_offset_hours"],
        }

    def _handle_random_replay_start(self, qs: dict) -> None:
        replay = replay_defaults()
        raw = qs.get("min_forward_days", [None])[0]
        min_fwd = int(raw) if raw is not None else replay["random_backtest_min_forward_days"]
        try:
            self._send_json(pick_random_trading_day(min_fwd))
        except ValueError as e:
            self._send_json_error(400, {"error": str(e)})

    def _api_bars(self, qs: dict) -> dict:
        tf = normalize_timeframe(qs.get("tf", [None])[0] or qs.get("timeframe", [None])[0])
        start = qs.get("start", [None])[0]
        end = qs.get("end", [None])[0]
        days = qs.get("days", [None])[0]
        before = qs.get("before", [None])[0]
        until = _parse_until(qs)

        if before and days:
            n = int(days)
            span = range_before_trading_day(before, n)
            if span is None:
                return self._bars_payload(pd.DataFrame(), before, before, tf=tf, has_more=False)
            start, end = span
            bars = _load_bars_resampled(start, end, tf, until)
            dates = list_available_dates()
            has_more = dates.index(start) > 0 if start in dates else False
            return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

        if days and not start:
            n = int(days)
            dates = list_available_dates()
            end = end or dates[-1]
            i = dates.index(end) if end in dates else len(dates) - 1
            start = dates[max(0, i - n + 1)]
            bars = _load_bars_resampled(start, end, tf, until)
            has_more = start != dates[0]
            return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

        if not start or not end:
            start, end = default_replay_range()
        bars = _load_bars_resampled(start, end, tf, until)
        dates = list_available_dates()
        has_more = start != dates[0] if dates else False
        return self._bars_payload(bars, start, end, tf=tf, has_more=has_more)

    def _bars_payload(
        self, bars, start: str, end: str, tf: str = "5m", has_more: bool = False
    ) -> dict:
        ohlc = bars_to_chart_json(bars)
        times = [b["time"] for b in ohlc]
        return {
            "start": start,
            "end": end,
            "timeframe": tf,
            "bar_seconds": timeframe_bar_seconds(tf),
            "count": len(ohlc),
            "bars": ohlc,
            "first_ts": times[0] if times else None,
            "last_ts": times[-1] if times else None,
            "has_more_before": has_more,
        }

    def _serve_file(self, fp: Path):
        content = fp.read_bytes()
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def _send_json(self, data, status: int = 200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json_error(self, status: int, payload: dict) -> None:
        self._send_json(payload, status=status)


def create_server(
    host: str | None = None,
    ports: range | list[int] | None = None,
) -> tuple[ThreadingHTTPServer, int]:
    """创建并绑定 HTTP 服务；返回 (server, port)。"""
    web_dir().mkdir(exist_ok=True)
    practice_screenshots_dir().mkdir(parents=True, exist_ok=True)
    pattern_screenshots_dir().mkdir(parents=True, exist_ok=True)

    cfg = get_config()
    bind_host = host if host is not None else cfg.get("server", {}).get("host", "0.0.0.0")
    env_port = os.environ.get("PORT")
    if ports is not None:
        ports_to_try = list(ports)
    elif env_port:
        ports_to_try = [int(env_port)]
    else:
        base_port = replay_defaults()["port"]
        ports_to_try = list(range(base_port, base_port + 5))

    for try_port in ports_to_try:
        try:
            server = ThreadingHTTPServer((bind_host, try_port), ReplayHandler)
            return server, try_port
        except OSError as e:
            if getattr(e, "errno", None) != 48:
                raise
    raise OSError("端口均被占用，请设置 PORT 或修改 config.yaml 中 replay.port")


def main():
    server, port = create_server()
    host = server.server_address[0]
    print(f"\n复盘练习工具 → http://{host}:{port}/\n")
    server.serve_forever()


if __name__ == "__main__":
    root = replay_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    main()
