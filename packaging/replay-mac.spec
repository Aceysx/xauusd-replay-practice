# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：macOS ReplayPractice.app"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).resolve().parent

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
    name="ReplayPractice",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
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
    name="ReplayPractice",
)

app = BUNDLE(
    coll,
    name="ReplayPractice.app",
    icon=None,
    bundle_identifier="com.re-test.replay-practice",
)
