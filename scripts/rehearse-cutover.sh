#!/usr/bin/env bash
# memory-hub · 在 58 上"不碰线上"地演练 切换 → 新库产生增量 → 回滚 → 重新切换（需要 systemd --user，在 58 本机运行）。
#   rehearse-cutover.sh run      搭演练场并完整走一遍；结尾 REHEARSAL PASS/FAIL（失败时保留现场便于排查）
#   rehearse-cutover.sh clean    停掉演练用的临时 unit 并删除演练目录
#
# 演练场（全部在 $REHEARSAL_DIR，默认 ~/memory-hub-data/rehearsal；端口 $REHEARSAL_PORT，默认 7993）：
#   - 旧库 = 对线上旧库 sqlite backup API 取的新快照（线上旧库只读打开，原件不动）；
#   - 旧服务替身 = 线上旧 server.mjs 的"拷贝"（只读复制文件，不改线上目录）+ 指向演练旧库副本 + 演练专用随机令牌，
#     用 systemd-run 临时 unit 运行，因此旧服务的真实代码也被演练到（回滚后能否读到新增卡）；
#   - 新服务 = 本仓库，临时 unit（systemd-run），数据目录在演练目录。
# 切换/回滚用的就是 scripts/cutover.sh 本身（通过 CUT_* 环境变量改指向演练场）。不碰线上 unit、端口 7990、nginx、DSH、客户端。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export NODE_NO_WARNINGS=1
MODE="${1:-}"
R="${REHEARSAL_DIR:-$HOME/memory-hub-data/rehearsal}"
PORT="${REHEARSAL_PORT:-7993}"
HUB="${HUB_DIR:-$HOME/memory-hub}"
OLD_DB_SRC="${OLD_DB_SRC:-$HOME/.dsh/memory-vault/memory-eternal.db}"
OLD_SERVER_SRC="${OLD_SERVER_SRC:-$HOME/.dsh/memory-mcp-http/server.mjs}"
OLD_NODE_MODULES="${OLD_NODE_MODULES:-$HOME/.dsh/profiles/web/node_modules}"
STAGING_ENV="${STAGING_ENV:-$HOME/.config/memory-hub/staging.env}"
OLD_UNIT=memory-hub-rehearsal-old
HUB_UNIT=memory-hub-rehearsal
NODE="$(command -v node)"
FAILS=0

say() { printf '\n[rehearsal] %s\n' "$*"; }
ok()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then printf '  PASS  %s\n' "$d"; else printf '  FAIL  %s\n' "$d"; FAILS=$((FAILS+1)); fi; }
stop_units() { for u in "$HUB_UNIT" "$OLD_UNIT"; do systemctl --user stop "$u.service" >/dev/null 2>&1 || true; systemctl --user reset-failed "$u.service" >/dev/null 2>&1 || true; done; }

