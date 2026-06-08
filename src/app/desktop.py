#!/usr/bin/env python3
"""macOS 桌面入口：内嵌 WebView + 本地 replay HTTP 服务。"""

from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path


def _ensure_sys_path() -> None:
    root = Path(__file__).resolve().parents[2]
    if getattr(sys, "frozen", False):
        root = Path(sys._MEIPASS)
    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


_ensure_sys_path()

from src.server.replay_server import create_server  # noqa: E402


def wait_for_port(host: str, port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"服务未在 {timeout}s 内就绪: {host}:{port}")


def main() -> None:
    import webview

    server, port = create_server(host="127.0.0.1")
    thread = threading.Thread(target=server.serve_forever, name="replay-http", daemon=True)
    thread.start()
    wait_for_port("127.0.0.1", port)

    url = f"http://127.0.0.1:{port}/"
    window = webview.create_window("回测练习", url, width=1280, height=800, min_size=(900, 600))
    webview.start()
    server.shutdown()
    thread.join(timeout=3)


if __name__ == "__main__":
    main()
