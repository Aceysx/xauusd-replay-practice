#!/usr/bin/env python3
"""生成完整回测报告（report/）。"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "report_latest_strategy.py"


def main():
    subprocess.run([sys.executable, str(SCRIPT)], cwd=str(ROOT), check=True)


if __name__ == "__main__":
    main()
