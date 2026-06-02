# 回测练习工具

基于 `Files/` 目录 M5 K 线，在浏览器中 **回放 K 线** 并 **模拟下单**（SL/TP）。

## 快速开始

```bash
pip install -r requirements.txt
python3 -m src.server.replay_server
```

浏览器打开 **http://127.0.0.1:8765/**（端口被占用时会自动尝试 8766–8769）。

## 使用说明

- 打开后默认停在 **最新 K 线**，展示最近约 30 个交易日（见 `config.yaml` 的 `default_trading_days`）。
- **拖动进度条** 回看历史；**播放 / 单步** 从当前位置向前推演。
- **选择日期 → 跳转** 跳到某一天；**最新** 回到最后一根 K 线。
- 右侧开仓、设 SL/TP，回放推进时按 bar 高低价判断止损/止盈。

## 配置

编辑 `config.yaml`：

- `paths`：交割单与 M5 路径
- `strategy.default_sl` / `default_tp`：模拟下单默认点数
- `replay.default_trading_days`：首次打开默认加载最近 N 个交易日

## 目录说明

| 路径 | 说明 |
|------|------|
| `src/core/` | 交割单解析、M5 加载、时区 |
| `src/engine/` | 回测模拟、挂单分析 |
| `src/server/replay_server.py` | 主 Web 服务 |
| `web/` | 复盘练习界面（仅 K 线 + 模拟下单） |
| `web/legacy/` | 旧版分析报告页（可选） |
| `report/` | 详细回测报告与 CSV |

## 回测与报告（CLI）

```bash
# 市价单 SL/TP 对比
python backtest_sl7.py

# 取消挂单分析
python analyze_limits.py

# 生成 report/ 完整报告
python scripts/run_report.py
```

## API（练习服务）

| 端点 | 说明 |
|------|------|
| `GET /api/config` | 默认 SL/TP、加载区间、可选日期范围 |
| `GET /api/bars?start=&end=` | M5 OHLC（UTC unix） |

模拟下单在 **浏览器内** 计算；同 bar 同时触及 SL/TP 时 **先 SL**。

## 时区

交割单时间为经纪商 **UTC+3**，M5 CSV 为 **UTC**；图表与历史标记已做转换，详见 `src/core/timezone.py`。
