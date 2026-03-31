# OpenClaw Agents 可视化控制中心

## 快速启动

```bash
npm run dev
```

默认地址：`http://127.0.0.1:4173`

## 一键脚本（你要的 2+3 方案）

### 1) 被监控机（运行 OpenClaw 的 Mac）

```bash
./scripts/start-monitored-mac.sh
```

脚本行为：
- 自动提示输入 `OPENCLAW_DASH_TOKEN`（不回显）
- 默认 `HOST=127.0.0.1`（仅本机监听）
- 启动 `npm run dev`

### 2) 常用机（通过 SSH 隧道监控）

```bash
./scripts/start-viewer-mac-auto.sh <user@openclaw-host>
```

脚本行为：
- 自动建立 SSH 隧道：`127.0.0.1:74173 -> 远端 127.0.0.1:4173`
- 自动提示输入被监控机 token（`OFFICE_REMOTE_TOKEN`，不回显）
- 自动配置远端 source 并启动本地看板
- SSH 隧道断线自动重连（守护循环）

可选环境变量：
- `LOCAL_TUNNEL_PORT`（默认 `74173`）
- `REMOTE_DASH_PORT`（默认 `4173`）
- `SOURCE_ID` / `SOURCE_LABEL`
- `VIEWER_DASH_TOKEN`（给常用机看板自身再加一层鉴权）
- `RECONNECT_DELAY_SEC`（默认 `3`）
- `SSH_CONNECT_TIMEOUT_SEC`（默认 `10`）
- `SSH_SERVER_ALIVE_INTERVAL`（默认 `10`）
- `SSH_SERVER_ALIVE_COUNT_MAX`（默认 `3`）

如需旧版“单次 SSH 隧道”脚本，仍可使用：

```bash
./scripts/start-viewer-mac.sh <user@openclaw-host>
```

## 多监控源配置（手动模式）

```bash
export OPENCLAW_INCLUDE_LOCAL_SOURCE=0
export OPENCLAW_DEFAULT_SOURCE=office
export OFFICE_REMOTE_TOKEN='replace-with-strong-token'
export OPENCLAW_REMOTE_SOURCES='[
  {
    "id": "office",
    "label": "Office Mac",
    "url": "http://127.0.0.1:74173/api/telemetry",
    "tokenEnv": "OFFICE_REMOTE_TOKEN",
    "timeoutMs": 12000
  }
]'
npm run dev
```

## 安全检查结论（本次已整改）

### 已加固
- API 鉴权默认走 `Authorization: Bearer <token>` 或 `x-dashboard-token` header
- 移除 query token 认证入口（避免 URL/历史记录泄漏）
- token 对比使用时序安全比较（`timingSafeEqual`）
- 增加安全响应头：
  - `Content-Security-Policy`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Permissions-Policy`
- 前端输入 token 仅保存到 `sessionStorage`（浏览器会话级），不再落盘到 `localStorage`
- `.env` 与本地变体已加入 `.gitignore`

### 风险提示（仍需你配合）
- 如果你把 `HOST` 改成 `0.0.0.0` 且直接暴露公网 HTTP，会存在中间人风险。  
  推荐继续使用 SSH 隧道或 Tailscale 私网，不要裸露公网端口。
- 同机高权限恶意进程理论上仍可能读取你当前用户态环境变量。  
  这是操作系统级风险，不是本项目单独能完全消除。

## API

- `GET /api/health`
- `GET /api/sources`（需要 token）
- `GET /api/telemetry?source=<id>`（需要 token）

## 服务端环境变量

- `PORT`：监听端口，默认 `4173`
- `HOST`：监听地址，默认 `127.0.0.1`
- `OPENCLAW_DASH_TOKEN`：启用 dashboard API 鉴权
- `OPENCLAW_INCLUDE_LOCAL_SOURCE`：`0` 关闭本地 source
- `OPENCLAW_DEFAULT_SOURCE`：默认 source id
- `OPENCLAW_REMOTE_SOURCES`：远端 source JSON 数组
- `REMOTE_FETCH_TIMEOUT_MS`：远端 source 请求超时（毫秒）

## 3D 说明

- Three.js 使用本地 `public/vendor/three` 资源
- 必须同时存在 `three.module.js` 与 `three.core.js`
