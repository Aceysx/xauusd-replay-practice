#!/usr/bin/env bash
# 构建 macOS ReplayPractice.app（使用隔离 venv，避免 PyInstaller 扫入 torch 等无关包）
set -euo pipefail
cd "$(dirname "$0")/.."

VENV=".venv-build"
PYTHON="${PYTHON:-python3.11}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  PYTHON=python3
fi
if [[ ! -d "$VENV" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -U pip
python -m pip install -r requirements-desktop.txt
python -m PyInstaller packaging/replay-mac.spec --noconfirm --clean

echo ""
echo "构建完成: $(pwd)/dist/ReplayPractice.app"
echo "运行: open dist/ReplayPractice.app"
