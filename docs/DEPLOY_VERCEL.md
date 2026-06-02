# 部署到 Vercel

本项目 **不能** 把现在的 `python3 -m src.server.replay_server` 原样丢到 Vercel：Vercel 适合静态站点和短时 Serverless，不适合长期运行的 Python 线程服务 + 几百 MB 的 `Files/` CSV。

推荐 **前后端分离**：

| 部分 | 部署位置 | 说明 |
|------|----------|------|
| `web/` 静态资源 | **Vercel** | HTML / JS / CSS / i18n |
| `/api/*` Python 服务 | **Railway / Render / Fly.io** 等 | 整仓部署，保留 `Files/`、`config.yaml` |

---

## 方案 A（推荐）：Vercel 前端 + 独立 API 主机

### 1. API 部署到 Railway（示例）

1. 将仓库推到 GitHub。
2. [Railway](https://railway.app) 新建项目 → Deploy from repo。
3. **Start Command**：

   ```bash
   pip install -r requirements.txt && python3 -m src.server.replay_server
   ```

4. 设置环境变量（若需改端口，需改 `config.yaml` 里 `replay.port`；Railway 会注入 `PORT`，目前服务读的是 yaml 固定端口，建议在 Railway 用 **8765** 或改代码读 `os.environ["PORT"]`）。
5. Railway 会注入 `PORT`；服务已支持读环境变量 `PORT`（无需改 yaml）。
6. 记下公网 URL，例如 `https://re-test-api.up.railway.app`。
7. **必须把 `Files/` 目录一并部署**（不要 `.gitignore` 掉），否则 `/api/bars` 无数据。

### 2. Vercel 部署前端

根目录已有 `vercel.json`（`outputDirectory: web`）和 `api/[...path].js`（Edge 代理）。

在 Vercel 项目 **Environment Variables** 中设置：

| 变量 | 示例 |
|------|------|
| `API_PROXY_TARGET` | `https://re-test-api.up.railway.app` |

浏览器访问 `/api/*` 时由 Vercel Edge 转发到该地址，**无需改前端、无 CORS 问题**。

### 3. 本地验证代理

```bash
# 终端 1：API
python3 -m src.server.replay_server

# 终端 2：用 vercel dev（需安装 vercel CLI）
cd /path/to/re-test
vercel dev
```

---

## 方案 B：仅静态站（无 K 线数据）

若只演示 UI、不接真实数据，可只部署 `web/`，但打开后 `/api/config` 会失败，**不适合正式使用**。

---

## 方案 C：全部塞进 Vercel Serverless（不推荐）

理论上可为每个接口写 `api/*.py`，但：

- `Files/` 约 **数百个 CSV**，总体积常 **>50MB**，易超 Vercel Hobby 包体限制；
- 冷启动 + `pandas` 读盘慢，易触发 **10s（Hobby）/60s（Pro）** 超时；
- 需把 M5 预处理成对象存储上的 JSON 分片，改动大。

仅适合「数据已上 S3/R2 + 轻量 API」的二次改造。

---

## 代码上已做的调整

- `web/index.html` 可通过 `window.__API_BASE__` 指定 API 根地址（跨域直连后端时用）。
- `vercel.json`：`outputDirectory: web`，`/api/*` → `API_PROXY_TARGET` 代理。

## 若 API 与前端不同域（不用 Vercel 代理）

在 `web/index.html` 的 `__API_BASE__` 设为完整 API 地址，并在后端增加 CORS 头，例如：

```python
# replay_server.py 的 _send_json 前增加
self.send_header("Access-Control-Allow-Origin", "https://your-app.vercel.app")
```

---

## 检查清单

- [ ] `Files/` 已随 API 服务一起部署
- [ ] Vercel 环境变量 `API_PROXY_TARGET` 指向 API 公网地址
- [ ] API 服务 `GET /api/config` 在浏览器可访问
- [ ] 强制刷新前端缓存（改 `app.js?v=` 版本号）

## 可选后续改进

1. `replay_server.py` 读取 `os.environ.get("PORT", 8765)`，适配 Railway/Fly。
2. 将 M5 预聚合为按日 JSON 放对象存储，缩小 Serverless 体积。
3. 用 Vercel Blob / R2 托管静态 K 线包，API 只返回 URL。
