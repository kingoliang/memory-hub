#!/usr/bin/env bash
# memory-hub · 58 上的正式切换 / 回滚脚本（PLAN 6.3.1）。在 58 本机以部署用户运行。
#
#   cutover.sh status
#   cutover.sh preflight                      只读体检
#   cutover.sh prepare  [--execute]           切换前的准备（不影响线上）：数据目录、prod.env、systemd unit、管理员口令文件
#   cutover.sh cutover  [--execute] --frozen-ack [--allow-holders] [--replace-data]
#   cutover.sh rollback [--execute] [--prune-purged]
#
# 默认 dry-run：只做只读检查并打印"将要做什么"；真正动手必须显式 --execute。
# 本脚本不需要 sudo：新服务带 BASE_PATH=/memory 接管 127.0.0.1:7990，nginx 的 /memory/ → 7990 反代原样可用（不改 nginx）。
# 脚本不碰：DSH 及其插件、客户端（Mac/58）配置、hook、旧服务的文件与 unit 文件本体（只 stop/start/disable/enable 旧 unit）。
# 不打印任何口令 / 令牌 / 密钥（令牌只经 0600 临时 header 文件喂给 curl）。
#
# 所有路径 / 名字都可用环境变量覆盖，用于在隔离环境里演练（见 docs/deploy-58.md 的"演练"一节）。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
OLD_UNIT="${CUT_OLD_UNIT:-memory-mcp-http.service}"
OLD_DB="${CUT_OLD_DB:-$HOME/.dsh/memory-vault/memory-eternal.db}"
OLD_TOKEN_FILE="${CUT_OLD_TOKEN_FILE:-$HOME/.dsh/memory-mcp-http/token}"
OLD_START_CMD="${CUT_OLD_START_CMD:-}"        # 空 = systemctl --user start $OLD_UNIT（演练用的临时 unit 无法 start，用自定义命令）
OLD_ENABLEABLE="${CUT_OLD_ENABLEABLE:-1}"     # 1 = 切换时 disable 旧 unit、回滚时 enable
HUB_UNIT="${CUT_HUB_UNIT:-memory-hub.service}"
HUB_TRANSIENT="${CUT_HUB_TRANSIENT:-0}"       # 1 = 用 systemd-run 的临时 unit（演练，不往 ~/.config/systemd/user 写文件）
HUB_DIR="${CUT_HUB_DIR:-$HOME/memory-hub}"
DATA_DIR="${CUT_DATA_DIR:-$HOME/memory-hub-data/prod}"
STATE_ROOT="${CUT_STATE_DIR:-$HOME/memory-hub-data/cutover}"
CFG_DIR="${CUT_CFG_DIR:-$HOME/.config/memory-hub}"
ENV_FILE="${CUT_ENV_FILE:-$CFG_DIR/prod.env}"
STAGING_ENV="${CUT_STAGING_ENV:-$CFG_DIR/staging.env}"   # 蒸馏三项从这里"文件到文件"拷贝，不经终端
PW_FILE="${CUT_PW_FILE:-$CFG_DIR/prod-admin-password}"
PORT="${CUT_PORT:-7990}"
BASE_PATH="${CUT_BASE_PATH:-/memory}"
HOSTNAMES="${CUT_ALLOWED_HOSTS:-astra-ai-server-02.tail5357dc.ts.net,astra-ai-server-02,100.113.34.77}"
ORIGINS="${CUT_ALLOWED_ORIGINS:-http://astra-ai-server-02.tail5357dc.ts.net,https://astra-ai-server-02.tail5357dc.ts.net,http://astra-ai-server-02,https://astra-ai-server-02,http://100.113.34.77,https://100.113.34.77}"
LEGACY_NAME="${CUT_LEGACY_NAME:-legacy-shared}"
LEGACY_EXPIRES="${CUT_LEGACY_EXPIRES:-14d}"
CHECK_NGINX="${CUT_CHECK_NGINX:-1}"           # 1 = 切换后经 nginx(80) 再验一遍；演练关闭
UNIT_DIR="$HOME/.config/systemd/user"
NODE="${NODE:-$(command -v node || true)}"
CLI=("$NODE" "$HUB_DIR/bin/memory-hub.mjs")