do_clean() {
  stop_units
  case "$R" in "$HOME"/memory-hub-data/*) rm -rf -- "$R"; echo "[rehearsal] 已清理 $R";; *) echo "拒绝删除非预期目录：$R" >&2; exit 1;; esac
}

# 演练专用：用旧服务替身的令牌调 recall，返回响应文本里是否含某个标记
old_recall_has() { # <marker>
  local h; h="$(mktemp /tmp/memory-hub-hdr.XXXXXX)"; chmod 600 "$h"
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$R/old-token")" > "$h"
  local out; out="$(curl -s -m 15 -H "@$h" -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_recall\",\"arguments\":{\"query\":\"$1\",\"limit\":5}}}" "http://127.0.0.1:$PORT/memory/mcp")"
  rm -f "$h"
  printf '%s' "$out" | /usr/bin/grep -qF -- "$1"
}

do_run() {
  [ -d "$HUB/node_modules" ] || { echo "$HUB 未部署" >&2; exit 1; }
  [ "$(ss -ltnH "sport = :$PORT" | wc -l | tr -d ' ')" = 0 ] || { echo "演练端口 $PORT 已被占用" >&2; exit 1; }
  [ ! -e "$R" ] || { echo "演练目录已存在：$R（先 clean）" >&2; exit 1; }
  say "搭演练场 $R（端口 $PORT）"
  mkdir -p -m 700 "$R" "$R/old-vault" "$R/old" "$R/cfg" "$R/cutover"
  OLD_DB_SRC="$OLD_DB_SRC" DST="$R/old-vault/memory-eternal.db" "$NODE" -e '
const s=require("node:sqlite");const db=new s.DatabaseSync(process.env.OLD_DB_SRC,{readOnly:true});db.exec("PRAGMA busy_timeout=5000");
s.backup(db,process.env.DST).then(()=>{db.close();console.log("  旧库副本已用 backup API 取得")}).catch(e=>{console.error(String(e.message||e));process.exit(1)})'
  chmod 600 "$R/old-vault/memory-eternal.db"
  cp "$OLD_SERVER_SRC" "$R/old/server.mjs"; ln -s "$OLD_NODE_MODULES" "$R/old/node_modules"
  ( umask 077; openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48 > "$R/old-token" ); chmod 600 "$R/old-token"
  cat > "$R/old-ctl.sh" <<EOF
#!/usr/bin/env bash
export PATH="$HOME/.local/bin:\$PATH"
systemd-run --user --quiet --unit=$OLD_UNIT --working-directory=$R/old \\
  -E MEMORY_MCP_HOST=127.0.0.1 -E MEMORY_MCP_PORT=$PORT -E MEMORY_MCP_BASE=/memory -E MEMORY_MCP_TOKEN_FILE=$R/old-token \\
  -E MEMORY_VAULT_DIR=$R/old-vault -E NODE_NO_WARNINGS=1 $NODE $R/old/server.mjs
for i in \$(seq 1 50); do curl -s -m 2 http://127.0.0.1:$PORT/memory/healthz >/dev/null 2>&1 && exit 0; sleep 0.2; done
echo "旧服务替身未就绪" >&2; exit 1
EOF
  chmod 700 "$R/old-ctl.sh"
  bash "$R/old-ctl.sh"
  say "旧服务替身已起（线上旧代码 + 演练库副本 + 随机令牌）：$(curl -s -m 5 http://127.0.0.1:$PORT/memory/healthz)"

  export CUT_OLD_UNIT="$OLD_UNIT.service" CUT_OLD_DB="$R/old-vault/memory-eternal.db" CUT_OLD_TOKEN_FILE="$R/old-token"
  export CUT_OLD_START_CMD="bash $R/old-ctl.sh" CUT_OLD_ENABLEABLE=0
  export CUT_HUB_UNIT="$HUB_UNIT.service" CUT_HUB_TRANSIENT=1 CUT_HUB_DIR="$HUB"
  export CUT_DATA_DIR="$R/data" CUT_STATE_DIR="$R/cutover" CUT_CFG_DIR="$R/cfg" CUT_STAGING_ENV="$STAGING_ENV"
  export CUT_PORT="$PORT" CUT_BASE_PATH=/memory CUT_CHECK_NGINX=0
  C="bash $HUB/scripts/cutover.sh"

  say "1) preflight + prepare"
  $C preflight | sed 's/^/    /'
  $C prepare --execute | sed 's/^/    /'

  say "2) 切换 dry-run（零副作用）"
  $C cutover --frozen-ack | tail -n 12 | sed 's/^/    /'
  ok "dry-run 后旧服务 healthz 正常" curl -sf -m 5 "http://127.0.0.1:$PORT/memory/healthz"

  say "3) 切换 --execute"
  $C cutover --execute --frozen-ack 2>&1 | sed 's/^/    /'
  ok "切换后 healthz 带 version（是新服务）" bash -c "curl -s -m 5 http://127.0.0.1:$PORT/memory/healthz | /usr/bin/grep -q '\"version\"'"

  say "4) 新服务期间产生增量：用旧令牌 capture、批准一张待审卡、软删一张、追加更新、新增一张已批准卡"
  OLD_TOKEN="$R/old-token" PORT="$PORT" DATA="$R/data" HUB="$HUB" "$NODE" --input-type=module -e '
import fs from "node:fs"
const tok = fs.readFileSync(process.env.OLD_TOKEN, "utf8").trim()
const url = `http://127.0.0.1:${process.env.PORT}/memory/mcp`
const text = `# 演练合成条目\n\n背景：切换演练产生的合成文本（标记 ZZSYN-rehearsal-${Date.now()}），不对应真实事项。结论：回放演练新增卡用于验证回滚不丢卡，原因是需要证明反向增量可靠。步骤：先写入，再回滚，再重新导入。`
const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + tok }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_capture", arguments: { text } } }) })
console.log("    capture HTTP", r.status)
const v = await import(process.env.HUB + "/src/core/vault.js"); const d = await import(process.env.HUB + "/src/core/db.js")
const db = d.getDb(process.env.DATA)
const pend = db.prepare("SELECT path FROM quarantine WHERE status = ? AND body NOT LIKE ? ORDER BY id LIMIT 1").get("pending", "%ZZSYN-%")
if (pend) { await v.setCardStatus(process.env.DATA, pend.path, "approved", { changedBy: "rehearsal", reason: "演练批准" }); console.log("    已批准 1 张原待审卡") }
const app = db.prepare("SELECT path FROM cards WHERE body NOT LIKE ? ORDER BY id DESC LIMIT 1").get("%ZZSYN-%")
if (app) { await v.appendUpdate(process.env.DATA, app.path, "演练追加的更新记录"); await v.deleteCard(process.env.DATA, app.path); console.log("    已对 1 张已批准卡追加更新并软删") }
await v.writeCard(process.env.DATA, { kind: "project", title: "回放演练新增卡", body: "回放演练新增卡的正文：ZZSYN-rehearsal-approved，用于验证回滚后旧服务能读到新库期间新增的已批准卡。", status: "approved", submittedBy: "rehearsal" }, { dedup: false })
d.closeAllDb()'
  cp -r "$R/data" "$R/data.before-rollback"   # 留一份"回滚前的新库"，供最后对账"没丢卡"

  say "5) 回滚 dry-run，再 --execute"
  $C rollback 2>&1 | tail -n 14 | sed 's/^/    /'
  $C rollback --execute 2>&1 | sed 's/^/    /'
  ok "回滚后旧服务 healthz 不带 version（是旧服务）" bash -c "! curl -s -m 5 http://127.0.0.1:$PORT/memory/healthz | /usr/bin/grep -q '\"version\"'"
  ok "旧服务（线上旧代码）能 recall 到新库期间新增的已批准卡" old_recall_has "回放演练新增卡"
  ok "旧库仍是旧 schema（user_version=0，无新表）" "$NODE" -e '
const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});
const t=d.prepare("select count(*) n from sqlite_master where name in (\"agent_tokens\",\"write_log\",\"card_revisions\",\"admin_sessions\")").get().n;
process.exit(d.prepare("PRAGMA user_version").get().user_version===0&&t===0?0:1)' "$R/old-vault/memory-eternal.db"
  ok "旧库对账：回滚前的新库 ⊆ 回滚后的旧库（verify --allow-target-extra）" "$NODE" "$HUB/bin/memory-hub.mjs" migrate verify --source "$R/data.before-rollback" --target "$R/old-vault/memory-eternal.db" --allow-target-extra
  ls "$R/old-vault" | /usr/bin/grep -c 'pre-reverse-' | sed 's/^/    pre-reverse 留底文件数：/'

  say "6) 旧库回滚后重新切换（重新导入）：卡一张不少"
  $C cutover --execute --frozen-ack 2>&1 | tail -n 22 | sed 's/^/    /'
  ok "重新切换后：回滚前的新库 ⊆ 新的新库（没有丢卡）" "$NODE" "$HUB/bin/memory-hub.mjs" migrate verify --source "$R/data.before-rollback" --target "$R/data" --allow-target-extra
  ok "重新切换后新服务 healthz 带 version" bash -c "curl -s -m 5 http://127.0.0.1:$PORT/memory/healthz | /usr/bin/grep -q '\"version\"'"

  say "结果"
  stop_units
  if [ "$FAILS" = 0 ]; then echo "REHEARSAL PASS"; do_clean; else echo "REHEARSAL FAIL（$FAILS 项）；现场保留在 $R，排查后 rehearse-cutover.sh clean"; exit 1; fi
}

case "$MODE" in
  run) do_run ;;
  clean) do_clean ;;
  *) sed -n '2,5p' "$0" >&2; exit 2 ;;
esac
