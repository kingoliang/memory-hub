#!/usr/bin/env bash
# memory-hub · 把本仓库当前提交导出到远端 ~/memory-hub/ 并安装运行时依赖（不依赖任何 git 远程）。
# 用法：scripts/deploy-remote.sh [user@host]      （默认 $MEMORY_HUB_DEPLOY_REMOTE）
# 只动远端 ~/memory-hub/；不碰 systemd、nginx、数据目录。要求仓库工作区干净（部署的是 HEAD，不是工作区）。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${1:-${MEMORY_HUB_DEPLOY_REMOTE:?请传入 user@host 或设置 MEMORY_HUB_DEPLOY_REMOTE}}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
to() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' -- "$s" "$@"; }

cd "$REPO"
if [ -n "$(git status --porcelain)" ]; then echo "工作区不干净：部署的是 HEAD，请先提交或 stash" >&2; exit 1; fi
REV="$(git rev-parse --short HEAD)"
echo "[deploy] 导出 HEAD=$REV 到 $REMOTE:~/memory-hub/"

# 代码目录整体替换（保留 node_modules，依赖按 lock 重装）；先清理旧的受管目录，避免残留已删除的文件
to 60 ssh "${SSH_OPTS[@]}" "$REMOTE" 'set -e; mkdir -p ~/memory-hub; cd ~/memory-hub; rm -rf src bin web docs scripts tests; rm -f PLAN.md package.json package-lock.json NOTICE.md LICENSE REVISION'
git archive HEAD | to 120 ssh "${SSH_OPTS[@]}" "$REMOTE" 'cd ~/memory-hub && tar x'
echo "$REV" | to 30 ssh "${SSH_OPTS[@]}" "$REMOTE" 'cat > ~/memory-hub/REVISION'

# 运行时依赖（--omit=dev）；node 在非交互 ssh 的 PATH 里没有，显式补 ~/.local/bin
to 300 ssh "${SSH_OPTS[@]}" "$REMOTE" 'export PATH=$HOME/.local/bin:$PATH; cd ~/memory-hub && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 && node -e "import(\"./src/server.js\").then(()=>console.log(\"import ok\"))" 2>&1 | grep -v -e ExperimentalWarning -e trace-warnings'
echo "[deploy] 完成 rev=$REV"