MODE="${1:-}"; shift || true
EXECUTE=0; FROZEN_ACK=0; ALLOW_HOLDERS=0; REPLACE_DATA=0; PRUNE=0
for a in "$@"; do
  case "$a" in
    --execute) EXECUTE=1 ;;
    --dry-run) EXECUTE=0 ;;
    --frozen-ack) FROZEN_ACK=1 ;;
    --allow-holders) ALLOW_HOLDERS=1 ;;
    --replace-data) REPLACE_DATA=1 ;;
    --prune-purged) PRUNE=1 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

# 可移植小工具（58 是 GNU，本机测试在 macOS）
fsz()  { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
fmode(){ stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
sha()  { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

say()  { printf '[cutover] %s\n' "$*"; }
step() { printf '\n[cutover] === %s ===\n' "$*"; }
die()  { printf '[cutover] 错误：%s\n' "$*" >&2; exit 1; }
# 只读命令照常执行；有副作用的命令走 act：dry-run 只打印
act()  { if [ "$EXECUTE" = 1 ]; then printf '+ %s\n' "$*"; "$@"; else printf '[dry-run] 将执行：%s\n' "$*"; fi; }
ucmd() { systemctl --user "$@"; }

# ── 公共检查 ─────────────────────────────────────────────
check_node() {
  [ -n "$NODE" ] || die "找不到 node（~/.local/bin/node）"
  "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)' || die "node 版本过低，需要 >=22.16（当前 $("$NODE" -v)）"
  "$NODE" --no-warnings -e 'require("node:sqlite").backup||process.exit(1)' || die "node:sqlite 缺 backup API"
}
unit_active() { [ "$(ucmd is-active "$1" 2>/dev/null || true)" = active ]; }
port_listeners() { ss -ltnH "sport = :$PORT" 2>/dev/null | wc -l | tr -d ' '; }

# 持有旧库文件句柄的进程（本用户可见范围）。冻结旧写入方后应为空。
holders() {
  local p pid out=""
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"; [ "$pid" = "$$" ] && continue
    if ls -l "$p/fd" 2>/dev/null | /usr/bin/grep -qF -- "$OLD_DB"; then
      out+="${pid}:$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | awk '{n=split($1,a,"/"); printf "%s", a[n]; if ($2!="") {m=split($2,b,"/"); printf " %s", b[m]}}')"$'\n'
    fi
  done
  printf '%s' "$out"
}

# curl 带令牌：令牌经 0600 临时 header 文件，不进 argv、不打印
auth_curl() { # auth_curl <token-file> <curl args...>   → 输出 HTTP 状态码
  local tf="$1"; shift
  local h; h="$(mktemp /tmp/memory-hub-hdr.XXXXXX)"; chmod 600 "$h"
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$tf")" > "$h"
  curl -s -m 15 -o /dev/null -w '%{http_code}' -H "@$h" "$@" || true
  rm -f "$h"
}
rpc_list() { # rpc_list <token-file> <url> → 状态码
  auth_curl "$1" -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$2"
}
is_new_healthz() { curl -s -m 5 "http://127.0.0.1:$PORT${BASE_PATH}/healthz" | /usr/bin/grep -q '"version"'; }
is_old_healthz() { local r; r="$(curl -s -m 5 "http://127.0.0.1:$PORT${BASE_PATH}/healthz" || true)"; [ -n "$r" ] && ! printf '%s' "$r" | /usr/bin/grep -q '"version"'; }

wait_for() { # wait_for <fn> <seconds>
  local i; for i in $(seq 1 $(( $2 * 5 ))); do "$1" && return 0; sleep 0.2; done; return 1
}

old_start() { if [ -n "$OLD_START_CMD" ]; then act bash -c "$OLD_START_CMD"; else act systemctl --user start "$OLD_UNIT"; fi; }

hub_start() {
  if [ "$HUB_TRANSIENT" = 1 ]; then
    act systemd-run --user --quiet --unit="${HUB_UNIT%.service}" --property=EnvironmentFile="$ENV_FILE" --working-directory="$HUB_DIR" "$NODE" "$HUB_DIR/bin/memory-hub.mjs" serve
  else
    act systemctl --user start "$HUB_UNIT"
  fi
}

# ── status / preflight ───────────────────────────────────
do_status() {
  step "状态"
  say "旧服务 $OLD_UNIT：$(ucmd is-active "$OLD_UNIT" 2>/dev/null || true) / $(ucmd is-enabled "$OLD_UNIT" 2>/dev/null || true)"
  say "新服务 $HUB_UNIT：$(ucmd is-active "$HUB_UNIT" 2>/dev/null || true) / $(ucmd is-enabled "$HUB_UNIT" 2>/dev/null || true)"
  say "端口 $PORT 监听数：$(port_listeners)"
  say "healthz：$(curl -s -m 3 "http://127.0.0.1:$PORT${BASE_PATH}/healthz" || echo 无响应)"
  [ -f "$STATE_ROOT/latest/state.env" ] && { say "最近一次切换记录："; /usr/bin/grep -v -i -E 'key|token|pass' "$STATE_ROOT/latest/state.env" | sed 's/^/    /'; }
  true
}

do_preflight() {
  step "体检（只读）"
  check_node; say "node $("$NODE" -v)，node:sqlite backup 可用"
  [ -f "$OLD_DB" ] || die "旧库不存在：$OLD_DB"
  say "旧库：$(fsz "$OLD_DB") 字节；WAL：$(fsz "$OLD_DB-wal" 2>/dev/null || echo 无)"
  [ -f "$OLD_TOKEN_FILE" ] && say "旧令牌文件存在（$(fmode "$OLD_TOKEN_FILE")），长度 $(tr -d '\r\n' < "$OLD_TOKEN_FILE" | wc -c) 字符（不打印内容）" || say "警告：旧令牌文件不存在：$OLD_TOKEN_FILE（import-hash 将无法导入）"
  [ -d "$HUB_DIR/node_modules" ] || die "$HUB_DIR 未部署（先 scripts/deploy-remote.sh）"
  say "代码版本：$(cat "$HUB_DIR/REVISION" 2>/dev/null || echo 未知)"
  say "旧 unit $OLD_UNIT：$(ucmd is-active "$OLD_UNIT" 2>/dev/null || true)"
  say "端口 $PORT 当前监听数：$(port_listeners)（切换前应由旧服务占用；切换后由新服务占用）"
  local h; h="$(holders)"
  if [ -n "$h" ]; then say "当前持有旧库句柄的进程（切换前必须清空——这些是"旧写入方"）："; printf '%s' "$h" | sed 's/^/    pid /'; else say "没有进程持有旧库句柄"; fi
  say "磁盘："; df -h "$HOME" | tail -1 | sed 's/^/    /'
  if [ "$CHECK_NGINX" = 1 ] && [ -r /etc/nginx/sites-enabled/dsh-piweb ]; then
    say "nginx /memory/ 现有反代目标（只读，不改）："; /usr/bin/grep -nE 'location \^~ /memory/|proxy_pass http://127.0.0.1:'"$PORT" /etc/nginx/sites-enabled/dsh-piweb | sed 's/^/    /'
  fi
  [ -f "$ENV_FILE" ] && say "env 文件存在：$ENV_FILE（$(fmode "$ENV_FILE")）；键：$(cut -d= -f1 "$ENV_FILE" | paste -sd, -)" || say "env 文件尚未生成（运行 prepare）"
}

# ── prepare：不影响线上 ───────────────────────────────────
do_prepare() {
  step "准备（不影响线上）"
  check_node
  act mkdir -p -m 700 "$CFG_DIR" "$DATA_DIR" "$STATE_ROOT"
  if [ ! -s "$PW_FILE" ]; then
    if [ "$EXECUTE" = 1 ]; then ( umask 077; openssl rand -base64 30 | tr -d '\n=+/' | cut -c1-24 > "$PW_FILE" ); chmod 600 "$PW_FILE"; say "已生成管理员口令文件 $PW_FILE（$(wc -c < "$PW_FILE") 字符，不打印）"
    else say "[dry-run] 将生成管理员口令文件 $PW_FILE"; fi
  else say "管理员口令文件已存在：$PW_FILE"; fi
  if [ ! -f "$ENV_FILE" ]; then
    if [ "$EXECUTE" = 1 ]; then
      [ -f "$STAGING_ENV" ] || die "找不到 $STAGING_ENV：无法拷贝蒸馏配置（可手工写入 $ENV_FILE 的 MEMORY_LLM_* 三项）"
      ( umask 077
        {
          echo "MEMORY_HUB_HOME=$DATA_DIR"
          echo "MEMORY_HUB_HOST=127.0.0.1"
          echo "MEMORY_HUB_PORT=$PORT"
          echo "MEMORY_HUB_BASE_PATH=$BASE_PATH"
          echo "MEMORY_HUB_TRUST_PROXY=1"
          echo "MEMORY_HUB_ALLOWED_HOSTS=$HOSTNAMES"
          echo "MEMORY_HUB_ALLOWED_ORIGINS=$ORIGINS"
          echo "MEMORY_HUB_LOG_LEVEL=info"
          echo "NODE_NO_WARNINGS=1"
          /usr/bin/grep -E '^MEMORY_LLM_(BASE_URL|MODEL|KEY)=' "$STAGING_ENV" || true
        } > "$ENV_FILE" )
      chmod 600 "$ENV_FILE"
      say "已生成 $ENV_FILE（0600）；键：$(cut -d= -f1 "$ENV_FILE" | paste -sd, -)；MEMORY_LLM_KEY 是从 staging.env 文件到文件拷贝的，未显示"
    else say "[dry-run] 将生成 $ENV_FILE（蒸馏三项从 $STAGING_ENV 文件到文件拷贝）"; fi
  else say "env 文件已存在，保持不动：$ENV_FILE"; fi
  if [ "$HUB_TRANSIENT" = 1 ]; then say "演练模式：用 systemd-run 临时 unit，不写 unit 文件"
  else
    local unit="$UNIT_DIR/$HUB_UNIT"
    if [ "$EXECUTE" = 1 ]; then
      mkdir -p "$UNIT_DIR"
      sed "s#@ENV_FILE@#$ENV_FILE#" "$HUB_DIR/deploy/memory-hub.service" > "$unit"
      ucmd daemon-reload; say "已写入 $unit 并 daemon-reload（未 enable、未启动）"
    else say "[dry-run] 将写入 $unit 并 daemon-reload（未 enable、未启动）"; fi
  fi
}

# ── cutover ─────────────────────────────────────────────
NEW_STARTED=0; OLD_STOPPED=0
on_fail() {
  local code=$?
  trap - ERR
  printf '\n[cutover] 失败（退出码 %s）。\n' "$code" >&2
  if [ "$OLD_STOPPED" = 1 ] && [ "$NEW_STARTED" = 0 ]; then
    printf '[cutover] 新服务尚未接收任何请求，自动恢复旧服务……\n' >&2
    if [ -n "$OLD_START_CMD" ]; then bash -c "$OLD_START_CMD" || true; else ucmd start "$OLD_UNIT" || true; fi
    [ "$OLD_ENABLEABLE" = 1 ] && ucmd enable "$OLD_UNIT" >/dev/null 2>&1 || true
    printf '[cutover] 旧服务状态：%s\n' "$(ucmd is-active "$OLD_UNIT" 2>/dev/null || true)" >&2
  elif [ "$NEW_STARTED" = 1 ]; then
    printf '[cutover] 新服务已启动：请人工判断；回滚用 `%s rollback --execute`。\n' "$0" >&2
  fi
  exit "$code"
}

do_cutover() {
  step "切换"
  check_node
  [ "$EXECUTE" = 0 ] && say "dry-run：只做只读检查，下面的"将执行"均未执行"
  [ -f "$ENV_FILE" ] || die "缺 $ENV_FILE，先运行 prepare"
  [ -s "$PW_FILE" ] || die "缺管理员口令文件 $PW_FILE，先运行 prepare"
  [ -f "$OLD_DB" ] || die "旧库不存在：$OLD_DB"
  if [ -e "$DATA_DIR/memory-eternal.db" ]; then
    [ "$REPLACE_DATA" = 1 ] || die "$DATA_DIR 已有库；确认可丢弃后加 --replace-data（会先改名保留，不删除）"
  fi
  if [ "$EXECUTE" = 1 ] && [ "$FROZEN_ACK" != 1 ]; then
    die "必须加 --frozen-ack，表示你已按手册冻结了旧写入方（停用 DSH 里的 memory-eternal 插件、摘 58 的 SessionEnd hook/stdio 条目、停 7999/8000 旧面板）"
  fi

  local TS DIR; TS="$(date -u +%Y%m%dT%H%M%SZ)"; DIR="$STATE_ROOT/$TS"
  local SNAP="$DIR/final-snapshot.db"

  step "1/9 冻结旧写入方：停止旧 MCP 服务 $OLD_UNIT"
  if [ "$EXECUTE" = 1 ]; then trap on_fail ERR; fi
  act systemctl --user stop "$OLD_UNIT"; OLD_STOPPED=1
  [ "$OLD_ENABLEABLE" = 1 ] && act systemctl --user disable "$OLD_UNIT"
  step "2/9 检查没有进程再持有旧库（旧写入方都已冻结）"
  local h; h="$(holders)"
  if [ -n "$h" ]; then
    printf '%s' "$h" | sed 's/^/    仍持有旧库的进程 pid /'
    if [ "$EXECUTE" = 1 ] && [ "$ALLOW_HOLDERS" != 1 ]; then die "还有进程持有旧库句柄；先冻结它们（手册第 1 步），或明知风险加 --allow-holders"; fi
    say "（dry-run / --allow-holders：继续）"
  else say "OK：无进程持有旧库"; fi

  step "3/9 旧库最终快照（sqlite backup API，一致性副本，原件只读打开）"
  act mkdir -p -m 700 "$DIR"
  if [ "$EXECUTE" = 1 ]; then
    OLD_DB="$OLD_DB" SNAP="$SNAP" "$NODE" --no-warnings -e '
const s=require("node:sqlite");const t0=Date.now();
const db=new s.DatabaseSync(process.env.OLD_DB,{readOnly:true});db.exec("PRAGMA busy_timeout=5000");
s.backup(db,process.env.SNAP).then(()=>{db.close();console.log("backup ok "+(Date.now()-t0)+" ms")}).catch(e=>{console.error(String(e.message||e));process.exit(1)})'
    chmod 600 "$SNAP"
    local ic; ic="$("$NODE" --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("PRAGMA integrity_check").get().integrity_check)' "$SNAP")"
    [ "$ic" = ok ] || die "快照 integrity_check 失败：$ic"
    say "快照 integrity_check=ok sha256=$(sha "$SNAP" | cut -c1-16) 大小=$(fsz "$SNAP")"
    "${CLI[@]}" migrate verify --source "$OLD_DB" --target "$SNAP" | sed 's/^/    /' || die "快照与旧库原件不一致（冻结期间旧库仍有写入？）"
  else say "[dry-run] 将对 $OLD_DB 做快照到 $SNAP，并对账 快照 vs 旧库原件"; fi

  step "4/9 导入新数据目录 $DATA_DIR"
  if [ -e "$DATA_DIR/memory-eternal.db" ] && [ "$REPLACE_DATA" = 1 ]; then act mv "$DATA_DIR" "$DATA_DIR.replaced-$TS"; act mkdir -p -m 700 "$DATA_DIR"; fi
  act mkdir -p -m 700 "$DATA_DIR"
  if [ "$EXECUTE" = 1 ]; then
    cp "$SNAP" "$DATA_DIR/memory-eternal.db"; chmod 600 "$DATA_DIR/memory-eternal.db"
    say "已拷入；校验 快照 vs 新数据目录（新代码尚未打开，应逐项相等）"
    "${CLI[@]}" migrate verify --source "$SNAP" --target "$DATA_DIR" | sed 's/^/    /' || die "导入后对账失败"
  else say "[dry-run] 将拷贝快照到 $DATA_DIR/memory-eternal.db 并对账"; fi

  step "5/9 管理员口令（从口令文件 stdin 读取）与旧共享令牌导入（只存哈希）"
  if [ "$EXECUTE" = 1 ]; then
    set -a; . "$ENV_FILE"; set +a
    "${CLI[@]}" admin set-password < "$PW_FILE" >/dev/null 2>&1 || die "set-password 失败"
    say "管理员口令已设置（文件 $PW_FILE）"
    if [ -f "$OLD_TOKEN_FILE" ]; then
      "${CLI[@]}" token import-hash --name "$LEGACY_NAME" --scope read,write --expires "$LEGACY_EXPIRES" --from-file "$OLD_TOKEN_FILE" 2>&1 | sed 's/^/    /'
    else say "警告：没有旧令牌文件，跳过导入；客户端必须换新令牌"; fi
  else say "[dry-run] 将设置管理员口令；将用 token import-hash 导入 $OLD_TOKEN_FILE 为 $LEGACY_NAME（read,write，$LEGACY_EXPIRES 过期）"; fi

  step "6/9 启动新服务 $HUB_UNIT（127.0.0.1:$PORT$BASE_PATH）"
  [ "$EXECUTE" = 1 ] && [ "$(port_listeners)" != 0 ] && die "端口 $PORT 仍被占用（旧服务没停掉？）"
  hub_start; NEW_STARTED=1
  if [ "$EXECUTE" = 1 ]; then
    wait_for is_new_healthz 20 || die "新服务 20 秒内 healthz 未就绪（journalctl --user -u $HUB_UNIT）"
    say "healthz：$(curl -s -m 5 "http://127.0.0.1:$PORT${BASE_PATH}/healthz")"
    [ "$HUB_TRANSIENT" = 1 ] || act systemctl --user enable "$HUB_UNIT"
  fi

  step "7/9 再对账（新代码已打开并升级 schema 后，快照 vs 新库，允许新库多出）"
  if [ "$EXECUTE" = 1 ]; then "${CLI[@]}" migrate verify --source "$SNAP" --target "$DATA_DIR" --allow-target-extra | sed 's/^/    /' || die "启动后对账失败"; else say "[dry-run] 将再对账一次"; fi

  step "8/9 冒烟：旧令牌直连 + 经 Host 头模拟 nginx + 经 nginx(80)"
  if [ "$EXECUTE" = 1 ]; then
    local u="http://127.0.0.1:$PORT${BASE_PATH}/mcp" c
    if [ -f "$OLD_TOKEN_FILE" ]; then
      c="$(rpc_list "$OLD_TOKEN_FILE" "$u")"; say "旧令牌 tools/list 直连：HTTP $c（期望 200）"; [ "$c" = 200 ] || die "旧令牌无法连上新服务"
      local first_host="${HOSTNAMES%%,*}"
      c="$(rpc_list "$OLD_TOKEN_FILE" "$u" -H "Host: $first_host" -H 'X-Forwarded-For: 100.64.0.1' -H 'X-Forwarded-Proto: http')"
      say "旧令牌 + Host/XFF 头（模拟 nginx）：HTTP $c（期望 200）"; [ "$c" = 200 ] || die "带 Host 头失败：检查 MEMORY_HUB_ALLOWED_HOSTS"
      if [ "$CHECK_NGINX" = 1 ]; then
        c="$(rpc_list "$OLD_TOKEN_FILE" "http://127.0.0.1/memory/mcp")"; say "经 nginx(80) 的 tools/list：HTTP $c（期望 200）"; [ "$c" = 200 ] || die "经 nginx 失败（nginx 的 /memory/ 是否仍指向 127.0.0.1:$PORT？）"
      fi
    fi
    c="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$u")"; say "无令牌：HTTP $c（期望 401）"; [ "$c" = 401 ] || die "无令牌没有被拒绝"
    c="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT${BASE_PATH}/admin/")"; say "管理界面首页：HTTP $c（期望 200）"
  else say "[dry-run] 将用旧令牌文件做 tools/list、带 Host 头、经 nginx(80)；无令牌应 401"; fi

  step "9/9 记录切换状态"
  if [ "$EXECUTE" = 1 ]; then
    ( umask 077; { echo "TS=$TS"; echo "SNAPSHOT=$SNAP"; echo "SNAPSHOT_SHA256=$(sha "$SNAP")"; echo "OLD_DB=$OLD_DB"; echo "DATA_DIR=$DATA_DIR"; echo "HUB_UNIT=$HUB_UNIT"; echo "OLD_UNIT=$OLD_UNIT"; } > "$DIR/state.env" )
    ln -sfn "$DIR" "$STATE_ROOT/latest"
    say "已记录 $DIR/state.env"
    trap - ERR
  fi
  say "切换完成（dry-run=$((1-EXECUTE))）。之后：手册第 8 节的客户端侧操作由你完成；旧服务保持停止、不卸载。"
}

# ── rollback ────────────────────────────────────────────
do_rollback() {
  step "回滚"
  check_node
  local TS; TS="$(date -u +%Y%m%dT%H%M%SZ)"
  [ -f "$OLD_DB" ] || die "旧库原件不存在：$OLD_DB（无法回滚到旧服务）"
  step "1/5 停止新服务 $HUB_UNIT"
  if unit_active "$HUB_UNIT"; then
    act systemctl --user stop "$HUB_UNIT"
    [ "$HUB_TRANSIENT" = 1 ] || act systemctl --user disable "$HUB_UNIT"
  else say "新服务本来就没在运行"; fi
  step "2/5 旧库是否还有进程持有"
  local h; h="$(holders)"; if [ -n "$h" ]; then printf '%s' "$h" | sed 's/^/    pid /'; [ "$EXECUTE" = 1 ] && [ "$ALLOW_HOLDERS" != 1 ] && die "还有进程持有旧库，先处理（或 --allow-holders）"; else say "OK"; fi
  step "3/5 新库期间的增量 → 旧库（migrate reverse；执行前自动给旧库留底）"
  if [ -e "$DATA_DIR/memory-eternal.db" ]; then
    local extra=(); [ "$PRUNE" = 1 ] && extra+=(--prune-purged)
    mkdir -p -m 700 "$STATE_ROOT"
    local delta="$STATE_ROOT/rollback-delta-$TS.json"
    if [ "$EXECUTE" = 1 ]; then
      ( umask 077; "${CLI[@]}" migrate reverse --from "$DATA_DIR" --target "$OLD_DB" --execute --export "$delta" ${extra[@]+"${extra[@]}"} ) | sed 's/^/    /'
      say "对账 新库 vs 回滚后的旧库（应逐项相等；若有永久删除的卡且未 --prune-purged，会显示差异——这是预期的保守行为）"
      "${CLI[@]}" migrate verify --source "$DATA_DIR" --target "$OLD_DB" --allow-target-extra | sed 's/^/    /' || die "回滚后对账失败：旧库未启动，新库目录原样保留，请人工检查"
    else
      "${CLI[@]}" migrate reverse --from "$DATA_DIR" --target "$OLD_DB" ${extra[@]+"${extra[@]}"} | sed 's/^/    /'
    fi
  else say "没有新数据目录，跳过"; fi
  step "4/5 启动旧服务 $OLD_UNIT"
  if [ "$EXECUTE" = 1 ] && [ "$(port_listeners)" != 0 ]; then die "端口 $PORT 仍被占用"; fi
  [ "$OLD_ENABLEABLE" = 1 ] && act systemctl --user enable "$OLD_UNIT"
  old_start
  if [ "$EXECUTE" = 1 ]; then
    wait_for is_old_healthz 20 || die "旧服务 20 秒内 healthz 未就绪"
    say "旧服务 healthz：$(curl -s -m 5 "http://127.0.0.1:$PORT${BASE_PATH}/healthz")（旧服务不带 version 字段）"
    if [ -f "$OLD_TOKEN_FILE" ]; then say "旧令牌 tools/list：HTTP $(rpc_list "$OLD_TOKEN_FILE" "http://127.0.0.1:$PORT${BASE_PATH}/mcp")（期望 200）"; fi
  fi
  step "5/5 收尾"
  if [ "$EXECUTE" = 1 ]; then
    [ -e "$DATA_DIR" ] && mv "$DATA_DIR" "$DATA_DIR.rolledback-$TS" && say "新数据目录已改名保留：$DATA_DIR.rolledback-$TS（不删除）"
  else say "[dry-run] 将把 $DATA_DIR 改名为 $DATA_DIR.rolledback-<时间>（保留不删）"; fi
  say "回滚完成。客户端配置/hook/DSH 插件的还原由你按手册第 9 节完成。"
}

case "$MODE" in
  status) do_status ;;
  preflight) do_preflight ;;
  prepare) do_prepare ;;
  cutover) do_cutover ;;
  rollback) do_rollback ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac
