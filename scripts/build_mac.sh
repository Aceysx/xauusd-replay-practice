#!/usr/bin/env bash
# 构建 macOS ReplayPractice.app
# 用法: ./scripts/build_mac.sh [arm64|intel|x86_64|universal2|all]
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
用法: ./scripts/build_mac.sh [架构]

架构:
  arm64      Apple Silicon → dist/ReplayPractice.app
  intel      同 x86_64     → dist/ReplayPractice-intel.app
  x86_64     Intel Mac     → dist/ReplayPractice-intel.app
  universal2 通用包        → dist/ReplayPractice-universal.app
  all        同时构建 arm64 与 Intel

示例:
  ./scripts/build_mac.sh
  ./scripts/build_mac.sh intel
  ./scripts/build_mac.sh all

在 Apple Silicon 上构建 Intel 版需要:
  - 已安装 Rosetta
  - 本机有 x86_64 版 Python（如 python.org 通用安装包或 Homebrew intel python）

可指定解释器:
  PYTHON=/Library/Frameworks/Python.framework/Versions/3.10/bin/python3 ./scripts/build_mac.sh intel
EOF
}

resolve_default_arch() {
  case "$(uname -m)" in
    arm64) echo "arm64" ;;
    x86_64) echo "x86_64" ;;
    *) echo "arm64" ;;
  esac
}

python_runs_as() {
  local py="$1"
  local want="$2"
  "$py" -c "import platform; raise SystemExit(0 if platform.machine() == '$want' else 1)" 2>/dev/null
}

find_arm_python() {
  if [[ -n "${PYTHON:-}" ]] && command -v "$PYTHON" >/dev/null 2>&1; then
    if python_runs_as "$PYTHON" arm64; then
      echo "$PYTHON"
      return 0
    fi
  fi
  local c
  for c in python3.11 python3.12 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && python_runs_as "$(command -v "$c")" arm64; then
      echo "$(command -v "$c")"
      return 0
    fi
  done
  return 1
}

STANDALONE_INTEL_PY_DIR=".build-python-x86_64/python"
STANDALONE_INTEL_PY_URL="https://github.com/indygreg/python-build-standalone/releases/download/20241016/cpython-3.11.10%2B20241016-x86_64-apple-darwin-install_only.tar.gz"

bootstrap_intel_python() {
  local py="$STANDALONE_INTEL_PY_DIR/bin/python3"
  if [[ -x "$py" ]]; then
    if [[ "$(uname -m)" == "arm64" ]]; then
      arch -x86_64 "$py" -c "import platform; assert platform.machine()=='x86_64'" 2>/dev/null && echo "$py" && return 0
    elif "$py" -c "import platform; assert platform.machine()=='x86_64'" 2>/dev/null; then
      echo "$py"
      return 0
    fi
  fi
  echo "下载独立 x86_64 Python 3.11（用于 Intel 打包）…"
  local tmpdir=".build-python-x86_64"
  local tar="$tmpdir/cpython.tar.gz"
  mkdir -p "$tmpdir"
  curl -fsSL "$STANDALONE_INTEL_PY_URL" -o "$tar"
  rm -rf "$tmpdir/python"
  tar -xzf "$tar" -C "$tmpdir"
  rm -f "$tar"
  if [[ ! -x "$py" ]]; then
    echo "独立 Python 安装失败" >&2
    return 1
  fi
  echo "$py"
}

find_intel_python() {
  local py
  py="$(bootstrap_intel_python 2>/dev/null)" && echo "$py" && return 0

  if [[ -n "${PYTHON:-}" ]] && command -v "$PYTHON" >/dev/null 2>&1; then
    if [[ "$(uname -m)" == "arm64" ]]; then
      if arch -x86_64 "$PYTHON" -c "import platform; assert platform.machine()=='x86_64'" 2>/dev/null; then
        echo "$PYTHON"
        return 0
      fi
    elif python_runs_as "$PYTHON" x86_64; then
      echo "$PYTHON"
      return 0
    fi
  fi
  local candidates=(
    "${STANDALONE_INTEL_PY_DIR}/bin/python3"
    /Library/Frameworks/Python.framework/Versions/3.11/bin/python3
    /Library/Frameworks/Python.framework/Versions/3.10/bin/python3
    /usr/local/bin/python3.11
    /usr/local/bin/python3.10
    /usr/local/bin/python3-intel64
    /usr/local/bin/python3
  )
  local py
  for py in "${candidates[@]}"; do
    [[ -x "$py" ]] || continue
    if [[ "$(uname -m)" == "arm64" ]]; then
      if arch -x86_64 "$py" -c "import platform; assert platform.machine()=='x86_64'" 2>/dev/null; then
        echo "$py"
        return 0
      fi
    elif python_runs_as "$py" x86_64; then
      echo "$py"
      return 0
    fi
  done
  return 1
}

