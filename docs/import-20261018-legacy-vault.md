# 旧库一次性对账导入（2026-10-18）

把旧的单机 vault 导入新的团队服务 home，并按 `migrate.js` 的对账程序验证"一行没丢、一行没改"。

## 结论

`migrate verify` 全项 PASS。旧库文件**全程只读**（只做文件级复制，从未被打开写入）。

## 输入 / 输出

| | 路径 |
| --- | --- |
| 源（只读） | `~/.dsh/memory-vault/memory-eternal.db`（+ `-wal` 4.0MB，**必须一起复制**，否则丢未 checkpoint 的内容） |
| 源备份 | `~/.memory-hub/import-backup-20261018-204215/`（含 `-wal` `-shm`） |
| 目标 | `~/.memory-hub/memory-eternal.db`（新服务默认 home） |

## 迁移动作

打开目标库即触发 `getDb` → schema v0 → v3，并且两件事一次做完：

1. `migrateToQuarantine`：`cards` 里非 approved 的行搬进 `quarantine`（旧库是一张表 + status 列）。
2. v3：加 `owner` / `team` / `visibility` 三列，并把 `owner` 由 `submitted_by` 回填。

## 对账证据（原样输出）

```text
[PASS] integrity     source=ok target=ok
[PASS] counts        cards 206→206；quarantine pending=2 → pending=2
[PASS] kinds         content=51,knowledge=24,mistake=12,project=107,prompt=2,tool=10 → 同上
[PASS] fingerprints  指纹 sha256(path|kind|title|tags|body|status)：源 208，目标 208；源有目标无 0，目标多出 0
[PASS] sequence      seq 415→415；目标 MAX(id)=415
[PASS] invariant     主库非 approved 0；path 同时在两张表 0
[PASS] sidetables    card_updates 0→0；feedback 0→0；audit_log 206→206
RESULT: PASS
```

（用 `--allow-target-extra`：源是一张表装全部状态，目标已物理拆成主库 + 隔离区，所以"cards 数量相等"这一条在拆表后必须放宽为"总数只多不少"，其余仍逐项严格。）

回填结果：`有 owner 206 / 无 owner 0`，`team=default 206`，`visibility=team 206`。

## 已知副作用（要人处理）

旧库没有"人"的概念，`submitted_by` 里存的是 **agent 名**（本例为 `deepseek-harness`），所以回填出来的
`owner` 也是 agent 名。导入后 206 张卡都挂在 `owner=deepseek-harness` 下。

→ 用管理界面/接口把 `owner` 改回真人名字即可：

```bash
curl -X PATCH .../admin/api/card -d '{"path":"03-Knowledge/x.md","expectedUpdatedAt":"...","owner":"kingo","team":"remittance"}'
```

`PATCH /card` 已支持改 `owner`/`team`/`visibility`（也可清空成空串，回到"无主"老卡语义）。

## 回滚

删掉 `~/.memory-hub/memory-eternal.db*` 即可；源库与备份都没被动过。
