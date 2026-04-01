# OpenClaw Agents 可视化控制中心

实时监控与管理 OpenClaw AI Agent 集群的 Web 控制台。提供 3D 办公室数字孪生、战术全息雷达、协同网络图、任务时间线等多维可视化视图。

## 功能概览

- **Agent 实时状态面板** — 展示每个 Agent 的运行状态、当前任务、模型、Token 消耗和 Context 占用率
- **3D 办公室数字孪生** — 基于 Three.js WebGL 的 3D 场景，Agent 以动态粒子形式在虚拟办公室中移动，支持自动巡航和手动视角控制
- **战术全息雷达** — 类似 HUD 的雷达追踪面板，直观展示 Agent 空间分布与能量状态
- **Mission Timeline** — 未来 60 分钟内 Cron 任务与 Agent 活动的预测轨道
- **协同网络图** — Agent 之间的消息流与协作关系可视化
- **Token 热力带** — 上下文压力感知，按负载排序展示各 Agent 的 Token 消耗热度
- **异常控制台** — 错误与降级链路实时告警
- **Cron 雷达** — 定时任务排程、交付状态与执行历史一览
- **多监控源聚合** — 通过 SSH 隧道安全聚合多台机器的遥测数据到统一看板
- **Action Deck** — 快捷战术动作：强制刷新、锁定热点 Agent、切换巡航/动画、复制快照

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js（原生 `node:http`，零框架依赖） |
| 前端 | 原生 HTML / CSS / JavaScript |
| 3D 引擎 | Three.js（本地 vendor 文件） |
| 数据源 | OpenClaw CLI（`openclaw status/sessions/cron`） |

## 快速启动

### 前提条件

- Node.js >= 18
- 已安装 [OpenClaw CLI](https://github.com/nicepkg/openclaw) 并可通过 `openclaw` 命令访问

### 安装与运行

```bash
# 安装依赖
npm install

# 启动服务
npm run dev
```

默认地址：`http://127.0.0.1:4173`

## 部署方案

### 方案一：单机部署（被监控机直接运行）

```bash
./scripts/start-monitored-mac.sh
```

脚本行为：
- 交互式提示输入 `OPENCLAW_DASH_TOKEN`（不回显）
- 默认 `HOST=127.0.0.1`（仅本机监听）
- 启动 `npm run dev`

### 方案二：远程监控（SSH 隧道 + 自动重连）

```bash
./scripts/start-viewer-mac-auto.sh <user@openclaw-host>
```

脚本行为：
- 自动建立 SSH 隧道：`127.0.0.1:14173 -> 远端 127.0.0.1:4173`
- 交互式提示输入被监控机 token（`OFFICE_REMOTE_TOKEN`，不回显）
- 自动配置远端 source 并启动本地聚合看板
- SSH 隧道断线自动重连（守护循环）

可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOCAL_TUNNEL_PORT` | `14173` | 本地隧道端口 |
| `REMOTE_DASH_PORT` | `4173` | 远端看板端口 |
| `SOURCE_ID` | `office` | 监控源 ID |
| `SOURCE_LABEL` | `Office Mac` | 监控源显示名 |
| `VIEWER_DASH_TOKEN` | — | 为常用机看板自身增加鉴权 |
| `RECONNECT_DELAY_SEC` | `3` | SSH 断线重连间隔（秒） |
| `SSH_CONNECT_TIMEOUT_SEC` | `10` | SSH 连接超时 |
| `SSH_SERVER_ALIVE_INTERVAL` | `10` | SSH 心跳间隔 |
| `SSH_SERVER_ALIVE_COUNT_MAX` | `3` | SSH 心跳最大重试 |

如需旧版单次 SSH 隧道（无自动重连）：

```bash
./scripts/start-viewer-mac.sh <user@openclaw-host>
```

### 方案三：多监控源手动配置

```bash
export OPENCLAW_INCLUDE_LOCAL_SOURCE=0
export OPENCLAW_DEFAULT_SOURCE=office
export OFFICE_REMOTE_TOKEN='replace-with-strong-token'
export OPENCLAW_REMOTE_SOURCES='[
  {
    "id": "office",
    "label": "Office Mac",
    "url": "http://127.0.0.1:14173/api/telemetry",
    "tokenEnv": "OFFICE_REMOTE_TOKEN",
    "timeoutMs": 12000
  }
]'
npm run dev
```

## API 接口

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/api/health` | 否 | 服务健康检查 |
| `GET` | `/api/sources` | 是 | 获取可用监控源列表 |
| `GET` | `/api/telemetry?source=<id>` | 是 | 获取指定源的完整遥测数据 |

