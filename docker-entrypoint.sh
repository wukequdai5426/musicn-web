#!/bin/sh
# MusicN 单容器启动脚本：后台跑 msc（内部端口），前台跑前端代理（对外端口）
# 任一进程崩溃都会自动拉起（musicn 原项目遇到上游网络错误会直接崩溃，
# 不能让一次网络抖动杀掉整个容器）。
set -u

MSC_PORT="${MUSICN_INTERNAL_PORT:-7479}"
WEB_PORT="${PORT:-7478}"
export MUSICN_TARGET="http://127.0.0.1:${MSC_PORT}"

probe() {
  node -e "const s=require('net').connect(${MSC_PORT},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" >/dev/null 2>&1
}

start_msc() {
  msc -q -P "${MSC_PORT}" &
  MSC_PID=$!
  echo "[musicn-web] musicn 后端已启动 (pid ${MSC_PID}，内部端口 ${MSC_PORT})"
}

start_web() {
  node /opt/musicn-web/server.js &
  WEB_PID=$!
  echo "[musicn-web] 前端已启动 (pid ${WEB_PID}，对外端口 ${WEB_PORT})"
}

start_msc

# 等待后端首次就绪（最多 40 秒），避免网页刚打开就搜索时报连接失败
i=0
while [ "$i" -lt 40 ]; do
  if probe; then
    echo "[musicn-web] musicn 后端已就绪"
    break
  fi
  i=$((i + 1))
  sleep 1
done

start_web

cleanup() {
  kill "${MSC_PID:-0}" "${WEB_PID:-0}" 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# 监督循环：谁死了就重启谁（后端重启不影响前端，代理是按请求转发的）
while :; do
  sleep 3
  if ! kill -0 "${MSC_PID}" 2>/dev/null; then
    echo "[musicn-web] musicn 后端意外退出（多为上游网络抖动），5 秒后自动重启"
    sleep 3
    start_msc
  fi
  if ! kill -0 "${WEB_PID}" 2>/dev/null; then
    echo "[musicn-web] 前端意外退出，5 秒后自动重启"
    sleep 3
    start_web
  fi
done
