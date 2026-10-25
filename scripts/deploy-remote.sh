#!/usr/bin/env bash
# memory-hub · 把本仓库当前提交（HEAD）导出到远端代码目录并安装运行时依赖（不依赖任何 git 远程）。
#
# 用法：
#   scripts/deploy-remote.sh [选项] [user@host]
#   scripts/deploy-remote.sh --rollback [--restart] [选项] [user@host]
#
# 选项（括号内是等价环境变量；主机名 / 路径一律由调用方传入，仓库里不写任何具体值）：
#   --env-file PATH   远端 systemd EnvironmentFile 路径（MEMORY_HUB_DEPLOY_ENV_FILE）。
#                     部署前在线备份和重启后的健康检查都靠它定位数据目录 / 端口 / base path。
#   --skip-backup     不做部署前在线备份（默认要做；远端没有旧代码目录时自动跳过）
#   --restart         换完代码后重启 systemd 用户单元，并核对 /healthz 的 revision 与刚部署的一致
#   --unit NAME       systemd 用户单元名（MEMORY_HUB_DEPLOY_UNIT，默认 memory-hub.service）
#   --dir PATH        远端代码目录（MEMORY_HUB_DEPLOY_DIR，默认 ~/memory-hub）；上一份保留在 <dir>.prev
#   --health-url URL  在远端用 curl 访问的健康检查地址（MEMORY_HUB_DEPLOY_HEALTH_URL）；
#                     缺省由 --env-file 里的 MEMORY_HUB_HOST / PORT / BASE_PATH 推出
#   MEMORY_HUB_DEPLOY_HEALTH_WAIT  重启后等待 /healthz 的最长秒数，默认 30
#   --rollback        不部署，只把 <dir>.prev 换回 <dir>（当前版本留在 <dir>.failed）；常与 --restart 合用
#   --dry-run         只打印将执行的步骤，不连远端
#   [user@host]       位置参数，缺省取 MEMORY_HUB_DEPLOY_REMOTE
#
# 部署顺序：检查工作区干净 → 读远端当前 REVISION → 在线备份（memory-hub backup now，用旧代码）
#   → 导出 HEAD 到 <dir>.new，写 REVISION（完整 sha / 提交时间 / git describe），npm ci --omit=dev，冒烟 import
#   → 换目录（<dir> → <dir>.prev，<dir>.new → <dir>）→（--restart）重启并核对 /healthz.revision。
# 依赖安装失败时线上目录原封不动。只动远端代码目录与（--restart 时）指定的 systemd 用户单元；不碰 nginx、数据目录。
# 部署的是 HEAD，不是工作区，所以要求工作区干净。
set -euo pipefail

REPO="${MEMORY_HUB_DEPLOY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REMOTE="${MEMORY_HUB_DEPLOY_REMOTE:-}"
ENV_FILE="${MEMORY_HUB_DEPLOY_ENV_FILE:-}"
UNIT="${MEMORY_HUB_DEPLOY_UNIT:-memory-hub.service}"
DIR="${MEMORY_HUB_DEPLOY_DIR:-~/memory-hub}"
HEALTH_URL="${MEMORY_HUB_DEPLOY_HEALTH_URL:-}"
HEALTH_WAIT="${MEMORY_HUB_DEPLOY_HEALTH_WAIT:-30}"   # 重启后等 /healthz 报出新 revision 的最长秒数
DO_BACKUP=1 DO_RESTART=0 DO_ROLLBACK=0 DRY=0

die() { echo "[deploy] $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file 需要参数}"; shift 2 ;;
    --unit) UNIT="${2:?--unit 需要参数}"; shift 2 ;;
    --dir) DIR="${2:?--dir 需要参数}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:?--health-url 需要参数}"; shift 2 ;;
    --skip-backup) DO_BACKUP=0; shift ;;
    --restart) DO_RESTART=1; shift ;;
    --rollback) DO_ROLLBACK=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "未知选项：$1" ;;
    *) REMOTE="$1"; shift ;;
  esac
done
[ -n "$REMOTE" ] || die "请传入 user@host 或设置 MEMORY_HUB_DEPLOY_REMOTE"
if [ "$DO_BACKUP" = 1 ] && [ "$DO_ROLLBACK" = 0 ] && [ -z "$ENV_FILE" ]; then
  die "部署前备份需要 --env-file（远端 EnvironmentFile 路径）；确实不要备份请显式加 --skip-backup"
