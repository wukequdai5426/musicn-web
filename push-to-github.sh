#!/usr/bin/env bash
# 把本目录推送到 GitHub，触发 Actions 自动构建镜像
#
# 用法（在 musicn-web 目录内执行）：
#   bash push-to-github.sh <GitHub用户名> [仓库名]
#
# 例：
#   bash push-to-github.sh zhangsan
#   bash push-to-github.sh zhangsan my-musicn
#
# 前置条件：已在 GitHub 网页上创建同名空仓库（不要勾选初始化 README）。
# 首次 push 会弹出浏览器让你登录 GitHub（Git Credential Manager），授权一次即可。

set -euo pipefail

OWNER="${1:-}"
REPO="${2:-musicn-web}"

if [ -z "$OWNER" ]; then
  echo "用法: bash push-to-github.sh <GitHub用户名> [仓库名]"
  exit 1
fi

cd "$(dirname "$0")"

command -v git >/dev/null 2>&1 || { echo "未找到 git，请先安装 Git"; exit 1; }

if [ ! -d .git ]; then
  echo "==> 初始化仓库"
  git init -q
fi

if [ -z "$(git config user.email || true)" ]; then
  git config user.name "$OWNER"
  git config user.email "$OWNER@users.noreply.github.com"
  echo "==> 已设置本地提交身份为 $OWNER <$OWNER@users.noreply.github.com>"
fi

echo "==> 暂存文件"
git add -A

if git diff --cached --quiet; then
  echo "==> 没有新的改动需要提交"
else
  git commit -q -m "feat: MusicN 单容器镜像（msc 后端 + 深色在线播放前端）"
  echo "==> 已提交"
fi

git branch -M main 2>/dev/null || true

REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

echo "==> 推送到 $REMOTE_URL"
echo "    （如果仓库还不存在，请先打开 https://github.com/new 新建 ${REPO}，不要初始化 README）"
if ! git push -u origin main; then
  echo ""
  echo "推送失败。常见原因："
  echo "  1. 仓库尚未创建 -> https://github.com/new 新建 ${REPO}"
  echo "  2. 未登录 GitHub -> 重新执行本脚本，按弹出的浏览器窗口授权"
  exit 1
fi

echo ""
echo "推送完成。接下来："
echo "  1. 打开 https://github.com/${OWNER}/${REPO}/actions 等待构建完成（约 3-8 分钟）"
echo "  2. 打开 https://github.com/users/${OWNER}/packages/container/musicn-web/settings"
echo "     把 Danger Zone 里的可见性改为 Public（否则 NAS 无法免登录拉取）"
echo "  3. 飞牛 compose 里镜像改为：ghcr.io/${OWNER}/musicn-web:latest"
