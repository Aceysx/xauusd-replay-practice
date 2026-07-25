# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：macOS ReplayPractice.app（arm64 / x86_64 / universal2）"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).resolve().parent

_target = os.environ.get("TARGET_ARCH", "").strip().lower()
if _target in ("x86_64", "arm64", "universal2"):
    TARGET_ARCH = _target
else:
    TARGET_ARCH = None

if TARGET_ARCH == "x86_64":
    APP_SUFFIX = "-intel"
    BUNDLE_ID = "com.re-test.replay-practice.intel"
elif TARGET_ARCH == "arm64":
    APP_SUFFIX = ""
    BUNDLE_ID = "com.re-test.replay-practice"
elif TARGET_ARCH == "universal2":
    APP_SUFFIX = "-universal"
    BUNDLE_ID = "com.re-test.replay-practice.universal"
else:
    APP_SUFFIX = ""
    BUNDLE_ID = "com.re-test.replay-practice"

APP_NAME = f"ReplayPractice{APP_SUFFIX}"
BUNDLE_NAME = f"{APP_NAME}.app"

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "config.yaml"), "."),
    (str(ROOT / "Files"), "Files"),
    (str(ROOT / "report"), "report"),
]
datas += collect_data_files("webview", include_py_files=False)

hiddenimports = [
    "pandas",
    "yaml",
    "src",
    "src.app",
    "src.app.desktop",
    "src.server",
    "src.server.replay_server",
    "src.server.history",
    "src.core",
    "src.core.config",
    "src.core.m5",
    "src.core.timezone",
    "src.core.statement",
    "src.engine",
    "src.engine.simulator",
    "src.engine.limits",
    "webview",
    "bottle",
    "proxy_tools",
    "objc",
    "WebKit",
    "Foundation",
    "AppKit",
]

a = Analysis(
    [str(ROOT / "src" / "app" / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pandas.tests",
        "pytest",
        "matplotlib",
        "torch",
        "torchvision",
        "tensorflow",
        "IPython",
        "notebook",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=TARGET_ARCH,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

app = BUNDLE(
    coll,
    name=BUNDLE_NAME,
    icon=None,
    bundle_identifier=BUNDLE_ID,
)