fi
if [ "$DO_RESTART" = 1 ] && [ -z "$ENV_FILE" ] && [ -z "$HEALTH_URL" ]; then
  die "--restart 需要 --env-file 或 --health-url，用来定位健康检查地址"
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
to() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' -- "$s" "$@"; }
# 远端执行一段 bash（脚本走 stdin，参数经 printf %q 安全转义）：rsh <超时秒> <脚本变量> [参数...]
rsh() { local t="$1" script="$2"; shift 2; local q=''; [ $# -gt 0 ] && q="$(printf '%q ' "$@")"
  to "$t" ssh "${SSH_OPTS[@]}" "$REMOTE" "bash -s -- $q" <<<"$script"; }

# 远端公共片段：展开 ~、补 PATH、定位 systemd 用户总线、从 EnvironmentFile 推健康检查地址
read -r -d '' R_COMMON <<'EOF' || true
export PATH="$HOME/.local/bin:$PATH"
[ -n "${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
exp() { case "$1" in "~") echo "$HOME" ;; "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
envval() { [ -n "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }
health_url() { # $1 envfile $2 override
  if [ -n "$2" ]; then echo "$2"; return; fi
  local h p b; h="$(envval "$1" MEMORY_HUB_HOST)"; p="$(envval "$1" MEMORY_HUB_PORT)"; b="$(envval "$1" MEMORY_HUB_BASE_PATH)"
  case "$h" in ""|"0.0.0.0") h=127.0.0.1 ;; esac
  echo "http://${h}:${p:-7990}${b%/}/healthz"
}
# 轮询 healthz 直到满足期望（最多 $3 秒）；打印最后一次读到的 revision。
# $2 非空：revision 必须等于它；$2 为空（回滚到没有 sha= 的旧式 REVISION / 旧代码）：只要求 healthz 返回 ok。
wait_revision() { # $1 url $2 expected $3 seconds
  local i body got=''
  for i in $(seq 1 "$3"); do
    body="$(curl -fsS --max-time 3 "$1" 2>/dev/null)" || body=''
    got="$(printf '%s' "$body" | sed -n 's/.*"revision":"\([0-9a-f]*\)".*/\1/p')"
    if [ -n "$2" ]; then [ "$got" = "$2" ] && { echo "$got"; return 0; }
    else case "$body" in *'"ok":true'*) echo "${got:-<旧版本，healthz 无 revision>}"; return 0 ;; esac; fi
    sleep 1
  done
  echo "${got:-<无响应或无 revision>}"; return 1
}
EOF

# ---- 远端片段 ----
# 参数：DIR
read -r -d '' R_CURRENT <<'EOF' || true
D="$(exp "$1")"
if [ -f "$D/REVISION" ]; then sed 's/^/[remote] REVISION  /' "$D/REVISION"; else echo "[remote] $D 下没有 REVISION（首次部署或旧式部署）"; fi
[ -d "$D.prev" ] && echo "[remote] 已有上一份代码目录 $D.prev（本次部署后将被替换）" || true
exit 0
EOF

# 参数：DIR ENVFILE   —— 用现有（旧）代码做在线备份；备份失败则整个部署中止
read -r -d '' R_BACKUP <<'EOF' || true
set -eu
D="$(exp "$1")"; E="$(exp "$2")"
if [ ! -f "$D/bin/memory-hub.mjs" ]; then echo "[remote] $D 里没有现成代码，跳过备份"; exit 0; fi
[ -r "$E" ] || { echo "[remote] 读不到 EnvironmentFile：$E" >&2; exit 1; }
cd "$D"
out="$(NODE_NO_WARNINGS=1 node --env-file="$E" bin/memory-hub.mjs backup now)"
echo "[remote] 备份完成：$(printf '%s' "$out" | tail -1)"
EOF

# 参数：DIR   —— 清空并建好 <dir>.new
read -r -d '' R_PREP <<'EOF' || true
set -eu
D="$(exp "$1")"; rm -rf "$D.new"; mkdir -p "$D.new"
EOF

# 参数：DIR   —— stdin 为 REVISION 内容；随后装依赖 + 冒烟 import
read -r -d '' R_INSTALL <<'EOF' || true
set -eu
D="$(exp "$1")"; cd "$D.new"
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
node -e 'import("./src/server.js").then(()=>console.log("import ok"))' 2>&1 | grep -v -e ExperimentalWarning -e trace-warnings
EOF

# 参数：DIR   —— 换目录
read -r -d '' R_SWAP <<'EOF' || true
set -eu
D="$(exp "$1")"
[ -f "$D.new/REVISION" ] || { echo "[remote] $D.new 不完整，拒绝切换" >&2; exit 1; }
rm -rf "$D.prev"
[ -d "$D" ] && mv "$D" "$D.prev"
mv "$D.new" "$D"
echo "[remote] 已切换；上一份代码在 $D.prev"
EOF

# 参数：DIR   —— 回滚代码目录
read -r -d '' R_ROLLBACK <<'EOF' || true
set -eu
D="$(exp "$1")"
[ -d "$D.prev" ] || { echo "[remote] 没有 $D.prev，无法回滚" >&2; exit 1; }
rm -rf "$D.failed"
[ -d "$D" ] && mv "$D" "$D.failed"
mv "$D.prev" "$D"
echo "[remote] 已回滚；被替换的版本留在 $D.failed"
EOF

# 参数：DIR UNIT ENVFILE HEALTH_URL WAIT_SECONDS   —— 重启并核对 revision
read -r -d '' R_RESTART <<'EOF' || true
set -u
D="$(exp "$1")"; U="$2"; E="$(exp "$3")"; URL="$(health_url "$E" "$4")"
want="$(sed -n 's/^sha=//p' "$D/REVISION" 2>/dev/null | head -1)"   # 旧式 REVISION（单行短 sha）没有 sha= → want 为空 → 只核对 ok
systemctl --user restart "$U" || { echo "[remote] systemctl --user restart $U 失败" >&2; exit 3; }
if got="$(wait_revision "$URL" "$want" "${5:-30}")"; then
  echo "[remote] /healthz revision=$got，与部署一致"
else
  echo "[remote] /healthz revision=$got，期望 $want（地址 $URL）" >&2; exit 4
fi
EOF

# ---- 本地：准备 ----
cd "$REPO"
if [ "$DO_ROLLBACK" = 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    if [ "$DRY" = 1 ]; then echo "[deploy] 注意：工作区不干净（dry-run 继续；真正部署会拒绝）" >&2
    else die "工作区不干净：部署的是 HEAD，请先提交或 stash"; fi
  fi
  SHA="$(git rev-parse HEAD)"
  CTIME="$(git show -s --format=%cI HEAD)"
  DESC="$(git describe --tags --always 2>/dev/null || echo "$SHA")"
  REVTXT="$(printf 'sha=%s\ntime=%s\ndescribe=%s\n' "$SHA" "$CTIME" "$DESC")"
fi

# 回滚命令（失败时原样打印，参数与本次一致）
ROLLBACK_CMD="scripts/deploy-remote.sh --rollback --restart"
[ -n "$ENV_FILE" ] && ROLLBACK_CMD+=" --env-file $(printf '%q' "$ENV_FILE")"
ROLLBACK_CMD+=" --unit $(printf '%q' "$UNIT") --dir $(printf '%q' "$DIR")"
[ -n "$HEALTH_URL" ] && ROLLBACK_CMD+=" --health-url $(printf '%q' "$HEALTH_URL")"
ROLLBACK_CMD+=" $(printf '%q' "$REMOTE")"

if [ "$DRY" = 1 ]; then
  echo "[deploy] dry-run（不连远端）：目标 $REMOTE，代码目录 $DIR"
  if [ "$DO_ROLLBACK" = 1 ]; then
    echo "  1. $DIR → $DIR.failed，$DIR.prev → $DIR"
    [ "$DO_RESTART" = 1 ] && echo "  2. 重启 $UNIT 并核对 /healthz.revision 与 $DIR/REVISION 一致"
  else
    echo "  部署版本：$DESC（$SHA，$CTIME）"
    n=1
    echo "  $n. 读远端当前 REVISION"; n=$((n+1))
    [ "$DO_BACKUP" = 1 ] && { echo "  $n. 用现有代码做在线备份：node --env-file=$ENV_FILE bin/memory-hub.mjs backup now"; n=$((n+1)); }
    echo "  $n. 导出 HEAD 到 $DIR.new，写 REVISION，npm ci --omit=dev，冒烟 import"; n=$((n+1))
    echo "  $n. $DIR → $DIR.prev，$DIR.new → $DIR"; n=$((n+1))
    [ "$DO_RESTART" = 1 ] && { echo "  $n. 重启 $UNIT，核对 /healthz.revision == $SHA"; n=$((n+1)); echo "     失败时回滚：$ROLLBACK_CMD"; }
  fi
  exit 0
fi

fail_restart() { # $1 退出码
  echo "[deploy] 重启后健康检查未通过（退出码 $1）。回滚命令：" >&2
  echo "    $ROLLBACK_CMD" >&2
  [ -n "${BACKUP_PATH:-}" ] && echo "[deploy] 部署前备份：$BACKUP_PATH（schema 迁移只增不删，回滚代码一般不需要还原数据）" >&2
  exit 1
}

# ---- 回滚 ----
if [ "$DO_ROLLBACK" = 1 ]; then
  echo "[deploy] 回滚 $REMOTE:$DIR（$DIR.prev → $DIR）"
  rsh 60 "$R_COMMON"$'\n'"$R_ROLLBACK" "$DIR"
  if [ "$DO_RESTART" = 1 ]; then
    rsh $((HEALTH_WAIT+60)) "$R_COMMON"$'\n'"$R_RESTART" "$DIR" "$UNIT" "$ENV_FILE" "$HEALTH_URL" "$HEALTH_WAIT" || { echo "[deploy] 回滚后的健康检查也未通过，需要人工介入：查看 journalctl --user -u $UNIT" >&2; exit 1; }
  fi
  echo "[deploy] 回滚完成"
  exit 0
fi

# ---- 部署 ----
echo "[deploy] 部署 $DESC（$SHA，$CTIME）到 $REMOTE:$DIR"
rsh 30 "$R_COMMON"$'\n'"$R_CURRENT" "$DIR"

BACKUP_PATH=''
if [ "$DO_BACKUP" = 1 ]; then
  echo "[deploy] 部署前在线备份"
  out="$(rsh 180 "$R_COMMON"$'\n'"$R_BACKUP" "$DIR" "$ENV_FILE")" || die "备份失败，已中止（线上未改动）"
  echo "$out"
  BACKUP_PATH="$(printf '%s\n' "$out" | sed -n 's/^\[remote\] 备份完成：//p' | tail -1)"
else
  echo "[deploy] 已按 --skip-backup 跳过部署前备份"
fi

rsh 30 "$R_COMMON"$'\n'"$R_PREP" "$DIR"
# 把 stdin 灌进远端 <dir>.new 下：xcmd <超时秒> <远端 bash -c 脚本> [参数...]（stdin 保留给数据流）
xcmd() { local t="$1" script="$2"; shift 2; local q=''; [ $# -gt 0 ] && q="$(printf '%q ' "$@")"
  to "$t" ssh "${SSH_OPTS[@]}" "$REMOTE" "bash -c $(printf '%q' "$R_COMMON"$'\n'"$script") _ $q"; }
git archive HEAD | xcmd 120 'cd "$(exp "$1").new" && tar x' "$DIR"
printf '%s\n' "$REVTXT" | xcmd 30 'cat > "$(exp "$1").new/REVISION"' "$DIR"
rsh 300 "$R_COMMON"$'\n'"$R_INSTALL" "$DIR"
rsh 60 "$R_COMMON"$'\n'"$R_SWAP" "$DIR"

if [ "$DO_RESTART" = 1 ]; then
  echo "[deploy] 重启 $UNIT 并核对 revision"
  rsh $((HEALTH_WAIT+60)) "$R_COMMON"$'\n'"$R_RESTART" "$DIR" "$UNIT" "$ENV_FILE" "$HEALTH_URL" "$HEALTH_WAIT" || fail_restart $?
else
  echo "[deploy] 未加 --restart：代码已就位但服务仍在跑旧进程；重启后请核对 /healthz 的 revision == $SHA"
fi
echo "[deploy] 完成 rev=${SHA:0:12} describe=$DESC"
