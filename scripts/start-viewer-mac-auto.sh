#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh 未安装，无法建立隧道。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm 未安装，无法启动。"
  exit 1
fi

REMOTE_SSH_TARGET="${REMOTE_SSH_TARGET:-${1:-}}"
if [[ -z "$REMOTE_SSH_TARGET" ]]; then
  echo "用法: REMOTE_SSH_TARGET=<user@host> ./scripts/start-viewer-mac-auto.sh"
  echo "或:   ./scripts/start-viewer-mac-auto.sh <user@host>"
  exit 1
fi

LOCAL_TUNNEL_PORT="${LOCAL_TUNNEL_PORT:-74173}"
REMOTE_DASH_PORT="${REMOTE_DASH_PORT:-4173}"
SOURCE_ID="${SOURCE_ID:-office}"
SOURCE_LABEL="${SOURCE_LABEL:-Office Mac}"
RECONNECT_DELAY_SEC="${RECONNECT_DELAY_SEC:-3}"
SSH_CONNECT_TIMEOUT_SEC="${SSH_CONNECT_TIMEOUT_SEC:-10}"
SSH_SERVER_ALIVE_INTERVAL="${SSH_SERVER_ALIVE_INTERVAL:-10}"
SSH_SERVER_ALIVE_COUNT_MAX="${SSH_SERVER_ALIVE_COUNT_MAX:-3}"

if [[ -z "${OFFICE_REMOTE_TOKEN:-}" ]]; then
  read -rsp "输入被监控机 OPENCLAW_DASH_TOKEN（不会回显）: " OFFICE_REMOTE_TOKEN
  echo
fi

if [[ -z "${OFFICE_REMOTE_TOKEN:-}" ]]; then
  echo "OFFICE_REMOTE_TOKEN 不能为空。"
  exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-4173}"
export OPENCLAW_INCLUDE_LOCAL_SOURCE="${OPENCLAW_INCLUDE_LOCAL_SOURCE:-0}"
export OPENCLAW_DEFAULT_SOURCE="${OPENCLAW_DEFAULT_SOURCE:-$SOURCE_ID}"
export REMOTE_FETCH_TIMEOUT_MS="${REMOTE_FETCH_TIMEOUT_MS:-15000}"
export OFFICE_REMOTE_TOKEN
SAFE_SOURCE_ID="$(printf '%s' "$SOURCE_ID" | tr -cd 'a-zA-Z0-9_-')"
SAFE_SOURCE_LABEL="$(printf '%s' "$SOURCE_LABEL" | sed 's/[\\"]//g' | cut -c1-64)"
export OPENCLAW_REMOTE_SOURCES="[{\"id\":\"${SAFE_SOURCE_ID}\",\"label\":\"${SAFE_SOURCE_LABEL}\",\"url\":\"http://127.0.0.1:${LOCAL_TUNNEL_PORT}/api/telemetry\",\"tokenEnv\":\"OFFICE_REMOTE_TOKEN\",\"timeoutMs\":12000}]"

# 常用机本地看板默认不再额外启用前端 token，避免重复输入。
# 如果你仍需要常用机看板鉴权，可预先 export VIEWER_DASH_TOKEN=...
if [[ -n "${VIEWER_DASH_TOKEN:-}" ]]; then
  export OPENCLAW_DASH_TOKEN="$VIEWER_DASH_TOKEN"
else
  unset OPENCLAW_DASH_TOKEN || true
fi

MANAGER_PID=""
cleanup() {
  if [[ -n "$MANAGER_PID" ]] && kill -0 "$MANAGER_PID" >/dev/null 2>&1; then
    pkill -TERM -P "$MANAGER_PID" >/dev/null 2>&1 || true
    kill "$MANAGER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

tunnel_manager() {
  local attempt=0
  while true; do
    attempt=$((attempt + 1))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SSH 隧道尝试 #${attempt}: 127.0.0.1:${LOCAL_TUNNEL_PORT} -> ${REMOTE_SSH_TARGET}:127.0.0.1:${REMOTE_DASH_PORT}"
    ssh -N \
      -L "${LOCAL_TUNNEL_PORT}:127.0.0.1:${REMOTE_DASH_PORT}" \
      -o ExitOnForwardFailure=yes \
      -o ConnectTimeout="${SSH_CONNECT_TIMEOUT_SEC}" \
      -o ServerAliveInterval="${SSH_SERVER_ALIVE_INTERVAL}" \
      -o ServerAliveCountMax="${SSH_SERVER_ALIVE_COUNT_MAX}" \
      "$REMOTE_SSH_TARGET"
    local exit_code=$?
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SSH 隧道中断 (exit=${exit_code})，${RECONNECT_DELAY_SEC}s 后重连"
    sleep "$RECONNECT_DELAY_SEC"
  done
}

echo "启动 SSH 隧道守护进程（自动重连）..."
tunnel_manager &
MANAGER_PID=$!
sleep 1

if ! kill -0 "$MANAGER_PID" >/dev/null 2>&1; then
  echo "SSH 隧道守护进程启动失败。"
  exit 1
fi

echo "启动常用机聚合看板: http://127.0.0.1:${PORT}"
echo "当前 source: ${SOURCE_ID} (${SOURCE_LABEL})"
echo "断线自动重连: ENABLED"

npm run dev
