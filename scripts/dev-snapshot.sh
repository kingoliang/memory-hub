#!/usr/bin/env bash
# memory-hub · 本机"用真实数据看界面"开发环境。用法见 docs/dev-with-real-data.md
#   dev-snapshot.sh snapshot | start | stop | status | verify | all | clean --yes
# 不打印口令、不输出卡片标题/正文。只读 58（backup API 一致性快照，临时文件用后即删）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${MEMORY_HUB_DEV_DIR:-$HOME/memory-hub-dev}"
DATA="$DEV/data"
PWFILE="$DEV/admin-password.txt"
PIDFILE="$DEV/server.pid"
LOGFILE="$DEV/server.log"
PORT=7992
HOST=127.0.0.1
REMOTE="${MEMORY_HUB_SNAPSHOT_REMOTE:-kingo.liang@100.120.90.58}"
REMOTE_DB='$HOME/.dsh/memory-vault/memory-eternal.db'
REMOTE_NODE_GLOB='$HOME/.local/lib/node-v*/bin/node'
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
NODE="${NODE:-$(command -v node)}"

to() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' -- "$s" "$@"; }
say() { printf '[dev-snapshot] %s\n' "$*"; }

need_node() {
  local v; v="$("$NODE" -p 'process.versions.node')"
  "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)' \
    || { echo "node $v 过低，需要 >=22.16" >&2; exit 1; }
}

prepare_dirs() { mkdir -p "$DATA"; chmod 700 "$DEV" "$DATA"; }

do_snapshot() {
  prepare_dirs
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "服务正在运行，先 stop 再换快照" >&2; exit 1; fi
  rdir=""
  cleanup_remote() { [ -n "$rdir" ] && to 30 ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -rf -- '$rdir'" >/dev/null 2>&1 && say "58 上临时快照已删除：$rdir"; return 0; }
  trap cleanup_remote EXIT
  # 1) 在 58 上用 node:sqlite backup API 取一致性快照（源库只读打开；临时目录 0700）
  rdir="$(to 60 ssh "${SSH_OPTS[@]}" "$REMOTE" "set -e; d=\$(mktemp -d); chmod 700 \$d; echo \$d")"
  [[ "$rdir" =~ ^/tmp/tmp\.[A-Za-z0-9]+$ || "$rdir" =~ ^/.+/tmp\.[A-Za-z0-9]+$ ]] || { echo "远端临时目录异常：$rdir" >&2; rdir=""; exit 1; }
  to 120 ssh "${SSH_OPTS[@]}" "$REMOTE" "set -e; N=\$(ls $REMOTE_NODE_GLOB | sort -V | tail -1); \"\$N\" -e '
const s=require(\"node:sqlite\");
const db=new s.DatabaseSync(process.env.HOME+\"/.dsh/memory-vault/memory-eternal.db\",{readOnly:true});
db.exec(\"PRAGMA busy_timeout=5000\");
s.backup(db,\"$rdir/snap.db\").then(()=>{db.close();console.log(\"backup ok\")}).catch(e=>{console.error(String(e.message||e));process.exit(1)})
'"
  # 2) scp 到本机临时名，校验后原子替换
  local tmp="$DATA/.snap.tmp.db"
  rm -f "$tmp"
  to 300 scp -q "${SSH_OPTS[@]}" "$REMOTE:$rdir/snap.db" "$tmp"
  chmod 600 "$tmp"
  local ic
  ic="$("$NODE" -e '
const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(d.prepare("PRAGMA integrity_check").get().integrity_check);d.close()' "$tmp")"
  [ "$ic" = ok ] || { rm -f "$tmp"; echo "本机 integrity_check 失败：$ic" >&2; exit 1; }
  rm -f "$DATA/memory-eternal.db-wal" "$DATA/memory-eternal.db-shm"
  mv "$tmp" "$DATA/memory-eternal.db"
  chmod 600 "$DATA/memory-eternal.db"
  say "快照完成：$DATA/memory-eternal.db  integrity_check=ok  $(date '+%F %T')"
}

ensure_password() {
  prepare_dirs
  if [ -s "$PWFILE" ]; then say "复用已有口令文件：$PWFILE"; return; fi
  ( umask 077; openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-24 > "$PWFILE" )
  chmod 600 "$PWFILE"
  [ "$(wc -c < "$PWFILE")" -ge 20 ] || { echo "口令生成失败" >&2; exit 1; }
  say "已生成口令文件：${PWFILE}（不打印内容）"
}

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

do_start() {
  need_node
  [ -f "$DATA/memory-eternal.db" ] || { echo "没有快照，先运行 snapshot" >&2; exit 1; }
  if is_running; then say "已在运行 pid=$(cat "$PIDFILE")"; return; fi
  ensure_password
  # 口令经 stdin 管道，不进 argv；set-password 每次都会设置为口令文件内容（幂等）
  MEMORY_HUB_HOME="$DATA" "$NODE" "$REPO/bin/memory-hub.mjs" admin set-password < "$PWFILE" >/dev/null 2>&1 \
    || { echo "set-password 失败" >&2; exit 1; }
  ( umask 077; : >> "$LOGFILE" ); chmod 600 "$LOGFILE"
  MEMORY_HUB_HOME="$DATA" MEMORY_HUB_HOST=$HOST MEMORY_HUB_PORT=$PORT MEMORY_HUB_ADMIN_READONLY=1 \
    nohup "$NODE" "$REPO/bin/memory-hub.mjs" serve >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"; chmod 600 "$PIDFILE"
  for _ in $(seq 1 50); do
    curl -fsS -o /dev/null --max-time 2 "http://$HOST:$PORT/healthz" 2>/dev/null && { say "已启动 pid=$(cat "$PIDFILE") http://$HOST:$PORT/admin/  口令文件：$PWFILE"; return; }
    sleep 0.2
  done
  echo "启动超时，见 $LOGFILE" >&2; exit 1
}

do_stop() {
  if [ ! -f "$PIDFILE" ]; then say "没有 pid 文件"; return; fi
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    if ps -o command= -p "$pid" | /usr/bin/grep -q 'memory-hub'; then kill "$pid"; for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; say "已停止 pid=$pid"
    else echo "pid=$pid 不是 memory-hub 进程，拒绝 kill" >&2; exit 1; fi
  else say "进程已不存在"; fi
  rm -f "$PIDFILE"
}

do_status() {
  if is_running; then say "运行中 pid=$(cat "$PIDFILE") http://$HOST:$PORT/admin/"; else say "未运行"; fi
  ls -ld "$DEV" "$DATA" 2>/dev/null || true
}

do_verify() {
  need_node
  is_running || { echo "服务未运行" >&2; exit 1; }
  "$NODE" --input-type=module - "$HOST:$PORT" "$PWFILE" "$DATA/memory-eternal.db" <<'JS'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const [hp, pwFile, dbFile] = process.argv.slice(2)
const base = `http://${hp}`
const pw = fs.readFileSync(pwFile, 'utf8').trim()
const t = async (label, method, path, body, hdr = {}) => {
  const t0 = performance.now()
  const r = await fetch(base + path, { method, headers: { ...hdr, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => null)
  const ms = Math.round(performance.now() - t0)
  console.log(`${label.padEnd(28)} HTTP ${r.status}  ${ms} ms`)
  return { r, j, ms }
}
const lr = await t('POST /login', 'POST', '/admin/api/login', { password: pw }, { origin: base })
if (lr.r.status !== 200) { console.log('登录失败'); process.exit(1) }
const cookie = lr.r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const h = { cookie }
const ov = await t('GET /overview', 'GET', '/admin/api/overview', null, h)
console.log('--- 库计数（只读打开本地快照）')
const db = new DatabaseSync(dbFile, { readOnly: true })
const kinds = db.prepare('SELECT kind, COUNT(*) n FROM cards GROUP BY kind ORDER BY n DESC').all()
const total = db.prepare('SELECT COUNT(*) n FROM cards').get().n
console.log(`cards 总数: ${total}`)
console.log('kind 分布: ' + kinds.map((k) => `${k.kind} ${k.n}`).join(', '))
console.log('quarantine: ' + db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all().map((r) => `${r.status} ${r.n}`).join(', '))
console.log('PRAGMA integrity_check: ' + db.prepare('PRAGMA integrity_check').get().integrity_check)
console.log('user_version: ' + db.prepare('PRAGMA user_version').get().user_version)
db.close()
console.log('--- API')
console.log('overview.cards(API) = ' + JSON.stringify(ov.j?.cards))
const list = await t('GET /cards?limit=20', 'GET', '/admin/api/cards?limit=20', null, h)
console.log(`cards.total(API) = ${list.j.total}, items=${list.j.items.length}`)
const q = await t('GET /cards?q=数据库', 'GET', '/admin/api/cards?q=' + encodeURIComponent('数据库') + '&limit=5', null, h)
console.log(`检索「数据库」命中 total=${q.j.total}, 返回 ${q.j.items.length} 条, 首条 score=${q.j.items[0]?.score ?? '-'}`)
const p = (q.j.items[0] || list.j.items[0]).path
const d = await t('GET /card?path=…', 'GET', '/admin/api/card?path=' + encodeURIComponent(p), null, h)
console.log(`详情: 正文字符数=${(d.j.body || '').length}, tags=${d.j.tags.length}, revisions=${d.j.revisions.length}, history=${d.j.history.length}, redacted=${d.j.redacted}`)
const tp = await t('GET /tidy/preview', 'GET', '/admin/api/tidy/preview?limit=1', null, h)
console.log('tidy 计数: ' + JSON.stringify(tp.j.counts))
const lt = await t('GET /lint', 'GET', '/admin/api/lint', null, h)
const L = lt.j
console.log('lint 顶层数值字段: ' + JSON.stringify(Object.fromEntries(Object.entries(L).filter(([, v]) => typeof v === 'number' || typeof v === 'string' && v.length < 20))))
console.log('lint invariant: ' + JSON.stringify({ ok: L.invariant?.ok, mainTotal: L.invariant?.mainTotal }))
await t('GET /facets', 'GET', '/admin/api/facets', null, h)
await t('GET /queue', 'GET', '/admin/api/queue?limit=1', null, h)
await t('GET /tags', 'GET', '/admin/api/tags?limit=1', null, h)
JS
}

do_clean() {
  [ "${1:-}" = "--yes" ] || { echo "clean 会删除整个 ${DEV}，需加 --yes" >&2; exit 1; }
  do_stop || true
  case "$DEV" in "$HOME"/memory-hub-dev*) rm -rf -- "$DEV"; say "已删除 $DEV";; *) echo "拒绝删除非预期目录：$DEV" >&2; exit 1;; esac
}

case "${1:-}" in
  snapshot) do_snapshot ;;
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  verify) do_verify ;;
  all) do_snapshot; do_start; do_verify ;;
  clean) shift; do_clean "${1:-}" ;;
  *) echo "用法：$0 snapshot|start|stop|status|verify|all|clean --yes" >&2; exit 2 ;;
esac
