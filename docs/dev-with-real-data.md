# 本机用真实数据看管理界面

目的：在本机浏览器里查看自己真实的记忆（58 线上库的一致性快照），不改 58 上任何东西。
脚本：`scripts/dev-snapshot.sh`（需要本机 Node >= 22.16、`ssh`/`scp` 免密到 `kingo.liang@100.120.90.58`、`openssl`）。

## 用法

```
scripts/dev-snapshot.sh snapshot   # 取快照并覆盖本机副本（服务运行中会拒绝）
scripts/dev-snapshot.sh start      # 起服务 127.0.0.1:7992（首次生成口令，之后复用）
scripts/dev-snapshot.sh verify     # 登录后只做 GET，打印计数/耗时（不含标题与正文）
scripts/dev-snapshot.sh status | stop
scripts/dev-snapshot.sh all        # snapshot + start + verify
scripts/dev-snapshot.sh clean --yes   # 停服务并删除整个 ~/memory-hub-dev
```

浏览器打开 `http://127.0.0.1:7992/admin/`，口令在 `~/memory-hub-dev/admin-password.txt`（脚本不打印它：`pbcopy < ~/memory-hub-dev/admin-password.txt` 复制即可）。

## 快照怎么取

在 58 上用 `node:sqlite` 的 backup API（源库 `readOnly` 打开）把 `~/.dsh/memory-vault/memory-eternal.db` 备份到 `mktemp -d` 的 0700 临时目录，scp 回本机后，脚本通过 trap 删除 58 上的临时目录。58 的 node 不在非交互 PATH，脚本自行探测 `~/.local/lib/node-v*/bin/node`。绝不裸拷 WAL 库。本机收到后先做 `integrity_check`，通过才替换。ssh/scp 均有超时。

快照是**时点数据**：之后线上的新卡不会出现，想更新就 `stop` → `snapshot` → `start`。

## 目录与权限（不在仓库内）

```
~/memory-hub-dev/            0700
  admin-password.txt         0600  随机 24 字符，口令只经 stdin 管道交给 set-password，不进命令行/日志
  server.pid                 0600
  server.log                 0600  服务日志，不含口令/令牌/密钥（实测零命中）
  data/                      0700
    memory-eternal.db        0600  快照（服务运行后会出现 -wal/-shm 旁路文件，属正常）
```

## 数据隔离原则

- 真实数据只在本机 `~/memory-hub-dev`，不进仓库、不进提交、不进截图、不进测试夹具。
- 仓库测试与 M3 的浏览器截图一律用合成数据。
- `verify` 只输出计数、类型分布和耗时，不输出卡片标题/正文。

## 重要警示

- **M3 的写功能（编辑、删除、批准、标签合并、整理 apply、令牌管理、改口令）只在测试脚本对临时副本上跑**——你要看的是原样的真实数据。为防误点，`start` 会带 `MEMORY_HUB_ADMIN_READONLY=1`：服务端对所有写接口（登出除外）直接返回 403 `read_only`，界面左下角标记显示"只读模式"。按钮仍会显示，但点了只会收到一条"只读模式，写操作已被禁用"的提示，不会改任何数据。
- **想在真实数据上试写功能？** 不要关只读；请自己 `cp -R` 一份副本到别的目录，用另一个端口和 `MEMORY_HUB_HOME` 单独起服务（不带 `MEMORY_HUB_ADMIN_READONLY`）。
- **登录不是零写入**：登录/登出会往库里写 `admin_sessions` 和 `write_log`（M2 既有行为）；服务启动还会做 schema 迁移（`user_version` 0→1→2：只增表 / 重建 `agent_tokens` 以允许已撤销令牌名复用，数据原样保留；快照里令牌表本来就是空的）。除此之外脚本和 `verify` 不写任何业务数据。
- 服务监听 127.0.0.1，未对外开放。

## 停止与清理

```
scripts/dev-snapshot.sh stop        # 读 server.pid，确认命令行含 memory-hub 再 kill，删 pid
# 手动：kill "$(cat ~/memory-hub-dev/server.pid)" && rm ~/memory-hub-dev/server.pid
scripts/dev-snapshot.sh clean --yes # 停服务并删目录；等价于 rm -rf ~/memory-hub-dev
```
