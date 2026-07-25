#!/usr/bin/env bash
# 快捷脚本：仅构建 Intel (x86_64) 版
set -euo pipefail
exec "$(dirname "$0")/build_mac.sh" x86_64