鉴权方式（二选一）：
- `Authorization: Bearer <OPENCLAW_DASH_TOKEN>`
- `x-dashboard-token: <OPENCLAW_DASH_TOKEN>`

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4173` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `OPENCLAW_DASH_TOKEN` | — | API 鉴权 token，留空则禁用鉴权 |
| `OPENCLAW_INCLUDE_LOCAL_SOURCE` | `1` | 设为 `0` 关闭本地 source |
| `OPENCLAW_DEFAULT_SOURCE` | `local` | 默认监控源 ID |
| `OPENCLAW_REMOTE_SOURCES` | — | 远端 source JSON 数组 |
| `REMOTE_FETCH_TIMEOUT_MS` | `15000` | 远端 source 请求超时（毫秒） |
| `RATE_LIMIT_MAX` | `60` | 每分钟每 IP 最大请求数 |
| `REQUEST_TIMEOUT_MS` | `120000` | 单次请求超时（毫秒） |

完整示例见 [`.env.example`](.env.example)。

## 项目结构

```
├── server.js                 # Node.js HTTP 服务端（API + 静态文件）
├── public/
│   ├── index.html            # 主页面
│   ├── app.js                # 前端主逻辑（面板渲染、数据轮询、模拟层）
│   ├── office3d.js           # Three.js 3D 办公室场景模块
│   ├── styles.css            # 全局样式（赛博朋克 HUD 主题）
│   └── vendor/three/         # Three.js 本地 vendor 文件
├── scripts/
│   ├── start-monitored-mac.sh      # 被监控机一键启动
│   ├── start-viewer-mac-auto.sh    # SSH 隧道 + 自动重连
│   └── start-viewer-mac.sh         # SSH 隧道（单次）
├── .env.example              # 环境变量示例
└── package.json
```

## 3D 引擎说明

- Three.js 使用本地 `public/vendor/three` 下的资源，**不依赖 CDN**
- `three.module.js` 与 `three.core.js` 必须同时存在
- 3D 引擎加载失败时自动降级为文本列表视图，不影响核心功能
- 支持两种摄像机模式：**自动巡航**（CRUISE）和**手动拖拽**（MANUAL）
- 滚轮缩放、左键拖拽旋转视角

## 安全特性

### 传输与认证
- 默认绑定 `127.0.0.1` 回环地址，不暴露外部网络
- API 鉴权支持 Bearer token 和自定义 header 两种方式
- Token 对比使用 `crypto.timingSafeEqual` 时序安全比较，防止计时攻击
- 前端 token 仅保存到 `sessionStorage`（浏览器会话级），不持久化到 `localStorage`

### 请求防护
- 基于 IP 的滑动窗口速率限制（默认 60 请求/分钟），超限返回 `429 Too Many Requests`
- 仅允许 `GET` / `HEAD` 方法，其他方法返回 `405 Method Not Allowed`
- 请求超时保护（`server.timeout`、`headersTimeout`），防御 Slowloris 慢速攻击
- API 错误响应自动脱敏，不泄露内部路径和堆栈信息

### 响应安全头
- `Content-Security-Policy`：严格 CSP（`script-src 'self'`，禁止内联脚本）
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` + `frame-ancestors 'none'`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Resource-Policy: same-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Permissions-Policy`：禁用地理位置、麦克风、摄像头、支付、USB
- `X-DNS-Prefetch-Control: off`

### 静态文件安全
- 路径遍历防护：`path.normalize` + `startsWith` 双重校验
- Null byte 注入防护
- HTML 输出全量 `escapeHtml` 转义，防止 XSS

### 前端安全
- 所有 `innerHTML` 赋值均经过 `escapeHtml()` 转义
- `.env` 与 `.env.local` 已加入 `.gitignore`，敏感配置不进版本库
- API 重试循环设有上限保护，防止无限请求

### 性能优化
- 可压缩资源（HTML/CSS/JS/JSON/SVG）自动 gzip 压缩传输
- 静态资源 `Cache-Control: public, max-age=300`，HTML 文件 `no-store`

### 风险提示
- 如果将 `HOST` 改为 `0.0.0.0` 暴露公网 HTTP，存在中间人风险。推荐使用 SSH 隧道或 Tailscale 等私有网络
- 同机高权限恶意进程理论上可读取当前用户的环境变量，这是操作系统级限制

## 许可证

MIT