find_universal_python() {
  if [[ -n "${PYTHON:-}" ]] && command -v "$PYTHON" >/dev/null 2>&1; then
  if "$PYTHON" -c "import platform; m=platform.machine(); raise SystemExit(0 if m in ('universal2','arm64','x86_64') else 1)" 2>/dev/null; then
      echo "$PYTHON"
      return 0
    fi
  fi
  local py
  for py in \
    /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/3.10/bin/python3; do
    if [[ -x "$py" ]]; then
      echo "$py"
      return 0
    fi
  done
  return 1
}

venv_matches_arch() {
  local venv="$1"
  local want="$2"
  local pybin="$venv/bin/python3"
  [[ -x "$pybin" ]] || pybin="$venv/bin/python"
  [[ -x "$pybin" ]] || return 1
  local run_prefix=()
  if [[ "$(uname -m)" == "arm64" && "$want" == "x86_64" ]]; then
    run_prefix=(arch -x86_64)
  fi
  local got
  got=$("${run_prefix[@]}" "$pybin" -c "import platform; print(platform.machine())" 2>/dev/null) || return 1
  [[ "$got" == "$want" ]]
}

build_one() {
  local arch="$1"
  local venv=".venv-build-${arch}"
  local run_prefix=()
  local py=""

  case "$arch" in
    arm64)
      py="$(find_arm_python)" || {
        echo "未找到 arm64 Python。请安装 python3 或设置 PYTHON=..." >&2
        exit 1
      }
      ;;
    x86_64)
      py="$(find_intel_python)" || {
        echo "未找到可用于 Intel 打包的 x86_64 Python。" >&2
        echo "在 Apple Silicon 上请安装 python.org 通用安装包，或: brew install python@3.11" >&2
        echo "也可: PYTHON=/path/to/x86_64/python3 ./scripts/build_mac.sh intel" >&2
        exit 1
      }
      if [[ "$(uname -m)" == "arm64" ]]; then
        run_prefix=(arch -x86_64)
      fi
      ;;
    universal2)
      py="$(find_universal_python)" || {
        echo "未找到 universal2 Python（建议 python.org 3.10/3.11 通用安装包）。" >&2
        exit 1
      }
      ;;
    *)
      echo "不支持的架构: $arch" >&2
      exit 1
      ;;
  esac

  echo "==> 构建 ${arch}"
  echo "    Python: $py"
  echo "    venv:   ${venv}"

  if [[ -d "$venv" ]] && ! venv_matches_arch "$venv" "$arch"; then
    echo "    删除旧 venv（Python 架构与目标 ${arch} 不一致）"
    rm -rf "$venv"
  fi

  if [[ ! -d "$venv" ]]; then
    "${run_prefix[@]}" "$py" -m venv "$venv"
    if ! venv_matches_arch "$venv" "$arch"; then
      echo "venv 架构校验失败（期望 ${arch}）。" >&2
      rm -rf "$venv"
      exit 1
    fi
  fi
  # shellcheck disable=SC1091
  source "$venv/bin/activate"

  "${run_prefix[@]}" python -m pip install -U pip
  "${run_prefix[@]}" python -m pip install -r requirements-desktop.txt

  export TARGET_ARCH="$arch"
  "${run_prefix[@]}" python -m PyInstaller packaging/replay-mac.spec --noconfirm --clean

  deactivate 2>/dev/null || true

  case "$arch" in
    x86_64) echo "完成: $(pwd)/dist/ReplayPractice-intel.app" ;;
    universal2) echo "完成: $(pwd)/dist/ReplayPractice-universal.app" ;;
    *) echo "完成: $(pwd)/dist/ReplayPractice.app" ;;
  esac
}

ARCH="${1:-}"
if [[ "$ARCH" == "-h" || "$ARCH" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "$ARCH" ]]; then
  ARCH="$(resolve_default_arch)"
fi
if [[ "$ARCH" == "intel" ]]; then
  ARCH="x86_64"
fi

case "$ARCH" in
  all)
    build_one arm64
    build_one x86_64
    echo ""
    echo "全部完成:"
    echo "  dist/ReplayPractice.app        (Apple Silicon)"
    echo "  dist/ReplayPractice-intel.app  (Intel)"
    ;;
  arm64|x86_64|universal2)
    build_one "$ARCH"
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

echo "截图等可写数据: ~/Library/Application Support/ReplayPractice/"
