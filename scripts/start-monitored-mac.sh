#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm 未安装，无法启动。"
  exit 1
fi

if [[ -z "${OPENCLAW_DASH_TOKEN:-}" ]]; then
  read -rsp "输入被监控机 OPENCLAW_DASH_TOKEN（不会回显）: " OPENCLAW_DASH_TOKEN
  echo
fi

if [[ -z "${OPENCLAW_DASH_TOKEN:-}" ]]; then
  echo "OPENCLAW_DASH_TOKEN 不能为空。"
  exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-4173}"
export OPENCLAW_DASH_TOKEN

echo "启动被监控机看板: http://${HOST}:${PORT}"
echo "安全模式: 仅回环监听 + token 鉴权已启用"

npm run dev
